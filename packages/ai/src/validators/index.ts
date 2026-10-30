import type { ZodError } from 'zod';
import type { AgentName, ValidationOutcome } from '@caseguard/schemas';
import { OUTPUT_SCHEMAS, type AgentOutputs, type IssueKind } from '../agents/outputs';
import { checkCitations } from './citations';
import { checkFacts } from './facts';
import { checkGroundedness } from './grounding';
import { checkOutputInjection } from './injection';
import { checkPolicy } from './policy';
import { checkTemporal } from './temporal';
import {
  DEFAULT_VALIDATION_LIMITS,
  NON_REPAIRABLE_KINDS,
  type OutputIssue,
  type ValidationContext,
  type ValidationLimits,
  type ValidationReport,
  type ValidationStats,
} from './types';
import type { TypedOutput } from './walk';

const MAX_REPORTED_ISSUES = 50;

function formatPath(path: readonly PropertyKey[]): string {
  return (
    path.reduce<string>((acc, part) => {
      if (typeof part === 'number') return `${acc}[${part}]`;
      const key = typeof part === 'symbol' ? 'symbol' : part;
      return acc === '' ? key : `${acc}.${key}`;
    }, '') || '$'
  );
}

/** Zod messages can echo model-supplied key names; map to our own fixed wording instead. */
function schemaIssues(error: ZodError): OutputIssue[] {
  return error.issues.slice(0, 20).map((issue) => {
    const message =
      issue.code === 'invalid_type'
        ? `Expected ${issue.expected}.`
        : issue.code === 'too_big'
          ? 'Value is too long or has too many items.'
          : issue.code === 'too_small'
            ? 'Value is too short or has too few items.'
            : issue.code === 'unrecognized_keys'
              ? 'Unexpected property.'
              : issue.code === 'invalid_value'
                ? 'Value is not one of the allowed options.'
                : 'Invalid value.';
    return { kind: 'schema' as const, code: issue.code, path: formatPath(issue.path), message };
  });
}

function outcomeOf(issues: readonly OutputIssue[]): ValidationOutcome {
  const has = (...kinds: IssueKind[]): boolean => issues.some((i) => kinds.includes(i.kind));
  return {
    schemaValid: !has('schema', 'size'),
    citationsValid: !has('citation', 'groundedness'),
    policyValid: !has('policy', 'injection'),
    temporalValid: !has('temporal'),
    issues: issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((i) => `[${i.kind}:${i.code}] ${i.path}: ${i.message}`.slice(0, 400)),
  };
}

const EMPTY_STATS: ValidationStats = {
  claims: 0,
  supportedClaims: 0,
  citations: 0,
  validCitations: 0,
  groundedness: 1,
};

function report<T>(
  output: T | null,
  issues: OutputIssue[],
  stats: ValidationStats = EMPTY_STATS,
): ValidationReport<T> {
  const kinds = [...new Set(issues.map((i) => i.kind))];
  return {
    ok: issues.length === 0 && output !== null,
    output: issues.length === 0 ? output : null,
    issues,
    kinds,
    outcome: outcomeOf(issues),
    repairable: issues.length > 0 && kinds.every((k) => !NON_REPAIRABLE_KINDS.has(k)),
    stats,
  };
}

/**
 * The "dispose" half of "LLM proposes, code disposes": size bound, schema, citations, temporal
 * integrity, safety policy, claim support and injection indicators. Returns a typed report; raw
 * model text is never surfaced. With a null context (deterministic-only agents) only the size
 * bound and the schema are checked.
 */
export function validateAgentOutput<A extends AgentName>(
  agent: A,
  raw: unknown,
  vctx: ValidationContext | null,
  limits: ValidationLimits = DEFAULT_VALIDATION_LIMITS,
): ValidationReport<AgentOutputs[A]> {
  if (raw === undefined) {
    return report<AgentOutputs[A]>(null, [
      {
        kind: 'schema',
        code: 'not_json',
        path: '$',
        message: 'The model reply was not valid JSON.',
      },
    ]);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return report<AgentOutputs[A]>(null, [
      {
        kind: 'schema',
        code: 'unserializable',
        path: '$',
        message: 'The output cannot be serialised as JSON.',
      },
    ]);
  }
  const maxChars = vctx?.limits.maxOutputChars ?? limits.maxOutputChars;
  if (serialized.length > maxChars) {
    return report<AgentOutputs[A]>(null, [
      {
        kind: 'size',
        code: 'output_too_large',
        path: '$',
        message: `The output exceeds the ${maxChars} character limit.`,
      },
    ]);
  }

  const parsed = OUTPUT_SCHEMAS[agent].safeParse(raw);
  if (!parsed.success) return report<AgentOutputs[A]>(null, schemaIssues(parsed.error));
  if (vctx === null) return report(parsed.data, []);

  const typed = { agent, output: parsed.data } as TypedOutput;
  const citations = checkCitations(parsed.data, vctx);
  const grounding = checkGroundedness(typed, vctx);
  const issues: OutputIssue[] = [
    ...citations.issues,
    ...checkTemporal(parsed.data, vctx),
    ...checkPolicy(typed, vctx),
    ...grounding.issues,
    ...checkFacts(typed, vctx),
    ...checkOutputInjection(parsed.data, vctx),
  ];
  return report(parsed.data, issues, {
    ...grounding.stats,
    citations: citations.total,
    validCitations: citations.valid,
  });
}

export { buildValidationContext, type ValidationDeps } from './context';
export { buildLeakGuard, type LeakGuardInput } from './leak-guard';
export { defaultInjectionScanner } from './injection';
export * from './types';
