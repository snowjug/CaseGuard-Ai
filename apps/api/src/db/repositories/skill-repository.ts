import {
  SkillApprovalSchema,
  SkillDnaSchema,
  SkillLifecycleSchema,
  SkillMatchSchema,
  SkillValidationSchema,
  SkillVersionSchema,
  SkillVersionStateSchema,
  type Page,
  type SkillApproval,
  type SkillDna,
  type SkillMatch,
  type SkillValidation,
  type SkillVersion,
  type SkillVersionState,
} from '@caseguard/schemas';
import { ConflictError, NotFoundError, ValidationFailedError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import {
  SKILLS,
  SKILL_APPROVALS,
  SKILL_MATCHES,
  SKILL_VALIDATIONS,
  SKILL_VERSIONS,
} from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  assertVersion,
  insertRows,
  loadVersioned,
  nowIso,
  parseStored,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { SkillListQuery, SkillRepository, SqlExecutor } from './types';

/** Skills in these lifecycle stages may be suggested for new cases. */
const MATCHABLE_LIFECYCLES = ['pilot', 'validated', 'published'] as const;
const MAX_CHILD_ROWS = 500;
const MAX_MATCH_ROWS = 1_000;

/** Fields a patch must never change, even if a caller sneaks them into an untyped object. */
const IMMUTABLE_SKILL_FIELDS = ['id', 'tenantId', 'createdAt', 'createdBy', 'version'] as const;

export class SkillRepositoryImpl implements SkillRepository {
  constructor(private readonly ctx: RepoContext) {}

  private async requireSkill(tx: SqlExecutor, skillId: string): Promise<void> {
    const result = await tx.query(
      'SELECT 1 AS present FROM skills WHERE tenant_id = $1 AND id = $2',
      [this.ctx.scope.tenantId, skillId],
    );
    if (result.rows.length === 0) throw new NotFoundError('Skill', skillId);
  }

  async create(input: { skill: SkillDna; version: SkillVersion }): Promise<void> {
    const skill = validateInput(SkillDnaSchema, input.skill, 'skill');
    const version = validateInput(SkillVersionSchema, input.version, 'skill version');
    assertTenant(this.ctx, skill.tenantId);
    assertTenant(this.ctx, version.tenantId);
    if (version.skillId !== skill.id) {
      throw new ValidationFailedError('Invalid skill', [
        { path: 'version.skillId', message: 'The version belongs to another skill' },
      ]);
    }
    if (skill.currentVersionId !== version.id || skill.currentVersion !== version.version) {
      throw new ValidationFailedError('Invalid skill', [
        { path: 'skill.currentVersionId', message: 'The skill must point at its initial version' },
      ]);
    }
    await this.ctx.run(async (tx) => {
      await insertRows(tx, SKILLS, [skill]);
      await insertRows(tx, SKILL_VERSIONS, [version]);
    });
  }

  async list(query: SkillListQuery): Promise<Page<SkillDna>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('skills', query.cursor, ['timestamp', 'text']);
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.lifecycle) {
      q.where(
        `lifecycle = ${q.bind(validateInput(SkillLifecycleSchema, query.lifecycle, 'lifecycle'))}`,
      );
    }
    const needle = query.q?.trim();
    if (needle) {
      const p = q.bind(needle);
      q.where(
        `(strpos(lower(name), lower(${p}::text)) > 0 OR strpos(lower(key), lower(${p}::text)) > 0
          OR strpos(lower(workload), lower(${p}::text)) > 0 OR strpos(lower(product), lower(${p}::text)) > 0
          OR strpos(lower(data->>'description'), lower(${p}::text)) > 0)`,
      );
    }
    if (cursor) {
      q.where(`(updated_at, id) < (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, updated_at AS sort_ts, id FROM skills WHERE ${q.clause}
          ORDER BY updated_at DESC, id DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(SkillDnaSchema, row.data, 'skill'),
      (row) => encodeCursor('skills', [row.sort_ts, row.id]),
    );
  }

  async get(skillId: string): Promise<SkillDna | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM skills WHERE tenant_id = $1 AND id = $2',
        [this.ctx.scope.tenantId, skillId],
      );
      const row = result.rows[0];
      return row ? parseStored(SkillDnaSchema, row.data, 'skill') : null;
    });
  }

  async getVersion(skillId: string, versionId: string): Promise<SkillVersion | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2 AND id = $3',
        [this.ctx.scope.tenantId, skillId, versionId],
      );
      const row = result.rows[0];
      return row ? parseStored(SkillVersionSchema, row.data, 'skill version') : null;
    });
  }

  async listVersions(skillId: string): Promise<SkillVersion[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY sequence LIMIT ${MAX_CHILD_ROWS}`,
        [this.ctx.scope.tenantId, skillId],
      );
      return result.rows.map((row) => parseStored(SkillVersionSchema, row.data, 'skill version'));
    });
  }

  async addVersion(version: SkillVersion): Promise<void> {
    const valid = validateInput(SkillVersionSchema, version, 'skill version');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run(async (tx) => {
      await this.requireSkill(tx, valid.skillId);
      await insertRows(tx, SKILL_VERSIONS, [valid]);
    });
  }

  async setVersionState(
    skillId: string,
    versionId: string,
    state: SkillVersionState,
  ): Promise<void> {
    const nextState = validateInput(SkillVersionStateSchema, state, 'skill version state');
    await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2 AND id = $3 FOR UPDATE`,
        [this.ctx.scope.tenantId, skillId, versionId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('Skill version', versionId);
      const current = parseStored(SkillVersionSchema, row.data, 'skill version');
      const next = SkillVersionSchema.parse({
        ...current,
        state: nextState,
        updatedAt: nowIso(this.ctx),
      });
      await updateRow(tx, SKILL_VERSIONS, next, { columns: ['state', 'updated_at', 'data'] });
    });
  }

  async update(
    skillId: string,
    patch: Partial<Omit<SkillDna, 'id' | 'tenantId' | 'createdAt' | 'version'>>,
    expectedVersion: number,
  ): Promise<SkillDna> {
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'skills',
        key: { tenant_id: this.ctx.scope.tenantId, id: skillId },
        schema: SkillDnaSchema,
        what: 'Skill',
        id: skillId,
      });
      assertVersion('Skill', expectedVersion, version);
      const allowed: Record<string, unknown> = { ...patch };
      for (const field of IMMUTABLE_SKILL_FIELDS) delete allowed[field];
      const next = validateInput(
        SkillDnaSchema,
        { ...entity, ...allowed, updatedAt: nowIso(this.ctx), version: version + 1 },
        'skill',
      );
      if (
        next.currentVersionId !== entity.currentVersionId ||
        next.currentVersion !== entity.currentVersion
      ) {
        const target = await tx.query<DataRow>(
          'SELECT data FROM skill_versions WHERE tenant_id = $1 AND skill_id = $2 AND id = $3',
          [this.ctx.scope.tenantId, skillId, next.currentVersionId],
        );
        const row = target.rows[0];
        const targetVersion = row
          ? parseStored(SkillVersionSchema, row.data, 'skill version')
          : null;
        if (!targetVersion || targetVersion.version !== next.currentVersion) {
          throw new ValidationFailedError('Invalid skill update', [
            {
              path: 'currentVersionId',
              message: 'The current version must be an existing version of this skill',
            },
          ]);
        }
      }
      const changed = await updateRow(tx, SKILLS, next, { expectedVersion: version });
      if (changed !== 1)
        throw new ConflictError('The skill was modified concurrently; reload and retry');
      return next;
    });
  }

  async addValidation(validation: SkillValidation): Promise<void> {
    const valid = validateInput(SkillValidationSchema, validation, 'skill validation');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run((tx) => insertRows(tx, SKILL_VALIDATIONS, [valid]));
  }

  async listValidations(skillId: string): Promise<SkillValidation[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_validations WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY executed_at DESC, id DESC LIMIT ${MAX_CHILD_ROWS}`,
        [this.ctx.scope.tenantId, skillId],
      );
      return result.rows.map((row) =>
        parseStored(SkillValidationSchema, row.data, 'skill validation'),
      );
    });
  }

  async addApproval(approval: SkillApproval): Promise<void> {
    const valid = validateInput(SkillApprovalSchema, approval, 'skill approval');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run((tx) => insertRows(tx, SKILL_APPROVALS, [valid]));
  }

  async listApprovals(skillId: string): Promise<SkillApproval[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_approvals WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY decided_at DESC, id DESC LIMIT ${MAX_CHILD_ROWS}`,
        [this.ctx.scope.tenantId, skillId],
      );
      return result.rows.map((row) => parseStored(SkillApprovalSchema, row.data, 'skill approval'));
    });
  }

  async upsertMatch(match: SkillMatch): Promise<void> {
    const valid = validateInput(SkillMatchSchema, match, 'skill match');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run(async (tx) => {
      // Keep the position the analysis snapshot gave an existing match; new ones go last.
      const existing = await tx.query<{ ordinal: number }>(
        'SELECT ordinal FROM skill_matches WHERE tenant_id = $1 AND case_id = $2 AND id = $3',
        [valid.tenantId, valid.caseId, valid.id],
      );
      let ordinal = existing.rows[0]?.ordinal;
      if (ordinal === undefined) {
        const next = await tx.query<{ n: number }>(
          'SELECT (coalesce(max(ordinal), -1) + 1)::int AS n FROM skill_matches WHERE tenant_id = $1 AND case_id = $2',
          [valid.tenantId, valid.caseId],
        );
        ordinal = next.rows[0]?.n ?? 0;
      }
      await insertRows(tx, SKILL_MATCHES, [{ entity: valid, ordinal }], 'upsert');
    });
  }

  async getMatch(caseId: string, matchId: string): Promise<SkillMatch | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        'SELECT data FROM skill_matches WHERE tenant_id = $1 AND case_id = $2 AND id = $3',
        [this.ctx.scope.tenantId, caseId, matchId],
      );
      const row = result.rows[0];
      return row ? parseStored(SkillMatchSchema, row.data, 'skill match') : null;
    });
  }

  async listMatchesForCase(caseId: string): Promise<SkillMatch[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_matches WHERE tenant_id = $1 AND case_id = $2
          ORDER BY ordinal, id LIMIT ${MAX_MATCH_ROWS}`,
        [this.ctx.scope.tenantId, caseId],
      );
      return result.rows.map((row) => parseStored(SkillMatchSchema, row.data, 'skill match'));
    });
  }

  async listMatchesForSkill(skillId: string): Promise<SkillMatch[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM skill_matches WHERE tenant_id = $1 AND skill_id = $2
          ORDER BY created_at DESC, id DESC LIMIT ${MAX_MATCH_ROWS}`,
        [this.ctx.scope.tenantId, skillId],
      );
      return result.rows.map((row) => parseStored(SkillMatchSchema, row.data, 'skill match'));
    });
  }

  async listMatchable(workload: string): Promise<{ skill: SkillDna; version: SkillVersion }[]> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<{ skill: unknown; version: unknown }>(
        `SELECT s.data AS skill, v.data AS version
           FROM skills s
           JOIN skill_versions v ON v.tenant_id = s.tenant_id AND v.skill_id = s.id
                                AND v.id = s.current_version_id
          WHERE s.tenant_id = $1 AND s.workload = $2 AND s.lifecycle = ANY($3::text[])
          ORDER BY s.key LIMIT ${MAX_CHILD_ROWS}`,
        [this.ctx.scope.tenantId, workload, [...MATCHABLE_LIFECYCLES]],
      );
      return result.rows.map((row) => ({
        skill: parseStored(SkillDnaSchema, row.skill, 'skill'),
        version: parseStored(SkillVersionSchema, row.version, 'skill version'),
      }));
    });
  }
}
