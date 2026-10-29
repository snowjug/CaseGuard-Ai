import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';

export const ROLES = ['engineer', 'reviewer', 'manager', 'skill_curator', 'administrator'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;
export const ROLE_LABELS: Record<Role, string> = {
  engineer: 'Technical Support Engineer',
  reviewer: 'Support Quality Reviewer',
  manager: 'Support Manager',
  skill_curator: 'Knowledge / Skill Curator',
  administrator: 'Administrator',
};

export const PERMISSIONS = [
  'case:read',
  'case:ingest',
  'case:analyze',
  'case:delete',
  'evidence:review',
  'fork:review',
  'counterfactual:run',
  'counterfactual:review',
  'actionvalue:override',
  'quality:read',
  'quality:review',
  'warning:dismiss',
  'skill:read',
  'skill:extract',
  'skill:mutate',
  'skill:validate',
  'skill:review',
  'skill:approve',
  'skill:publish',
  'skill:retire',
  'skill:rollback',
  'skill:apply',
  'analytics:read',
  'telemetry:read',
  'governance:read',
  'governance:write',
  'roles:manage',
  'audit:read',
  'demo:manage',
  'export:data',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

export const AuthModeSchema = z.enum(['dev', 'entra']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const AppEnvironmentSchema = z.enum([
  'local',
  'test',
  'development',
  'staging',
  'production',
]);
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export const TenantSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(60),
  synthetic: z.boolean(),
  createdAt: IsoTimestampSchema,
});
export type Tenant = z.infer<typeof TenantSchema>;

export const UserSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  /** Synthetic display name; never a real person in the demo data. */
  displayName: z.string().min(1).max(120),
  email: z.string().max(200),
  roles: z.array(RoleSchema).min(1),
  status: z.enum(['active', 'disabled']),
  synthetic: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  version: z.number().int().min(1),
});
export type User = z.infer<typeof UserSchema>;

/** Development persona offered by the persona picker (only when AUTH_MODE=dev outside production). */
export const PersonaSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  role: RoleSchema,
  tenantId: IdSchema,
  description: z.string(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const FeatureFlagsSchema = z.object({
  presentationMode: z.boolean(),
  counterfactualLab: z.boolean(),
  skillMutation: z.boolean(),
  azureOpenAiProvider: z.boolean(),
  semanticCache: z.boolean(),
  portfolioDemoData: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  presentationMode: true,
  counterfactualLab: true,
  skillMutation: true,
  azureOpenAiProvider: false,
  semanticCache: true,
  portfolioDemoData: false,
};

/** Response of GET /api/v1/me. */
export const SessionSchema = z.object({
  user: UserSchema.pick({ id: true, displayName: true, email: true, roles: true, synthetic: true }),
  tenant: TenantSchema.pick({ id: true, name: true, slug: true, synthetic: true }),
  permissions: z.array(PermissionSchema),
  authMode: AuthModeSchema,
  environment: AppEnvironmentSchema,
  features: FeatureFlagsSchema,
  /** Persistent honesty banners, e.g. "All data in this environment is synthetic". */
  notices: z.array(z.string()),
});
export type Session = z.infer<typeof SessionSchema>;
