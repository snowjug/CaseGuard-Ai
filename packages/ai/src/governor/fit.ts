import type { BuiltContext, TrimLevel } from '../context/types';
import { MAX_TRIM_LEVEL } from '../context/types';

export interface FitResult {
  built: BuiltContext;
  level: TrimLevel;
  /** Estimated prompt tokens with the untrimmed (level 0) context. */
  tokensBefore: number;
  /** Estimated prompt tokens of the chosen context. */
  tokensAfter: number;
  /** False when even the most compressed context exceeds the budget. */
  fits: boolean;
}

export interface FitOptions {
  /** Builds the context at a trim level (higher level = fewer tokens). */
  buildAt: (level: TrimLevel) => BuiltContext;
  /** Estimated prompt tokens for a built context, including the fixed instructions. */
  measure: (built: BuiltContext) => number;
  maxInputTokens: number;
  /** The most compressed level the caller accepts. A context that needs more than this does not fit. */
  maxLevel?: TrimLevel;
}

/**
 * Chooses the least-compressed context that fits the input budget (spec 5.14: context selection,
 * duplicate removal and evidence-first retrieval happen inside the trim levels). Never silently
 * exceeds the budget: when nothing fits, `fits` is false and the caller must refuse or degrade.
 */
export function fitContextToBudget(options: FitOptions): FitResult {
  const first = options.buildAt(0);
  const tokensBefore = options.measure(first);
  let best = { built: first, level: 0 as TrimLevel, tokens: tokensBefore };
  if (tokensBefore <= options.maxInputTokens) {
    return { built: first, level: 0, tokensBefore, tokensAfter: tokensBefore, fits: true };
  }
  const deepest = options.maxLevel ?? MAX_TRIM_LEVEL;
  for (let level = 1; level <= deepest; level++) {
    const trimLevel = level as TrimLevel;
    const built = options.buildAt(trimLevel);
    const tokens = options.measure(built);
    best = { built, level: trimLevel, tokens };
    if (tokens <= options.maxInputTokens) break;
  }
  return {
    built: best.built,
    level: best.level,
    tokensBefore,
    tokensAfter: best.tokens,
    fits: best.tokens <= options.maxInputTokens,
  };
}
