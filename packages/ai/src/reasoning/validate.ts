import {
  CASE_CRITIC_KEYS,
  CASE_REASONER_KEYS,
  CritiqueSchema,
  PROPOSAL_LIMITS,
  ProposedUncertaintySchema,
  findProhibitedFields,
  type AiFindingCheck,
  type AiFindingEvidence,
  type AnyProposal,
  type CaseCriticOutput,
  type CaseReasonerOutput,
  type CriticResult,
  type Critique,
  type FindingType,
  type ProposedCitation,
  type ReasonerProposal,
} from '@caseguard/schemas';
import type {
  OutputIssue,
  ValidationContext,
  ValidationReport,
  ValidationStats,
} from '../validators/types';
import { buildRuleContext, type RuleContext } from './context';
import { locateCitation } from './locate';
import { checkCriticNewStory } from './rules/critic-new-story';
import { checkCriticUnknownTarget } from './rules/critic-unknown-target';
import { checkDuplicates } from './rules/duplicate';
import { checkExcerptNotFound, checkExcerptWrongEvent } from './rules/excerpt';
import { checkExcessiveOutput, checkReplySize, splitOverflow } from './rules/excessive-output';
import { checkFutureInformation } from './rules/future-information';
import { checkInstructionLikeText } from './rules/instruction-like-text';
import { checkMissingEvidence } from './rules/missing-evidence';
import { checkModelBasisOverclaim } from './rules/model-basis-overclaim';
import { checkNumericTimeClaim } from './rules/numeric-time-claim';
import { pathOf } from './rules/parse';
import { checkPolicyViolation } from './rules/policy-violation';
import { checkProhibitedField } from './rules/prohibited-field';
import { checkSchema } from './rules/schema';
import { checkSecretLikeText } from './rules/secret-like-text';
import { checkUnknownEvent } from './rules/unknown-event';
import { checkUnknownVocabularyId } from './rules/unknown-vocabulary-id';
import { checkUnsupportedCertainty } from './rules/unsupported-certainty';
import { isRecord, sanitisePath } from './text';
import type {
  DroppedItem,
  KeptCritic,
  KeptCritique,
  KeptProposal,
  ProposalAgent,
  ProposalCode,
  ProposalIssue,
  ProposalReport,
} from './types';

const MAX_LISTED_DROPPED = 100;
const MAX_OUTCOME_ISSUES = 50;

/** Where each list of a reasoner reply is, the type of what it holds, and how many it may hold. */
const REASONER_LISTS = [
  ['signals', 'signal', PROPOSAL_LIMITS.signals],
  ['contradictions', 'contradiction', PROPOSAL_LIMITS.contradictions],
  ['missingEvidence', 'missing_evidence', PROPOSAL_LIMITS.missingEvidence],
  ['missedSteps', 'missed_step', PROPOSAL_LIMITS.missedSteps],
  ['counterfactuals', 'counterfactual', PROPOSAL_LIMITS.counterfactuals],
  ['recommendations', 'recommendation', PROPOSAL_LIMITS.recommendations],
] as const;

const CHECK_DETAIL: Record<ProposalCode, string> = {
  schema: 'The proposal matches its schema.',
  prohibited_field: 'The proposal names no field that only the server may set.',
  unknown_event: 'Every cited event was shown to the model.',
  unknown_vocabulary_id: 'Every signal, requirement, action or skill named is in the allow-list.',
  excerpt_not_found: 'Every quotation is a verbatim part of the cited event as the model saw it.',
  excerpt_wrong_event: 'Every quotation comes from the event it is cited for.',
  missing_evidence: 'The proposal carries citations.',
  future_information: 'Nothing cited or said comes from after the moment the finding is about.',
  unsupported_certainty: 'Confidence and wording match what the basis supports.',
  numeric_time_claim: 'No saved time is stated as a number.',
  model_basis_overclaim: 'The counterfactual claims only a basis a model may use.',
  instruction_like_text: 'No instruction-like text, markup or link.',
  secret_like_text: 'No secret-like value.',
  duplicate: 'The proposal is not a repeat of another one.',
  excessive_output: 'Every text and list is within its size cap.',
  critic_unknown_target: 'The critique targets a conclusion under review.',
  critic_new_story:
    'The critique is about a conclusion under review, cites events and names no new cause.',
  policy_violation:
    'Nothing the safety policy forbids is recommended, and no individual is judged.',
};

/** The rules a kept proposal passed, in the order they ran. */
function checksFor(type: FindingType): AiFindingCheck[] {
  const codes: ProposalCode[] = [
    'prohibited_field',
    'schema',
    'excessive_output',
    'missing_evidence',
    'unknown_event',
    ...(type === 'counterfactual' ? (['model_basis_overclaim'] as const) : []),
    ...(['signal', 'missing_evidence', 'missed_step', 'counterfactual'].includes(type)
      ? (['unknown_vocabulary_id'] as const)
      : []),
    'excerpt_not_found',
    'excerpt_wrong_event',
    'future_information',
    'unsupported_certainty',
    'numeric_time_claim',
    'instruction_like_text',
    'secret_like_text',
    'policy_violation',
    'duplicate',
  ];
  return codes.map((id) => ({ id, passed: true, detail: CHECK_DETAIL[id] }));
}

const REDACTED_NOTE =
  'A quotation was verified in the redacted text the model was shown, not in the stored text (the redaction replaced part of it).';

function locateAll(
  citations: readonly ProposedCitation[],
  ctx: RuleContext,
): AiFindingEvidence[] | null {
  const located: AiFindingEvidence[] = [];
  for (const citation of citations) {
    const event = ctx.events.get(citation.eventId);
    const evidence = event ? locateCitation(event, citation) : null;
    if (!evidence) return null;
    located.push(evidence);
  }
  return located;
}

/** The rules that read a parsed proposal, in a fixed order. */
function semanticIssues(parsed: AnyProposal | Critique, ctx: RuleContext): ProposalIssue[] {
  const proposal = parsed as AnyProposal;
  return [
    ...checkUnknownEvent(parsed, ctx),
    ...('type' in parsed ? checkUnknownVocabularyId(proposal, ctx) : []),
    ...checkExcerptNotFound(parsed, ctx),
    ...checkExcerptWrongEvent(parsed, ctx),
    ...checkFutureInformation(parsed, ctx),
    ...('type' in parsed ? checkUnsupportedCertainty(proposal) : []),
    ...('type' in parsed ? checkNumericTimeClaim(proposal) : []),
    ...checkInstructionLikeText(parsed, ctx),
    ...checkSecretLikeText(parsed),
    ...checkPolicyViolation(parsed, ctx),
  ];
}

interface ElementResult {
  issues: ProposalIssue[];
  parsed: AnyProposal | null;
}

/** The rules that read the raw element, then the schema, then (only for an element that parses) the semantic rules. */
function checkElement(type: FindingType, raw: unknown, ctx: RuleContext): ElementResult {
  const issues: ProposalIssue[] = [
    ...checkProhibitedField(raw),
    ...checkModelBasisOverclaim(raw),
    ...checkMissingEvidence(raw),
    ...checkExcessiveOutput(type, raw),
  ];
  const schema = checkSchema(type, raw);
  issues.push(...schema.issues);
  if (schema.parsed === null) return { issues, parsed: null };
  issues.push(...semanticIssues(schema.parsed, ctx));
  return { issues, parsed: issues.length === 0 ? schema.parsed : null };
}

function keepReasoner(parsed: ReasonerProposal, ctx: RuleContext): KeptProposal | null {
  const evidence = locateAll(parsed.evidence, ctx);
  if (!evidence) return null;
  const keyPointEvidence: AiFindingEvidence[][] = [];
  if (parsed.type === 'case_synthesis') {
    for (const point of parsed.keyPoints) {
      const located = locateAll(point.evidence, ctx);
      if (!located) return null;
      keyPointEvidence.push(located);
    }
  }
  const all = [...evidence, ...keyPointEvidence.flat()];
  return {
    proposal: parsed,
    evidence,
    keyPointEvidence,
    checks: checksFor(parsed.type),
    notes: all.some((e) => e.verifiedIn === 'redacted_view') ? [REDACTED_NOTE] : [],
  };
}

const SCHEMA_CODES: ReadonlySet<ProposalCode> = new Set([
  'schema',
  'prohibited_field',
  'excessive_output',
  'duplicate',
]);
const CITATION_CODES: ReadonlySet<ProposalCode> = new Set([
  'unknown_event',
  'unknown_vocabulary_id',
  'excerpt_not_found',
  'excerpt_wrong_event',
  'missing_evidence',
  'critic_unknown_target',
  'critic_new_story',
]);

const EMPTY_STATS: ValidationStats = {
  claims: 0,
  supportedClaims: 0,
  citations: 0,
  validCitations: 0,
  groundedness: 1,
};

function tally(dropped: readonly DroppedItem[]): Partial<Record<ProposalCode, number>> {
  const counts: Partial<Record<ProposalCode, number>> = {};
  for (const item of dropped) {
    for (const code of new Set(item.codes)) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function outcomeOf(dropped: readonly DroppedItem[]): ValidationReport['outcome'] {
  const has = (test: (code: ProposalCode) => boolean): boolean =>
    dropped.some((item) => item.codes.some(test));
  return {
    schemaValid: !has((c) => SCHEMA_CODES.has(c)),
    citationsValid: !has((c) => CITATION_CODES.has(c)),
    policyValid: !has(
      (c) => !SCHEMA_CODES.has(c) && !CITATION_CODES.has(c) && c !== 'future_information',
    ),
    temporalValid: !has((c) => c === 'future_information'),
    issues: dropped
      .slice(0, MAX_OUTCOME_ISSUES)
      .map((item) =>
        `[proposal:${item.codes.join('+')}] ${item.path}: dropped (${item.type})`.slice(0, 400),
      ),
  };
}

function wholeReplyFailure(
  agent: ProposalAgent,
  kind: 'schema' | 'size',
  issueCode: string,
  code: ProposalCode,
  message: string,
): ValidationReport<CaseReasonerOutput | CaseCriticOutput> {
  const issue: OutputIssue = { kind, code: issueCode, path: '$', message };
  return {
    ok: false,
    output: null,
    issues: [issue],
    kinds: [kind],
    outcome: {
      schemaValid: false,
      citationsValid: true,
      policyValid: true,
      temporalValid: true,
      issues: [`[${kind}:${issueCode}] $: ${message}`],
    },
    repairable: true,
    stats: EMPTY_STATS,
    proposals: {
      agent,
      proposed: 0,
      kept: 0,
      dropped: [{ type: 'reply', path: '$', codes: [code] }],
      rejectedByCode: { [code]: 1 },
      wholeReply: [{ code, path: '$', message }],
      reasoner: null,
      critic: null,
    },
  };
}

/** The top-level shape: exactly the keys of the schema, each of the right kind. Returns a failure or null. */
function checkEnvelope(
  agent: ProposalAgent,
  raw: unknown,
): ValidationReport<CaseReasonerOutput | CaseCriticOutput> | null {
  const fail = (code: ProposalCode, issueCode: string, message: string) =>
    wholeReplyFailure(agent, 'schema', issueCode, code, message);
  if (!isRecord(raw)) return fail('schema', 'invalid_type', 'Expected an object.');
  const keys: readonly string[] = agent === 'case_reasoner' ? CASE_REASONER_KEYS : CASE_CRITIC_KEYS;
  const prohibited = findProhibitedFields(
    Object.fromEntries(Object.keys(raw).map((key) => [key, 1])),
  );
  if (prohibited.length > 0) {
    return fail(
      'prohibited_field',
      'prohibited_field',
      'The reply names a field that only the server may set.',
    );
  }
  if (Object.keys(raw).some((key) => !keys.includes(key))) {
    return fail('schema', 'unrecognized_keys', 'Unexpected property.');
  }
  if (keys.some((key) => !(key in raw)))
    return fail('schema', 'invalid_type', 'A required property is missing.');
  if (!ProposedUncertaintySchema.safeParse(raw.uncertainty).success) {
    return fail('schema', 'invalid_type', 'The reply carries no valid uncertainty.');
  }
  if (agent === 'case_reasoner') {
    for (const [key] of REASONER_LISTS) {
      if (!Array.isArray(raw[key])) return fail('schema', 'invalid_type', 'Expected a list.');
    }
    if (raw.synthesis !== null && !isRecord(raw.synthesis)) {
      return fail('schema', 'invalid_type', 'Expected an object or null.');
    }
  } else if (raw.result !== null && !isRecord(raw.result)) {
    return fail('schema', 'invalid_type', 'Expected an object or null.');
  }
  return null;
}

interface Tally {
  proposed: number;
  dropped: DroppedItem[];
}

const drop = (
  t: Tally,
  type: DroppedItem['type'],
  path: string,
  issues: readonly ProposalIssue[],
): void => {
  t.dropped.push({
    type,
    path: sanitisePath(path),
    codes: [...new Set(issues.map((i) => i.code))],
  });
};

function validateReasoner(
  raw: Record<string, unknown>,
  ctx: RuleContext,
): ValidationReport<CaseReasonerOutput> {
  const t: Tally = { proposed: 0, dropped: [] };
  const survivors: { key: string; kept: KeptProposal; path: string }[] = [];

  const consider = (type: FindingType, path: string, element: unknown, key: string): void => {
    t.proposed++;
    const checked = checkElement(type, element, ctx);
    if (checked.parsed === null) return drop(t, type, path, checked.issues);
    const kept = keepReasoner(checked.parsed as ReasonerProposal, ctx);
    if (kept === null) {
      return drop(t, type, path, [
        { code: 'excerpt_not_found', path, message: 'A quotation could not be located.' },
      ]);
    }
    survivors.push({ key, kept, path });
  };

  for (const [key, type, cap] of REASONER_LISTS) {
    const list = raw[key] as unknown[];
    const { within, overflow } = splitOverflow(list, cap, key);
    t.proposed += overflow.length;
    overflow.forEach((issue) => drop(t, type, issue.path, [issue]));
    within.forEach((element, i) => consider(type, `${key}[${i}]`, element, key));
  }
  if (raw.synthesis !== null) consider('case_synthesis', 'synthesis', raw.synthesis, 'synthesis');

  const repeats = checkDuplicates(survivors.map((s) => s.kept.proposal));
  const kept: { key: string; kept: KeptProposal }[] = [];
  survivors.forEach((s, i) => {
    const issues = repeats[i] ?? [];
    if (issues.length > 0) drop(t, s.kept.proposal.type, s.path, issues);
    else kept.push(s);
  });

  const of = <K extends string>(key: K) =>
    kept.filter((k) => k.key === key).map((k) => k.kept.proposal);
  const output = {
    signals: of('signals'),
    contradictions: of('contradictions'),
    missingEvidence: of('missingEvidence'),
    missedSteps: of('missedSteps'),
    counterfactuals: of('counterfactuals'),
    recommendations: of('recommendations'),
    synthesis: of('synthesis')[0] ?? null,
    uncertainty: raw.uncertainty,
  } as CaseReasonerOutput;

  return finish('case_reasoner', output, t, kept.length, {
    reasoner: kept.map((k) => k.kept),
    critic: null,
  });
}

function validateCritique(
  raw: unknown,
  ctx: RuleContext,
): { issues: ProposalIssue[]; kept: KeptCritique | null } {
  const issues: ProposalIssue[] = [...checkProhibitedField(raw)];
  const parsed = CritiqueSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const explained =
        issue.code === 'unrecognized_keys' &&
        findProhibitedFields(Object.fromEntries(issue.keys.map((k) => [k, 1]))).length ===
          issue.keys.length;
      if (issue.code === 'too_big') {
        issues.push({
          code: 'excessive_output',
          path: sanitisePath(pathOf(issue.path)),
          message: 'A string or a list of the critique is longer than the allowed size.',
        });
      } else if (!explained) {
        issues.push({
          code: 'schema',
          path: sanitisePath(pathOf(issue.path)),
          message: 'The critique does not match its schema.',
        });
      }
    }
    return { issues: issues.slice(0, 8), kept: null };
  }
  const critique = parsed.data;
  issues.push(
    ...checkCriticUnknownTarget(critique, ctx),
    ...checkCriticNewStory(critique, ctx),
    ...semanticIssues(critique, ctx),
  );
  if (issues.length > 0) return { issues, kept: null };
  const evidence = locateAll(critique.evidence, ctx);
  if (!evidence) {
    return {
      issues: [
        {
          code: 'excerpt_not_found',
          path: 'evidence',
          message: 'A quotation could not be located.',
        },
      ],
      kept: null,
    };
  }
  return { issues: [], kept: { critique, evidence } };
}

function validateCritic(
  raw: Record<string, unknown>,
  ctx: RuleContext,
): ValidationReport<CaseCriticOutput> {
  const t: Tally = { proposed: 0, dropped: [] };
  const uncertainty = raw.uncertainty as CaseCriticOutput['uncertainty'];
  const result = raw.result;
  if (result === null) {
    return finish('case_critic', { result: null, uncertainty }, t, 0, {
      reasoner: null,
      critic: null,
    });
  }
  const shellSource = result as Record<string, unknown>;
  t.proposed = 1;
  const rawCritiques = shellSource.critiques;
  if (!Array.isArray(rawCritiques)) {
    drop(t, 'critic_result', 'result', [
      { code: 'schema', path: 'result.critiques', message: 'Expected a list.' },
    ]);
    return finish('case_critic', { result: null, uncertainty }, t, 0, {
      reasoner: null,
      critic: null,
    });
  }
  const shell = checkElement('critic_result', { ...shellSource, critiques: [] }, ctx);
  if (shell.parsed === null || shell.parsed.type !== 'critic_result') {
    drop(t, 'critic_result', 'result', shell.issues);
    return finish('case_critic', { result: null, uncertainty }, t, 0, {
      reasoner: null,
      critic: null,
    });
  }
  const shellEvidence = locateAll(shell.parsed.evidence, ctx);
  if (!shellEvidence) {
    drop(t, 'critic_result', 'result', [
      {
        code: 'excerpt_not_found',
        path: 'result.evidence',
        message: 'A quotation could not be located.',
      },
    ]);
    return finish('case_critic', { result: null, uncertainty }, t, 0, {
      reasoner: null,
      critic: null,
    });
  }

  const { within, overflow } = splitOverflow(
    rawCritiques,
    PROPOSAL_LIMITS.critiques,
    'result.critiques',
  );
  t.proposed += rawCritiques.length;
  overflow.forEach((issue) => drop(t, 'critic_result', issue.path, [issue]));
  const kept: KeptCritique[] = [];
  within.forEach((element, i) => {
    const checked = validateCritique(element, ctx);
    if (checked.kept === null) drop(t, 'critic_result', `result.critiques[${i}]`, checked.issues);
    else kept.push(checked.kept);
  });

  const result_: CriticResult = { ...shell.parsed, critiques: kept.map((k) => k.critique) };
  const critic: KeptCritic = { result: result_, evidence: shellEvidence, critiques: kept };
  return finish('case_critic', { result: result_, uncertainty }, t, 1 + kept.length, {
    reasoner: null,
    critic,
  });
}

function finish<T extends CaseReasonerOutput | CaseCriticOutput>(
  agent: ProposalAgent,
  output: T,
  t: Tally,
  keptCount: number,
  parts: Pick<ProposalReport, 'reasoner' | 'critic'>,
): ValidationReport<T> {
  const citations = (kept: Pick<ProposalReport, 'reasoner' | 'critic'>): number =>
    (kept.reasoner ?? []).reduce(
      (n, k) => n + k.evidence.length + k.keyPointEvidence.reduce((m, e) => m + e.length, 0),
      0,
    ) +
    (kept.critic
      ? kept.critic.evidence.length +
        kept.critic.critiques.reduce((n, k) => n + k.evidence.length, 0)
      : 0);
  const validCitations = citations(parts);
  const stats: ValidationStats = {
    claims: t.proposed,
    supportedClaims: keptCount,
    citations: validCitations,
    validCitations,
    groundedness: t.proposed === 0 ? 1 : keptCount / t.proposed,
  };
  const proposals: ProposalReport = {
    agent,
    proposed: t.proposed,
    kept: keptCount,
    dropped: t.dropped.slice(0, MAX_LISTED_DROPPED),
    rejectedByCode: tally(t.dropped),
    wholeReply: [],
    ...parts,
  };
  return {
    ok: true,
    output,
    issues: [],
    kinds: [],
    outcome: outcomeOf(t.dropped),
    repairable: false,
    stats,
    proposals,
  };
}

/**
 * Validates the reply of a reasoning agent. Unlike every other agent's, such a reply is not accepted or rejected as a
 * whole. The reply as a whole must parse, fit the size cap and have exactly the keys of its schema (otherwise it is
 * unusable: one repair attempt, then no findings). Inside it, every proposal is checked on its own against the grounding
 * rules; one that fails any is dropped and counted by code, and the report's `output` holds the survivors, with the
 * quotations the server located itself.
 */
export function validateProposalOutput(
  agent: ProposalAgent,
  raw: unknown,
  vctx: ValidationContext,
): ValidationReport<CaseReasonerOutput | CaseCriticOutput> {
  const ctx = buildRuleContext(agent, vctx, vctx.stored ?? new Map());
  if (raw === undefined) {
    return wholeReplyFailure(
      agent,
      'schema',
      'not_json',
      'schema',
      'The model reply was not valid JSON.',
    );
  }
  let length: number;
  try {
    length = JSON.stringify(raw).length;
  } catch {
    return wholeReplyFailure(
      agent,
      'schema',
      'unserializable',
      'schema',
      'The output cannot be serialised as JSON.',
    );
  }
  if (checkReplySize(length, ctx.limits.maxOutputChars).length > 0) {
    return wholeReplyFailure(
      agent,
      'size',
      'output_too_large',
      'excessive_output',
      `The output exceeds the ${ctx.limits.maxOutputChars} character limit.`,
    );
  }
  const failure = checkEnvelope(agent, raw);
  if (failure) return failure;
  const record = raw as Record<string, unknown>;
  return agent === 'case_reasoner' ? validateReasoner(record, ctx) : validateCritic(record, ctx);
}
