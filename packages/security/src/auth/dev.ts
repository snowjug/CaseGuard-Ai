import { z } from 'zod';
import { IdSchema, RoleSchema, type AppEnvironment, type Role } from '@caseguard/schemas';
import { AuthConfigurationError, AuthenticationError } from '../errors';
import { permissionsFor } from '../rbac';
import { isDevAuthAllowedEnvironment } from './environment';
import { readSingleHeader } from './headers';
import type { AuthContext, Authenticator, HeadersLike } from './types';

/** Header carrying the development persona id, for example `x-cg-persona: user_ava_engineer`. */
export const DEV_PERSONA_HEADER = 'x-cg-persona';

/** What a persona lookup may return: a persona row or a user row, with one or more roles. */
const PersonaRecordSchema = z
  .object({
    id: IdSchema,
    tenantId: IdSchema,
    displayName: z.string().min(1).max(120),
    role: RoleSchema.optional(),
    roles: z.array(RoleSchema).min(1).optional(),
    email: z.string().max(200).nullish(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((persona) => persona.role !== undefined || persona.roles !== undefined, {
    message: 'A persona needs a role',
  });
export type PersonaRecord = z.input<typeof PersonaRecordSchema>;

export interface DevPersonaAuthenticatorOptions {
  /** Must be exactly `true`: persona login is a second, explicit switch on top of AUTH_MODE=dev. */
  allowDev: boolean;
  environment: AppEnvironment;
  /** Resolves a persona/user by id within the persisted (synthetic) directory; `null` if unknown. */
  lookupPersona: (personaId: string) => Promise<PersonaRecord | null>;
  headerName?: string;
}

/**
 * Development-only identity: trusts the `x-cg-persona` header, which any client can forge. That is
 * acceptable only for synthetic data on a developer machine or in automated tests, so construction
 * fails unless dev auth was explicitly enabled and APP_ENV is `local` or `test` (NFR-SEC-03, SEC-1).
 */
export class DevPersonaAuthenticator implements Authenticator {
  readonly mode = 'dev' as const;
  private readonly headerName: string;
  private readonly lookupPersona: DevPersonaAuthenticatorOptions['lookupPersona'];

  constructor(options: DevPersonaAuthenticatorOptions) {
    if (options.allowDev !== true) {
      throw new AuthConfigurationError(
        'Development persona authentication requires allowDev: true (DEV_AUTH_ENABLED)',
      );
    }
    if (!isDevAuthAllowedEnvironment(options.environment)) {
      throw new AuthConfigurationError(
        `Development persona authentication is not available in the "${String(options.environment)}" environment (local and test only)`,
      );
    }
    this.headerName = options.headerName ?? DEV_PERSONA_HEADER;
    this.lookupPersona = options.lookupPersona;
  }

  async authenticate(headers: HeadersLike): Promise<AuthContext> {
    const raw = readSingleHeader(headers, this.headerName);
    if (raw === undefined || raw.trim() === '')
      throw new AuthenticationError('missing_credentials');

    const personaId = IdSchema.safeParse(raw.trim());
    if (!personaId.success) throw new AuthenticationError('malformed_credentials');

    const found = await this.lookupPersona(personaId.data);
    if (found === null) throw new AuthenticationError('unknown_persona');

    const parsed = PersonaRecordSchema.safeParse(found);
    if (!parsed.success || parsed.data.id !== personaId.data) {
      throw new AuthenticationError('unknown_persona');
    }
    if (parsed.data.status === 'disabled') throw new AuthenticationError('user_disabled');

    const roles: Role[] = parsed.data.roles ?? (parsed.data.role ? [parsed.data.role] : []);
    return {
      userId: parsed.data.id,
      tenantId: parsed.data.tenantId,
      displayName: parsed.data.displayName,
      roles,
      permissions: permissionsFor(roles),
      authMode: 'dev',
      synthetic: true,
      subject: parsed.data.id,
      email: parsed.data.email ?? null,
    };
  }
}
