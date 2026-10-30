import {
  DEFAULT_GOVERNANCE_VALUES,
  GOVERNANCE_SECTIONS,
  PersonaSchema,
  TenantSchema,
  UserSchema,
  type Persona,
  type Role,
  type Tenant,
  type User,
} from '@caseguard/schemas';
import { GOVERNANCE_SETTINGS, TENANTS, USERS } from './repositories/table-specs';
import { insertRows } from './repositories/support';
import type { Database } from './repositories/types';

/** Everything seeded here is synthetic: no real person, tenant or address appears anywhere. */
export const CONTOSO_TENANT_ID = 'tenant_contoso_support';
export const FABRIKAM_TENANT_ID = 'tenant_fabrikam_lab';

const SEED_ACTOR = 'system:seed';

/** The reserved synthetic fixture tenants; provisioning creates exactly these rows for these ids. */
export const SYNTHETIC_TENANT_DEFINITIONS: readonly Omit<Tenant, 'createdAt'>[] = [
  {
    id: CONTOSO_TENANT_ID,
    name: 'Contoso Support (synthetic)',
    slug: 'contoso-support',
    synthetic: true,
  },
  {
    id: FABRIKAM_TENANT_ID,
    name: 'Fabrikam Lab (synthetic)',
    slug: 'fabrikam-lab',
    synthetic: true,
  },
];

interface SeedUserDefinition {
  id: string;
  tenantId: string;
  displayName: string;
  email: string;
  roles: Role[];
  description: string;
}

/** Development personas (header `x-cg-persona: <userId>`); one role each, matching the role matrix. */
const USER_DEFINITIONS: readonly SeedUserDefinition[] = [
  {
    id: 'user_ava_engineer',
    tenantId: CONTOSO_TENANT_ID,
    displayName: 'Ava Engineer (synthetic)',
    email: 'ava.engineer@contoso-synthetic.invalid',
    roles: ['engineer'],
    description: 'Investigates cases, runs analyses and acts on live quality warnings.',
  },
  {
    id: 'user_riley_reviewer',
    tenantId: CONTOSO_TENANT_ID,
    displayName: 'Riley Reviewer (synthetic)',
    email: 'riley.reviewer@contoso-synthetic.invalid',
    roles: ['reviewer'],
    description: 'Reviews evidence classifications, decision forks and counterfactual paths.',
  },
  {
    id: 'user_morgan_manager',
    tenantId: CONTOSO_TENANT_ID,
    displayName: 'Morgan Manager (synthetic)',
    email: 'morgan.manager@contoso-synthetic.invalid',
    roles: ['manager'],
    description: 'Follows portfolio quality and avoidable-effort trends.',
  },
  {
    id: 'user_casey_curator',
    tenantId: CONTOSO_TENANT_ID,
    displayName: 'Casey Curator (synthetic)',
    email: 'casey.curator@contoso-synthetic.invalid',
    roles: ['skill_curator'],
    description: 'Curates, validates and publishes SkillDNA.',
  },
  {
    id: 'user_alex_admin',
    tenantId: CONTOSO_TENANT_ID,
    displayName: 'Alex Admin (synthetic)',
    email: 'alex.admin@contoso-synthetic.invalid',
    roles: ['administrator'],
    description: 'Administers governance, roles, audit and demo data.',
  },
  {
    id: 'user_fabi_engineer',
    tenantId: FABRIKAM_TENANT_ID,
    displayName: 'Fabi Engineer (synthetic)',
    email: 'fabi.engineer@fabrikam-synthetic.invalid',
    roles: ['engineer'],
    description: 'Second-tenant engineer used to prove tenant isolation.',
  },
];

/** Personas offered by the development persona picker, derived from the seeded users. */
export const DEV_PERSONAS: readonly Persona[] = USER_DEFINITIONS.map((user) =>
  PersonaSchema.parse({
    id: user.id,
    displayName: user.displayName,
    role: user.roles[0],
    tenantId: user.tenantId,
    description: user.description,
  }),
);

export interface SeedSummary {
  tenantsCreated: number;
  usersCreated: number;
  settingsCreated: number;
}

/**
 * Idempotently creates the synthetic tenants, their users and the default governance settings.
 * Existing rows are never overwritten, so role changes and edited settings survive a re-seed.
 * Runs on the owner/login connection: each tenant's rows are written under that tenant's
 * `app.tenant_id` so the seed also works when the owner is a non-superuser subject to forced RLS.
 */
export async function seedFoundation(
  db: Database,
  options: { now?: () => Date } = {},
): Promise<SeedSummary> {
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  return db.transaction(async (tx) => {
    const summary: SeedSummary = { tenantsCreated: 0, usersCreated: 0, settingsCreated: 0 };
    for (const definition of SYNTHETIC_TENANT_DEFINITIONS) {
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [definition.id]);
      const tenant = TenantSchema.parse({ ...definition, createdAt: stamp });
      summary.tenantsCreated += await insertRows(tx, TENANTS, [tenant], 'ignore');

      const users = USER_DEFINITIONS.filter((user) => user.tenantId === definition.id).map(
        (user): { user: User; createdBy: string } => ({
          user: UserSchema.parse({
            id: user.id,
            tenantId: user.tenantId,
            displayName: user.displayName,
            email: user.email,
            roles: user.roles,
            status: 'active',
            synthetic: true,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
          }),
          createdBy: SEED_ACTOR,
        }),
      );
      summary.usersCreated += await insertRows(tx, USERS, users, 'ignore');

      summary.settingsCreated += await insertRows(
        tx,
        GOVERNANCE_SETTINGS,
        GOVERNANCE_SECTIONS.map((section) => ({
          tenantId: definition.id,
          section,
          value: DEFAULT_GOVERNANCE_VALUES[section],
          version: 1,
          updatedAt: stamp,
          updatedBy: SEED_ACTOR,
          changeNote: 'Default configuration',
        })),
        'ignore',
      );
    }
    return summary;
  });
}
