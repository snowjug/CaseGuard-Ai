import {
  PROPOSAL_SCHEMAS,
  type AiFindingEvidence,
  type AiFindingProvenance,
  type AnyProposal,
  type CaseReasonerOutput,
  type CriticResult,
  type FindingType,
  type ProposedCitation,
  type ReasonerProposal,
} from '@caseguard/schemas';
import { defaultInjectionScanner } from '../../src';
import type { RuleContext, RuleEvent } from '../../src/reasoning/context';
import { locateCitation } from '../../src/reasoning/locate';
import type { KeptProposal } from '../../src/reasoning/types';
import { wordShingles } from '../../src/util/text';
import type { LeakGuard } from '../../src/validators/types';

/**
 * A small synthetic case, as plain data: the rules are tested without the engine. Events e1 to e5 are the ones the
 * model was shown; e6 happened after the boundary and was not shown. The text is invented.
 */
const BASE = Date.parse('2026-03-09T09:00:00.000Z');

/** The provenance every fixture finding carries: a scripted provider, simulated. */
export const PROVENANCE: AiFindingProvenance = {
  agent: 'case_reasoner',
  promptVersion: '1.0.0',
  provider: 'scripted',
  model: 'scripted-test-model',
  simulated: true,
  executionId: 'exec_000001',
};

interface Spec {
  id: string;
  minutes: number;
  title: string | null;
  body: string;
}

const SPECS: Spec[] = [
  {
    id: 'e1',
    minutes: 0,
    title: 'Sign-in failing for branch users',
    body: 'Users at the Pune office cannot sign in to Teams. The error code is caa82ee7 and the sign-in page never finishes loading.',
  },
  {
    id: 'e2',
    minutes: 30,
    title: 'Initial triage',
    body: 'Likely a Conditional Access policy issue. I will pull the sign-in logs for the affected users tomorrow.',
  },
  {
    id: 'e3',
    minutes: 90,
    title: 'Findings from sign-in logs',
    body: 'The sign-in log shows AADSTS50076 for the three sample users. We did not capture a HAR file.',
  },
  {
    id: 'e4',
    minutes: 150,
    title: 'Revoke sign-in sessions',
    body: 'Revoked sign-in sessions for the 140 affected users so that everyone must sign in again.',
  },
  {
    id: 'e5',
    minutes: 210,
    title: 'Customer update',
    body: 'We cleared the Teams cache on five PCs and the failures continue with the same pattern.',
  },
  {
    id: 'e6',
    minutes: 300,
    title: 'Name resolution test',
    body: 'The resolver at 10.20.30.40 returned stale records for the identity endpoint.',
  },
];

const stamp = (spec: Spec, index: number) => ({
  at: new Date(BASE + spec.minutes * 60_000).toISOString(),
  sequence: index,
});

/** The events the model was shown (e1 to e5). `shown` text equals the stored text unless a test says otherwise. */
export function ruleEvents(): RuleEvent[] {
  return SPECS.slice(0, 5).map((spec, index) => ({
    id: spec.id,
    ...stamp(spec, index),
    shownTitle: spec.title,
    shownText: spec.body,
    storedTitle: spec.title,
    storedBody: spec.body,
  }));
}

export const FUTURE_EVENT_ID = 'e6';
export const FUTURE_TEXT = SPECS[5]?.body ?? '';

export const VOCABULARY = {
  signals: new Set([
    'sig.error-name-not-resolved',
    'sig.mfa-ca-events-in-logs',
    'sig.cache-clear-no-effect',
  ]),
  actions: new Set([
    'act.dns-resolver-comparison',
    'act.request-har-capture',
    'act.revoke-user-sessions',
  ]),
  requirements: new Set(['req.client-diagnostics', 'req.error-code']),
  hypotheses: new Set(['hyp.dns-resolution', 'hyp.conditional-access']),
  skills: new Set<string>(),
};

const leakGuard: LeakGuard = {
  futureEventIds: new Set([FUTURE_EVENT_ID]),
  futureEvidenceIds: new Set(),
  futureTokens: new Set(['10.20.30.40']),
  futureShingles: wordShingles(FUTURE_TEXT, 6),
};

/** A rule context over the fixture case. Pass overrides to change one thing. */
export function ruleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    agent: 'case_reasoner',
    events: new Map(ruleEvents().map((e) => [e.id, e])),
    futureEventIds: new Set([FUTURE_EVENT_ID]),
    leakGuard,
    vocabulary: VOCABULARY,
    policy: {
      riskCeiling: 0.5,
      actions: new Map([
        [
          'act.dns-resolver-comparison',
          { destructive: false, requiresApproval: false, operationalRisk: 0.05 },
        ],
        [
          'act.request-har-capture',
          { destructive: false, requiresApproval: false, operationalRisk: 0.05 },
        ],
        [
          'act.revoke-user-sessions',
          { destructive: true, requiresApproval: true, operationalRisk: 0.7 },
        ],
      ]),
    },
    conclusionIds: new Set(['C1', 'C2', 'C3']),
    scanInjection: defaultInjectionScanner,
    injection: {
      allText: SPECS.map((s) => `${s.title ?? ''} ${s.body}`)
        .join(' ')
        .toLowerCase(),
      promptGuard: { templateShingles: new Set(), nonce: 'abcdef0123456789' },
    },
    limits: { maxOutputChars: 64_000 },
    ...overrides,
  };
}

const tail = (excerpt: string, eventId = 'e3') => ({
  evidence: [{ eventId, excerpt }],
  reasoning: 'The record states it directly.',
  confidenceBasis: 'stated_in_record' as const,
  confidence: 'medium' as const,
  uncertainty: { level: 'low' as const, note: 'One event states it.' },
  contradictions: [] as { eventId: string; note: string }[],
});

/** One valid, grounded proposal of each reasoner type over the fixture case. */
export const VALID_PROPOSALS = {
  signal: {
    id: 's1',
    type: 'signal',
    statement: 'The sign-in log shows an MFA-required error for the sample users.',
    signalId: 'sig.mfa-ca-events-in-logs',
    eventId: 'e3',
    ...tail('The sign-in log shows AADSTS50076 for the three sample users.'),
  },
  contradiction: {
    id: 'c1',
    type: 'contradiction',
    statement:
      'The triage names a policy issue while the customer reports a name-resolution error.',
    conflictClass: 'unresolved_conflict',
    subject: 'cause of the failures',
    sides: [
      { eventId: 'e2', statement: 'The engineer suspects a Conditional Access policy.' },
      { eventId: 'e1', statement: 'The customer reports a name-resolution style error code.' },
    ],
    ...tail('The error code is caa82ee7 and the sign-in page never finishes loading.', 'e1'),
  },
  missing_evidence: {
    id: 'm1',
    type: 'missing_evidence',
    statement: 'No client trace had been captured when sessions were revoked.',
    requirementId: 'req.client-diagnostics',
    missing: 'A client network trace from a failing attempt',
    neededByEventId: 'e4',
    ...tail('We did not capture a HAR file.'),
  },
  missed_step: {
    id: 'k1',
    type: 'missed_step',
    statement: 'A resolver comparison was available before the sessions were revoked.',
    actionId: 'act.dns-resolver-comparison',
    step: 'Compare name resolution across the resolvers',
    decisionEventId: 'e4',
    availableEventIds: ['e1'],
    ...tail('The error code is caa82ee7 and the sign-in page never finishes loading.', 'e1'),
  },
  counterfactual: {
    id: 'f1',
    type: 'counterfactual',
    statement: 'Comparing resolvers before revoking sessions might have shown the pattern.',
    decisionEventId: 'e4',
    alternativeAction: 'Compare name resolution on the DNS servers',
    informationThen: 'The customer had reported a name-resolution style error code.',
    expectedImmediateEffect: 'A resolver that answers differently would be visible.',
    plausibleDownstreamEffect: 'The session revocation might not have been needed.',
    feasible: 'yes',
    constraints: ['The customer has to run the test'],
    skillId: null,
    validationNeeded: 'Run the comparison on a failing device',
    basis: 'model_estimate',
    ...tail('The error code is caa82ee7 and the sign-in page never finishes loading.', 'e1'),
  },
  recommendation: {
    id: 'r1',
    type: 'recommendation',
    statement: 'Ask for a client trace next.',
    action: 'Ask the customer for a HAR capture from one failing sign-in',
    rationale: 'No client trace exists in the record.',
    ownerRole: 'support_engineer',
    priority: 'high',
    ...tail('We did not capture a HAR file.'),
  },
  case_synthesis: {
    id: 'y1',
    type: 'case_synthesis',
    statement: 'A cause was named early and tested late.',
    summary:
      'The engineer named a policy cause at triage and revoked sessions before any client trace existed.',
    keyPoints: [
      {
        point: 'The cause was named at triage.',
        evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
      },
    ],
    openQuestions: ['Which resolver answered differently?'],
    ...tail('Revoked sign-in sessions for the 140 affected users', 'e4'),
  },
} as const satisfies Record<ReasonerProposal['type'], unknown>;

/** A deep copy of a valid proposal, typed loosely so a test can break it. */
export function proposal<T extends ReasonerProposal['type']>(
  type: T,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...structuredClone(VALID_PROPOSALS[type] as unknown as Record<string, unknown>),
    ...patch,
  };
}

/** A proposal that matches its schema (so the rules that read a parsed proposal can run), with a patch applied first. */
export function parsed(
  type: ReasonerProposal['type'],
  patch: Record<string, unknown> = {},
): ReasonerProposal {
  return PROPOSAL_SCHEMAS[type].parse(proposal(type, patch)) as ReasonerProposal;
}

export const VALID_CRITIC_RESULT = {
  id: 'q1',
  type: 'critic_result',
  statement: 'One conclusion goes further than the record.',
  verdict: 'some_concerns',
  critiques: [
    {
      targetId: 'C1',
      kind: 'unsupported_claim',
      explanation: 'The triage names a cause as likely while no log had been read.',
      evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
      alternativeHypothesisId: null,
    },
    {
      targetId: 'C2',
      kind: 'alternative_explanation',
      explanation: 'The error code points at name resolution.',
      evidence: [{ eventId: 'e1', excerpt: 'The error code is caa82ee7' }],
      alternativeHypothesisId: 'hyp.dns-resolution',
    },
  ],
  ...tail('Likely a Conditional Access policy issue.', 'e2'),
} as const;

export function criticResult(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(VALID_CRITIC_RESULT as unknown as Record<string, unknown>),
    ...patch,
  };
}

/** A whole reasoner reply with the given proposals filed under their lists. */
export function reasonerReply(
  items: {
    signals?: unknown[];
    contradictions?: unknown[];
    missingEvidence?: unknown[];
    missedSteps?: unknown[];
    counterfactuals?: unknown[];
    recommendations?: unknown[];
    synthesis?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    signals: [],
    contradictions: [],
    missingEvidence: [],
    missedSteps: [],
    counterfactuals: [],
    recommendations: [],
    synthesis: null,
    uncertainty: { level: 'medium', note: 'Scripted test reply.' },
    ...items,
  };
}

export type { AnyProposal, CaseReasonerOutput, CriticResult, FindingType };

/**
 * A kept proposal as the validator would hand it to the policy: every quotation located in the fixture events.
 * Throws when a quotation cannot be located, so a fixture error shows up as one.
 */
export function keptOf(
  proposalToKeep: ReasonerProposal,
  ctx: RuleContext = ruleContext(),
): KeptProposal {
  const locate = (citations: readonly ProposedCitation[]): AiFindingEvidence[] =>
    citations.map((citation) => {
      const event = ctx.events.get(citation.eventId);
      const located = event ? locateCitation(event, citation) : null;
      if (!located) throw new Error(`Fixture quotation not found in ${citation.eventId}`);
      return located;
    });
  return {
    proposal: proposalToKeep,
    evidence: locate(proposalToKeep.evidence),
    keyPointEvidence:
      proposalToKeep.type === 'case_synthesis'
        ? proposalToKeep.keyPoints.map((point) => locate(point.evidence))
        : [],
    checks: [],
    notes: [],
  };
}

/** A kept proposal built from a valid fixture of the given type, with a patch applied first. */
export const keptFixture = (
  type: ReasonerProposal['type'],
  patch: Record<string, unknown> = {},
): KeptProposal => keptOf(parsed(type, patch));
