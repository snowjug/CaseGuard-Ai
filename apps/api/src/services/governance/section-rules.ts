import { AgentNameSchema, type GovernanceSection } from '@caseguard/schemas';
import { SECRET_REDACTION_CATEGORIES, compileCustomPatterns } from '@caseguard/security';
import type { FieldIssue, GovernanceValues } from './types';

/*
 * Rules that the section Zod schemas cannot express. They exist for settings whose mistakes would be
 * silent (a typo that is ignored, a pattern that is skipped at ingestion, a band order that makes a
 * label unreachable) or unsafe (secret redaction switched off). A section without a rule is fully
 * described by its schema.
 */

const BASE = 'body.value';
const MAX_REPORTED_KEY_LENGTH = 60;

/** Keys come from the caller, so only printable characters are echoed back. */
function printable(text: string): string {
  return [...text]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .slice(0, MAX_REPORTED_KEY_LENGTH)
    .join('');
}

/** `agentBudgets` is keyed by free text in the schema; an unknown agent would be ignored forever. */
function modelRules(value: GovernanceValues['model']): FieldIssue[] {
  return Object.keys(value.agentBudgets)
    .filter((key) => !AgentNameSchema.safeParse(key).success)
    .map((key) => ({
      path: `${BASE}.agentBudgets.${printable(key)}`,
      message: 'Unknown agent. Use one of the documented agent names.',
    }));
}

/** `qualityBandFor` tests the bands top-down, so they must strictly descend or a band is unreachable. */
function qualityRules(value: GovernanceValues['quality']): FieldIssue[] {
  const { strong, adequate, needsAttention } = value.bands;
  return strong > adequate && adequate > needsAttention
    ? []
    : [
        {
          path: `${BASE}.bands`,
          message: 'Bands must descend: strong > adequate > needsAttention.',
        },
      ];
}

/**
 * Credential redaction is not optional (only personal-data categories are a tenant choice), and a
 * custom pattern that cannot run (invalid, empty-matching, backtracking, too slow) would be skipped
 * at ingestion without anyone noticing, so it is refused here with the reason.
 */
function redactionRules(value: GovernanceValues['redaction']): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const missing = SECRET_REDACTION_CATEGORIES.filter(
    (category) => !value.enabledCategories.includes(category),
  );
  if (missing.length > 0) {
    issues.push({
      path: `${BASE}.enabledCategories`,
      message: `Secret categories must stay enabled: ${missing.join(', ')}.`,
    });
  }
  value.customPatterns.forEach((pattern, index) => {
    const compiled = compileCustomPatterns([pattern]);
    if (compiled.entries.length === 0) {
      issues.push({
        path: `${BASE}.customPatterns.${index}.pattern`,
        message: compiled.notes[0] ?? 'The pattern cannot be used.',
      });
    }
  });
  return issues;
}

const noRules = (): FieldIssue[] => [];

/** Semantic rules per section; sections not listed here are fully described by their schema. */
export const SECTION_RULES: {
  readonly [S in GovernanceSection]: (value: GovernanceValues[S]) => FieldIssue[];
} = {
  model: modelRules,
  quality: qualityRules,
  action_value: noRules,
  retention: noRules,
  redaction: redactionRules,
  feature_flags: noRules,
  export_controls: noRules,
};
