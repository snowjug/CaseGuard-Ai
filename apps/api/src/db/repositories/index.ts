import { ValidationFailedError } from '../../errors';
import { assertTenantScope } from '../driver-types';
import { createIdGenerator, type IdGenerator } from '../ids';
import { getMigrationStatus } from '../migrate';
import { AnalysisRepositoryImpl } from './analysis-repository';
import { AnalyticsRepositoryImpl } from './analytics-repository';
import { AuditRepositoryImpl } from './audit-repository';
import { CaseRepositoryImpl } from './case-repository';
import { CounterfactualRepositoryImpl } from './counterfactual-repository';
import { DemoRepositoryImpl } from './demo-repository';
import { GovernanceRepositoryImpl } from './governance-repository';
import { IdempotencyRepositoryImpl } from './idempotency-repository';
import { JobRepositoryImpl } from './job-repository';
import { ReviewRepositoryImpl } from './review-repository';
import { SearchRepositoryImpl } from './search-repository';
import { SkillRepositoryImpl } from './skill-repository';
import type { RepoContext, Run } from './support';
import { TelemetryRepositoryImpl } from './telemetry-repository';
import type { Database, Repositories, SqlExecutor, TenantRepositories, TenantScope } from './types';

export interface RepositoryDeps {
  /** Clock used for created/updated stamps and TTLs; inject a fixed clock in tests. */
  now?: (() => Date) | undefined;
  /** Generator for ids the repositories mint themselves (audit events). */
  newId?: IdGenerator | undefined;
  /** How long a completed idempotency key is remembered. Default 24 hours. */
  idempotencyTtlMs?: number | undefined;
  /** After this long a reserved-but-never-completed key may be taken over. Default 5 minutes. */
  idempotencyReservationTtlMs?: number | undefined;
}

type SharedContext = Pick<RepoContext, 'kind' | 'now' | 'newId' | 'idempotency'>;

function build(
  database: Database,
  scope: TenantScope,
  shared: SharedContext,
  bound: SqlExecutor | null,
): TenantRepositories {
  // Standalone repositories open one tenant-scoped transaction per operation; repositories bound to
  // a transaction run every operation on that transaction's connection.
  const run: Run = bound ? (fn) => fn(bound) : (fn) => database.withTenant(scope, fn);
  const ctx: RepoContext = { scope, run, ...shared };
  const repositories: TenantRepositories = {
    scope,
    cases: new CaseRepositoryImpl(ctx),
    analysis: new AnalysisRepositoryImpl(ctx),
    counterfactuals: new CounterfactualRepositoryImpl(ctx),
    skills: new SkillRepositoryImpl(ctx),
    telemetry: new TelemetryRepositoryImpl(ctx),
    governance: new GovernanceRepositoryImpl(ctx),
    audit: new AuditRepositoryImpl(ctx),
    reviews: new ReviewRepositoryImpl(ctx),
    jobs: new JobRepositoryImpl(ctx),
    idempotency: new IdempotencyRepositoryImpl(ctx),
    demo: new DemoRepositoryImpl(ctx),
    analytics: new AnalyticsRepositoryImpl(ctx),
    search: new SearchRepositoryImpl(ctx),
    transaction: (fn) =>
      bound
        ? fn(repositories)
        : database.withTenant(scope, (tx) => fn(build(database, scope, shared, tx))),
  };
  return repositories;
}

/**
 * Composes every repository over `database`. `forTenant(scope)` returns repositories that can only
 * see and write that tenant's rows (application filter + row-level security). Inside
 * `repositories.transaction(fn)` use the repositories passed to `fn`: calling the outer ones would
 * open a second transaction (and deadlock on PGlite).
 */
export function createRepositories(database: Database, deps: RepositoryDeps = {}): Repositories {
  const shared: SharedContext = {
    kind: database.kind,
    now: deps.now ?? (() => new Date()),
    newId: deps.newId ?? createIdGenerator(),
    idempotency: {
      ttlMs: deps.idempotencyTtlMs ?? 24 * 60 * 60 * 1000,
      reservationTtlMs: deps.idempotencyReservationTtlMs ?? 5 * 60 * 1000,
    },
  };
  return {
    database,
    forTenant(scope: TenantScope): TenantRepositories {
      assertTenantScope(scope);
      if (
        typeof scope.actorId !== 'string' ||
        scope.actorId.length === 0 ||
        scope.actorId.length > 120
      ) {
        throw new ValidationFailedError('A tenant scope requires an actor id', [
          { path: 'actorId', message: 'Expected a non-empty actor id of at most 120 characters' },
        ]);
      }
      return build(database, scope, shared, null);
    },
    migrationStatus: () => getMigrationStatus(database),
  };
}
