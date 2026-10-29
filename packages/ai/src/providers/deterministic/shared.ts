import type { Level } from '@caseguard/schemas';
import type { KnowledgeAction } from '@caseguard/schemas';
import type { CompiledPack } from '@caseguard/domain';
import type { Uncertainty } from '../../agents/outputs';
import { clip, collapseWhitespace } from '../../util/text';

export { clip };

export const oneLine = (text: string, max: number): string => clip(collapseWhitespace(text), max);

export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export const percent = (p: number): string => `${Math.round(p * 100)}%`;

export const uncertainty = (level: Level, note: string): Uncertainty => ({
  level,
  note: clip(note, 300),
});

/** An action the deterministic provider may recommend: not destructive, no approval, below the ceiling. */
export function isRecommendable(
  action: KnowledgeAction | undefined,
  riskCeiling: number,
): action is KnowledgeAction {
  return (
    action !== undefined &&
    !action.destructive &&
    !action.requiresApproval &&
    action.operationalRisk < riskCeiling
  );
}

export const packActionLabel = (pack: CompiledPack, id: string): string =>
  pack.actions.get(id)?.label ?? id;
