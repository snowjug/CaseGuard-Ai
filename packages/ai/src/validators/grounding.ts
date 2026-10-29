import { containment, contentWords } from '../util/text';
import type { OutputIssue, ValidationContext, ValidationStats } from './types';
import { collectTexts, extractClaimItems, type TypedOutput } from './walk';

/** A statement counts as supported when this share of its content words appears in its sources. */
const MIN_ITEM_SUPPORT = 0.25;
const MAX_ISSUES = 20;

/** Distinctive identifiers (addresses, hostnames, codes) that a model must not invent. */
const SPECIFIC_TOKEN =
  /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+){2,}|[a-z]{2,}\d{2,}[a-z0-9]*|\d+[a-z]+\d[a-z0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,})\b/gi;

/** Dates and times are not identifiers; strip them so "2026-03-09T09:12:00Z" is not mistaken for a code. */
const TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

export interface GroundingCheck {
  issues: OutputIssue[];
  stats: Pick<ValidationStats, 'claims' | 'supportedClaims' | 'groundedness'>;
}

function citedWords(
  ids: readonly string[],
  sourceText: ReadonlyMap<string, string>,
): { words: Set<string>; found: number } {
  const words = new Set<string>();
  let found = 0;
  for (const id of ids) {
    const text = sourceText.get(id);
    if (text === undefined) continue;
    found++;
    for (const w of contentWords(text)) words.add(w);
  }
  return { words, found };
}

/**
 * Claim-support check: statements must cite records, be lexically supported by what they cite,
 * and not introduce distinctive identifiers that appear nowhere in the context.
 */
export function checkGroundedness(typed: TypedOutput, vctx: ValidationContext): GroundingCheck {
  const { built, limits } = vctx;
  const issues: OutputIssue[] = [];
  const items = extractClaimItems(typed);
  const contextWords = new Set(contentWords(built.allText));
  let supported = 0;

  for (const claim of items) {
    const cited = [...claim.events, ...claim.evidence, ...claim.claims];
    if (claim.requireCitation && cited.length === 0) {
      issues.push({
        kind: 'groundedness',
        code: 'missing_citation',
        path: claim.path,
        message: 'This statement cites no event, evidence or claim.',
      });
      continue;
    }
    const claimWords = new Set(contentWords(claim.text));
    const sources =
      claim.supportScope === 'context' || cited.length === 0
        ? { words: contextWords, found: 1 }
        : citedWords(cited, built.sourceText);
    if (sources.found > 0 && containment(claimWords, sources.words) >= MIN_ITEM_SUPPORT)
      supported++;
  }

  const total = items.length;
  const groundedness = total === 0 ? 1 : supported / total;
  if (total > 0 && groundedness < limits.minGroundedness) {
    issues.push({
      kind: 'groundedness',
      code: 'low_support',
      path: '$',
      message: `Only ${Math.round(groundedness * 100)}% of statements are supported by what they cite (minimum ${Math.round(limits.minGroundedness * 100)}%).`,
    });
  }

  const reported = new Set<string>();
  for (const { path, text } of collectTexts(typed.output)) {
    for (const match of text.replace(TIMESTAMP, ' ').matchAll(SPECIFIC_TOKEN)) {
      const token = match[0].toLowerCase();
      if (reported.has(token) || built.allText.includes(token)) continue;
      reported.add(token);
      if (issues.length < MAX_ISSUES) {
        issues.push({
          kind: 'groundedness',
          code: 'unsupported_specific',
          path,
          message:
            'A distinctive identifier in this text does not appear anywhere in the supplied context.',
        });
      }
    }
  }
  return { issues, stats: { claims: total, supportedClaims: supported, groundedness } };
}
