import { createPromptRegistry, type PromptRegistry } from '@caseguard/ai';
import type { PromptVersion } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';

export type PromptContext = Pick<RequestContext, 'repos' | 'auth'>;

/** The prompts shipped with this build, shaped as governance records. */
export interface PromptCatalog {
  builtIn(tenantId: string): PromptVersion[];
}

const CATALOG_AUTHOR = 'system:prompt-registry';

/**
 * Wraps the reviewed prompt registry of `@caseguard/ai` (built on first use, immutable afterwards).
 * The registry has no creation time of its own, so records carry the time this process loaded it.
 */
export function createPromptCatalog(loadedAt: string): PromptCatalog {
  let registry: PromptRegistry | null = null;
  return {
    builtIn(tenantId) {
      registry ??= createPromptRegistry();
      return registry.toRecords({ tenantId, now: loadedAt, createdBy: CATALOG_AUTHOR });
    },
  };
}

/** Newest agent version first within an agent; numeric so `1.10.0` sorts after `1.9.0`. */
function compareRecords(a: PromptVersion, b: PromptVersion): number {
  return (
    a.agent.localeCompare(b.agent) || b.version.localeCompare(a.version, 'en', { numeric: true })
  );
}

/**
 * Versioned prompts: every built-in version plus any older version this tenant's model executions
 * recorded (retired prompts stay visible, because past results reference them). A built-in version
 * always wins over a stored one with the same id, since the registry refuses to change a published
 * version's text.
 */
export async function listPrompts(
  ctx: PromptContext,
  catalog: PromptCatalog,
): Promise<PromptVersion[]> {
  const stored = await ctx.repos.telemetry.listPromptVersions();
  const byId = new Map(stored.map((prompt) => [prompt.id, prompt]));
  for (const prompt of catalog.builtIn(ctx.auth.tenantId)) byId.set(prompt.id, prompt);
  return [...byId.values()].sort(compareRecords);
}
