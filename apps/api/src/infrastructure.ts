import type { AppConfig } from '@caseguard/config';
import type {
  HealthRegistry,
  Logger,
  MetricsRegistry,
  ProductMetrics,
} from '@caseguard/observability';
import type { Authenticator } from '@caseguard/security';
import type { Database, Repositories } from './db';
import type { Services } from './services/ports';
import type { ObjectStore } from './storage';

/** Process-wide building blocks. Nothing here is tenant- or request-specific. */
export interface BaseInfrastructure {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metricsRegistry: MetricsRegistry;
  readonly metrics: ProductMetrics;
  readonly health: HealthRegistry;
  readonly database: Database;
  /** Tenant-agnostic factory: request code must go through `ctx.repos` (tenant-bound) instead. */
  readonly repos: Repositories;
  readonly objects: ObjectStore;
  readonly now: () => Date;
  readonly newId: (prefix: string) => string;
}

/** `BaseInfrastructure` plus the pieces that depend on it (identity and the service ports). */
export interface Infrastructure extends BaseInfrastructure {
  readonly authenticator: Authenticator;
  readonly services: Services;
}
