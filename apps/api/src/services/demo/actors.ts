import type { FastifyBaseLogger } from 'fastify';
import { permissionsFor, type AuthContext } from '@caseguard/security';
import type { Permission, User } from '@caseguard/schemas';
import { CONTOSO_TENANT_ID } from '../../db';
import { ConflictError } from '../../errors';
import { buildRequestContext, type ContextInfrastructure } from '../../http/context-factory';
import type { RequestContext } from '../../http/request-context';

export type StoryActor = 'engineer' | 'reviewer' | 'curator' | 'administrator';

/** Where a persona's context takes its correlation id, cancellation signal and logger from. */
export interface ContextOrigin {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly logger: FastifyBaseLogger;
}

interface ActorSpec {
  /** The seeded synthetic user (see `db/seed.ts`). */
  readonly userId: string;
  readonly label: string;
  /** What the story has this person do; checked up front so a refusal never leaves a half-seeded tenant. */
  readonly needs: readonly Permission[];
}

/** The people of the story. Each step is performed by the persona the story names. */
export const STORY_ACTORS: Readonly<Record<StoryActor, ActorSpec>> = {
  engineer: {
    userId: 'user_ava_engineer',
    label: 'Ava (engineer)',
    needs: ['case:ingest', 'case:analyze', 'skill:extract', 'skill:apply'],
  },
  reviewer: {
    userId: 'user_riley_reviewer',
    label: 'Riley (reviewer)',
    needs: ['counterfactual:review', 'skill:validate', 'skill:review'],
  },
  curator: {
    userId: 'user_casey_curator',
    label: 'Casey (skill curator)',
    needs: ['skill:extract', 'skill:approve', 'skill:mutate'],
  },
  administrator: {
    userId: 'user_alex_admin',
    label: 'Alex (administrator)',
    needs: ['skill:publish'],
  },
};

/** One request context per persona, all in the caller's tenant. */
export type StoryActors = Readonly<Record<StoryActor, RequestContext>>;

const ACTOR_KEYS: readonly StoryActor[] = ['engineer', 'reviewer', 'curator', 'administrator'];

function problemsOf(actor: StoryActor, user: User | null): string[] {
  const { label, needs } = STORY_ACTORS[actor];
  if (user === null) return [`${label} does not exist`];
  if (!user.synthetic) return [`${label} is not a synthetic user`];
  if (user.status !== 'active') return [`${label} is disabled`];
  const granted = permissionsFor(user.roles);
  const missing = needs.filter((permission) => !granted.includes(permission));
  return missing.length > 0 ? [`${label} lacks ${missing.join(', ')}`] : [];
}

function contextOf(
  origin: ContextOrigin,
  infra: ContextInfrastructure,
  user: User,
): RequestContext {
  const auth: AuthContext = {
    userId: user.id,
    tenantId: user.tenantId,
    displayName: user.displayName,
    roles: user.roles,
    permissions: permissionsFor(user.roles),
    // These are the seeded synthetic personas, acting through the services as they would over HTTP.
    authMode: 'dev',
    synthetic: true,
    subject: user.id,
    email: user.email.length > 0 ? user.email : null,
  };
  return buildRequestContext(infra, {
    requestId: origin.requestId,
    auth,
    permission: null,
    signal: origin.signal,
    logger: origin.logger,
  });
}

/**
 * The contexts of the story's personas in the caller's tenant. Refuses (409) when the tenant does not
 * have them, is not a synthetic demo workspace, or has changed their roles so the story cannot run.
 */
export async function resolveStoryActors(
  base: RequestContext,
  infra: ContextInfrastructure,
): Promise<StoryActors> {
  const users = await Promise.all(
    ACTOR_KEYS.map((key) => base.repos.governance.getUser(STORY_ACTORS[key].userId)),
  );
  const problems = ACTOR_KEYS.flatMap((key, index) => problemsOf(key, users[index] ?? null));
  const [engineer, reviewer, curator, administrator] = users;
  if (problems.length > 0 || !engineer || !reviewer || !curator || !administrator) {
    throw new ConflictError(
      `The demo story needs its synthetic personas in this workspace: ${problems.join('; ')}.`,
      { reason: 'personas_unavailable' },
    );
  }
  return {
    engineer: contextOf(base, infra, engineer),
    reviewer: contextOf(base, infra, reviewer),
    curator: contextOf(base, infra, curator),
    administrator: contextOf(base, infra, administrator),
  };
}

/** What the command line and the start-up hook need: a process-wide infrastructure and a logger. */
export interface ProcessInfrastructure extends ContextInfrastructure {
  readonly logger: FastifyBaseLogger;
}

/**
 * The seeded administrator of the synthetic Contoso tenant, for code that runs outside a request (the
 * demo scripts and the start-up seed). It is the same persona a presenter signs in as; it is refused
 * when that user is missing, disabled, not synthetic or cannot manage demo data.
 */
export async function administratorContext(infra: ProcessInfrastructure): Promise<RequestContext> {
  const repos = infra.repos.forTenant({ tenantId: CONTOSO_TENANT_ID, actorId: 'system:demo' });
  const user = await repos.governance.getUser(STORY_ACTORS.administrator.userId);
  if (
    user === null ||
    !user.synthetic ||
    user.status !== 'active' ||
    !permissionsFor(user.roles).includes('demo:manage')
  ) {
    throw new ConflictError(
      'The synthetic administrator of the demo tenant is not available, so demo data cannot be managed here.',
      { reason: 'personas_unavailable' },
    );
  }
  return contextOf(
    {
      requestId: infra.newId('demo'),
      signal: new AbortController().signal,
      logger: infra.logger,
    },
    infra,
    user,
  );
}
