import {
  ActionValueConfigSchema,
  DEFAULT_GOVERNANCE_VALUES,
  ExportControlsSchema,
  FeatureFlagsSchema,
  GOVERNANCE_SECTIONS,
  GovernanceSectionSchema,
  GovernanceSettingsSchema,
  ModelConfigSchema,
  QualityConfigSchema,
  RedactionConfigSchema,
  RetentionConfigSchema,
  RoleSchema,
  TenantSchema,
  UserSchema,
  type GovernanceSection,
  type GovernanceSettings,
  type Role,
  type Tenant,
  type User,
} from '@caseguard/schemas';
import { z } from 'zod';
import { GOVERNANCE_SETTINGS, USERS } from './table-specs';
import {
  assertVersion,
  insertRows,
  loadVersioned,
  nowIso,
  parseStored,
  requireFound,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { GovernanceRepository, SqlExecutor } from './types';
import { ConflictError } from '../../errors';

/** One validator per governance section; the section value is what operators edit. */
const SECTION_SCHEMAS: Record<GovernanceSection, z.ZodType> = {
  model: ModelConfigSchema,
  quality: QualityConfigSchema,
  action_value: ActionValueConfigSchema,
  retention: RetentionConfigSchema,
  redaction: RedactionConfigSchema,
  feature_flags: FeatureFlagsSchema,
  export_controls: ExportControlsSchema,
};

const UpdateInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  changeNote: z.string().trim().min(5).max(500),
  by: z.string().min(1).max(120),
});

interface StoredSetting {
  section: string;
  value: unknown;
  version: number;
  updated_at: string;
  updated_by: string;
  change_note: string;
}

const MAX_USERS = 500;

export class GovernanceRepositoryImpl implements GovernanceRepository {
  constructor(private readonly ctx: RepoContext) {}

  async getTenant(): Promise<Tenant> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>('SELECT data FROM tenants WHERE id = $1', [
        this.ctx.scope.tenantId,
      ]);
      const row = requireFound(result.rows[0], 'Tenant', this.ctx.scope.tenantId);
      return parseStored(TenantSchema, row.data, 'tenant');
    });
  }

  private async readSettings(tx: SqlExecutor): Promise<Map<string, StoredSetting>> {
    const result = await tx.query<StoredSetting>(
      `SELECT section, value, version, updated_at, updated_by, change_note
         FROM governance_settings WHERE tenant_id = $1`,
      [this.ctx.scope.tenantId],
    );
    return new Map(result.rows.map((row) => [row.section, row]));
  }

  /** Inserts the default value for every section that has no row yet (never touches existing rows). */
  private async ensureDefaults(tx: SqlExecutor): Promise<Map<string, StoredSetting>> {
    let rows = await this.readSettings(tx);
    const missing = GOVERNANCE_SECTIONS.filter((section) => !rows.has(section));
    if (missing.length === 0) return rows;
    await insertRows(
      tx,
      GOVERNANCE_SETTINGS,
      missing.map((section) => ({
        tenantId: this.ctx.scope.tenantId,
        section,
        value: DEFAULT_GOVERNANCE_VALUES[section],
        version: 1,
        updatedAt: nowIso(this.ctx),
        updatedBy: this.ctx.scope.actorId,
        changeNote: 'Default configuration',
      })),
      'ignore',
    );
    rows = await this.readSettings(tx);
    return rows;
  }

  private assemble(rows: Map<string, StoredSetting>): GovernanceSettings {
    const entries = GOVERNANCE_SECTIONS.map((section) => {
      const row = rows.get(section);
      return [
        section,
        row && {
          value: row.value,
          version: row.version,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
          changeNote: row.change_note,
        },
      ] as const;
    });
    return parseStored(
      GovernanceSettingsSchema,
      Object.fromEntries(entries),
      'governance settings',
    );
  }

  async getSettings(): Promise<GovernanceSettings> {
    return this.ctx.run(async (tx) => this.assemble(await this.ensureDefaults(tx)));
  }

  async updateSection(
    section: GovernanceSection,
    value: unknown,
    input: { expectedVersion: number; changeNote: string; by: string },
  ): Promise<GovernanceSettings> {
    const update = validateInput(UpdateInputSchema, input, 'governance update');
    const sectionName = validateInput(GovernanceSectionSchema, section, 'section');
    const validValue = validateInput(
      SECTION_SCHEMAS[sectionName],
      value,
      `${sectionName} settings`,
    );
    return this.ctx.run(async (tx) => {
      await this.ensureDefaults(tx);
      const locked = await tx.query<{ version: number }>(
        `SELECT version FROM governance_settings
          WHERE tenant_id = $1 AND section = $2 FOR UPDATE`,
        [this.ctx.scope.tenantId, sectionName],
      );
      const current = requireFound(locked.rows[0], 'Governance section', sectionName);
      assertVersion(`Governance section ${sectionName}`, update.expectedVersion, current.version);
      const changed = await updateRow(
        tx,
        GOVERNANCE_SETTINGS,
        {
          tenantId: this.ctx.scope.tenantId,
          section: sectionName,
          value: validValue,
          version: current.version + 1,
          updatedAt: nowIso(this.ctx),
          updatedBy: update.by,
          changeNote: update.changeNote,
        },
        { expectedVersion: current.version },
      );
      if (changed !== 1)
        throw new ConflictError('The setting was modified concurrently; reload and retry');
      return this.assemble(await this.readSettings(tx));
    });
  }

  async listUsers(): Promise<User[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM users WHERE tenant_id = $1 ORDER BY display_name, id LIMIT ${MAX_USERS}`,
        [this.ctx.scope.tenantId],
      );
      return result.rows.map((row) => parseStored(UserSchema, row.data, 'user'));
    });
  }

  async getUser(userId: string): Promise<User | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM users WHERE tenant_id = $1 AND id = $2',
        [this.ctx.scope.tenantId, userId],
      );
      const row = result.rows[0];
      return row ? parseStored(UserSchema, row.data, 'user') : null;
    });
  }

  async updateUserRoles(userId: string, roles: Role[], expectedVersion: number): Promise<User> {
    const validRoles = validateInput(z.array(RoleSchema).min(1).max(5), roles, 'roles');
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'users',
        key: { tenant_id: this.ctx.scope.tenantId, id: userId },
        schema: UserSchema,
        what: 'User',
        id: userId,
      });
      assertVersion('User', expectedVersion, version);
      const next = validateInput(
        UserSchema,
        {
          ...entity,
          roles: [...new Set(validRoles)],
          updatedAt: nowIso(this.ctx),
          version: version + 1,
        },
        'user',
      );
      const changed = await updateRow(
        tx,
        USERS,
        { user: next, createdBy: this.ctx.scope.actorId },
        { columns: ['roles', 'updated_at', 'version', 'data'], expectedVersion: version },
      );
      if (changed !== 1)
        throw new ConflictError('The user was modified concurrently; reload and retry');
      return next;
    });
  }
}
