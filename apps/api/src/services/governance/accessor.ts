import type { GovernanceSection, GovernanceSettings } from '@caseguard/schemas';
import type { TenantRepositories } from '../../db';
import type { GovernanceValues } from './types';

/**
 * The slice of a request context the accessors need. Anything with tenant-bound repositories works,
 * including the repositories handed to a `repos.transaction` callback.
 */
export interface GovernanceReader {
  readonly repos: Pick<TenantRepositories, 'governance'>;
}

/**
 * The tenant's governed configuration: every section with its optimistic-lock `version`, `updatedAt`,
 * `updatedBy` and `changeNote`. Missing sections are seeded with their defaults.
 *
 * The `version` label inside a value (for example `quality.version`) is chosen by whoever edits the
 * section; consumers that need reproducibility should record the section's integer `version` too.
 */
export function getGovernanceSettings(ctx: GovernanceReader): Promise<GovernanceSettings> {
  return ctx.repos.governance.getSettings();
}

/**
 * Just the values, typed per section. This is what services normally need: export controls before a
 * download, redaction categories before ingestion, retention windows, model limits and budgets.
 */
export async function getGovernanceValues(ctx: GovernanceReader): Promise<GovernanceValues> {
  const settings = await getGovernanceSettings(ctx);
  return {
    model: settings.model.value,
    quality: settings.quality.value,
    action_value: settings.action_value.value,
    retention: settings.retention.value,
    redaction: settings.redaction.value,
    feature_flags: settings.feature_flags.value,
    export_controls: settings.export_controls.value,
  };
}

/** One section's value, typed. */
export async function getGovernanceValue<S extends GovernanceSection>(
  ctx: GovernanceReader,
  section: S,
): Promise<GovernanceValues[S]> {
  const values = await getGovernanceValues(ctx);
  return values[section];
}
