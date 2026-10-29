import type { KnowledgePack } from '@caseguard/schemas';
import { compileKnowledgePack, type CompiledPack } from './compile';
import { TEAMS_AUTH_PACK } from './teams-authentication';

export { compileKnowledgePack, type CompiledPack, type CompiledDetector } from './compile';
export { TEAMS_AUTH_PACK, H as TEAMS_HYPOTHESES } from './teams-authentication';

const BUILTIN_PACKS: readonly KnowledgePack[] = [TEAMS_AUTH_PACK];
const compiledCache = new Map<string, CompiledPack>();

/** Built-in packs shipped with the product. */
export function listKnowledgePacks(): readonly KnowledgePack[] {
  return BUILTIN_PACKS;
}

/** Returns the compiled pack for a workload key, or null when no pack covers it. */
export function getCompiledPack(workload: string): CompiledPack | null {
  const cached = compiledCache.get(workload);
  if (cached) return cached;
  const pack = BUILTIN_PACKS.find((p) => p.workload === workload);
  if (!pack) return null;
  const compiled = compileKnowledgePack(pack);
  compiledCache.set(workload, compiled);
  return compiled;
}
