import {
  ActionValueConfigSchema,
  ExportControlsSchema,
  FeatureFlagsSchema,
  ModelConfigSchema,
  QualityConfigSchema,
  RedactionConfigSchema,
  RetentionConfigSchema,
  type GovernanceSection,
} from '@caseguard/schemas';
import type { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { SECTION_RULES } from './section-rules';
import type { FieldIssue, GovernanceValues } from './types';

interface SectionDefinition<T> {
  readonly label: string;
  readonly schema: z.ZodType<T>;
}

const DEFINITIONS: { readonly [S in GovernanceSection]: SectionDefinition<GovernanceValues[S]> } = {
  model: { label: 'model configuration', schema: ModelConfigSchema },
  quality: { label: 'quality scoring', schema: QualityConfigSchema },
  action_value: { label: 'action-value', schema: ActionValueConfigSchema },
  retention: { label: 'retention', schema: RetentionConfigSchema },
  redaction: { label: 'redaction', schema: RedactionConfigSchema },
  feature_flags: { label: 'feature flag', schema: FeatureFlagsSchema },
  export_controls: { label: 'export controls', schema: ExportControlsSchema },
};

const BASE = 'body.value';
const MAX_ISSUES = 50;

/** Zod issues as API field problems (`body.value.costLimits.perDayUsd`). */
export function zodIssues(error: z.ZodError, base: string = BASE): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: [base, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys the caller sent that the schema dropped. Zod strips unknown keys silently, which for a setting
 * means a typo (`maxRecordPerExport`) would be accepted, audited as a change and then do nothing.
 */
export function findUnknownKeys(
  input: unknown,
  parsed: unknown,
  base: string = BASE,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const walk = (sent: unknown, kept: unknown, path: string): void => {
    if (issues.length >= MAX_ISSUES) return;
    if (Array.isArray(sent) && Array.isArray(kept)) {
      sent.forEach((item, index) => walk(item, kept[index], `${path}.${index}`));
      return;
    }
    if (!isRecord(sent) || !isRecord(kept)) return;
    for (const key of Object.keys(sent)) {
      if (!Object.hasOwn(kept, key)) {
        issues.push({ path: `${path}.${key.slice(0, 60)}`, message: 'Unrecognised setting.' });
      } else {
        walk(sent[key], kept[key], `${path}.${key}`);
      }
    }
  };
  walk(input, parsed, base);
  return issues;
}

/**
 * Validates a section value with its Zod schema from `@caseguard/schemas`, refuses keys the schema does
 * not know, and applies the semantic rules. Every problem is reported with its field path (422).
 */
export function validateSectionValue<S extends GovernanceSection>(
  section: S,
  raw: unknown,
): GovernanceValues[S] {
  const definition = DEFINITIONS[section];
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationFailedError(
      `Invalid ${definition.label} settings`,
      zodIssues(parsed.error),
    );
  }
  const issues = [
    ...findUnknownKeys(raw, parsed.data),
    ...SECTION_RULES[section](parsed.data),
  ].slice(0, MAX_ISSUES);
  if (issues.length > 0) {
    throw new ValidationFailedError(`Invalid ${definition.label} settings`, issues);
  }
  return parsed.data;
}
