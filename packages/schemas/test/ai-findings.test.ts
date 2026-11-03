import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiFindingSchema,
  CASE_CRITIC_KEYS,
  CASE_REASONER_KEYS,
  CONFIDENCE_BASES,
  CONFIDENCE_BASIS_LABELS,
  CORROBORATION_STATES,
  CORROBORATION_STATE_LABELS,
  COUNTERFACTUAL_BASES,
  CRITIQUE_KINDS,
  CRITIQUE_KIND_LABELS,
  CRITIC_VERDICTS,
  CRITIC_VERDICT_LABELS,
  CaseCriticOutputSchema,
  CaseReasonerOutputSchema,
  CaseSynthesisSchema,
  CriticResultSchema,
  ESCALATING_CRITIQUE_KINDS,
  FINDING_REVIEW_STATES,
  FINDING_REVIEW_STATE_LABELS,
  FINDING_SCHEMA_VERSION,
  FINDING_TYPES,
  FINDING_TYPE_LABELS,
  HYBRID_STATUSES,
  HYBRID_STATUS_DESCRIPTIONS,
  HYBRID_STATUS_LABELS,
  MODEL_COUNTERFACTUAL_BASES,
  PROHIBITED_MODEL_FIELDS,
  PROPOSAL_LIMITS,
  PROPOSAL_SCHEMAS,
  PROPOSAL_SCHEMA_IDS,
  ProposedCounterfactualSchema,
  ProposedMissedStepSchema,
  ProposedMissingEvidenceSchema,
  ProposedRecommendationSchema,
  ProposedSignalSchema,
  ProposedContradictionSchema,
  findProhibitedFields,
  type FindingType,
} from '../src';

const evidence = [{ eventId: 'e07', excerpt: 'Root cause is the Conditional Access policy' }];
const tail = {
  evidence,
  reasoning: 'The note states the cause as a fact.',
  confidenceBasis: 'stated_in_record',
  confidence: 'medium',
  uncertainty: { level: 'medium', note: 'One engineer note.' },
  contradictions: [],
} as const;

/** One valid example of every proposal type. */
const VALID: Record<FindingType, Record<string, unknown>> = {
  signal: {
    id: 's1',
    type: 'signal',
    statement: 'The engineer states the cause as confirmed.',
    signalId: 'sig.ca-exclusion-no-effect',
    eventId: 'e07',
    ...tail,
  },
  contradiction: {
    id: 'c1',
    type: 'contradiction',
    statement: 'The engineer calls the cause confirmed while the logs show another picture.',
    conflictClass: 'direct_contradiction',
    subject: 'root cause',
    sides: [
      { eventId: 'e07', statement: 'Root cause is the Conditional Access policy.' },
      { eventId: 'e14', statement: 'Name resolution fails before sign-in.' },
    ],
    ...tail,
  },
  missing_evidence: {
    id: 'm1',
    type: 'missing_evidence',
    statement: 'No client trace existed when the policy was blamed.',
    requirementId: 'req.client-diagnostics',
    missing: 'A client network trace from a failing attempt',
    neededByEventId: 'e08',
    ...tail,
  },
  missed_step: {
    id: 'k1',
    type: 'missed_step',
    statement: 'A DNS resolver comparison was available.',
    actionId: 'act.dns-resolver-comparison',
    step: 'Compare name resolution across the resolvers',
    decisionEventId: 'e09',
    availableEventIds: ['e04'],
    ...tail,
  },
  counterfactual: {
    id: 'f1',
    type: 'counterfactual',
    statement: 'A resolver comparison before the session revocation might have shown the pattern.',
    decisionEventId: 'e09',
    alternativeAction: 'Compare name resolution on the DNS servers',
    informationThen: 'The customer had reported a name-resolution error code.',
    expectedImmediateEffect: 'A resolver that answers differently would be visible.',
    plausibleDownstreamEffect: 'The session revocation might not have been needed.',
    feasible: 'yes',
    constraints: ['Needs the customer to run the test'],
    skillId: null,
    validationNeeded: 'Run the comparison on a failing device',
    basis: 'model_estimate',
    ...tail,
  },
  recommendation: {
    id: 'r1',
    type: 'recommendation',
    statement: 'Ask for a resolver comparison next.',
    action: 'Ask the customer to compare name resolution on every DNS server',
    rationale: 'The error code names a resolution failure.',
    ownerRole: 'support_engineer',
    priority: 'high',
    ...tail,
  },
  critic_result: {
    id: 'q1',
    type: 'critic_result',
    statement: 'Two conclusions go further than the record.',
    verdict: 'some_concerns',
    critiques: [
      {
        targetId: 'C2',
        kind: 'unsupported_claim',
        explanation: 'The note says confirmed but quotes no diagnostic output.',
        evidence,
        alternativeHypothesisId: null,
      },
    ],
    ...tail,
  },
  case_synthesis: {
    id: 'y1',
    type: 'case_synthesis',
    statement: 'The cause was named early and tested late.',
    summary: 'The engineer named a cause on day one and tested name resolution on day three.',
    keyPoints: [{ point: 'The cause was stated as confirmed.', evidence }],
    openQuestions: ['Which resolver answered differently?'],
    ...tail,
  },
};

const NO_FINDING_TAIL = {
  schemaVersion: FINDING_SCHEMA_VERSION,
  id: 'fnd_0123456789abcdef',
  evidence: [
    {
      eventId: 'e07',
      excerpt: 'Root cause is the Conditional Access policy',
      verifiedIn: 'stored_text',
      field: 'body',
      start: 21,
      end: 64,
      verified: true,
      sourceHash: 'a'.repeat(64),
    },
  ],
  deterministicCorroboration: { state: 'not_found', by: [] },
  modelOnly: true,
  validationStatus: 'passed',
  hybridStatus: 'MODEL_PROPOSED',
  reviewRequired: true,
  reviewState: 'pending',
  checks: [{ id: 'unknown_event', passed: true, detail: 'Every cited event was shown.' }],
  criticNotes: [],
  provenance: {
    agent: 'case_reasoner',
    promptVersion: '1.0.0',
    provider: 'scripted',
    model: 'scripted-test-model',
    simulated: true,
    executionId: 'exec_000001',
  },
} as const;

function finding(type: FindingType, overrides: Record<string, unknown> = {}) {
  const proposal = VALID[type];
  const { id: _id, type: _type, evidence: _evidence, ...rest } = proposal;
  const located = NO_FINDING_TAIL.evidence;
  const entries = Object.entries(rest).filter(
    ([key]) =>
      ![
        'statement',
        'reasoning',
        'confidenceBasis',
        'confidence',
        'uncertainty',
        'contradictions',
      ].includes(key),
  );
  const payload = Object.fromEntries(entries);
  // In a stored finding the quotations of a synthesis and of a critic result are the located ones.
  if (type === 'case_synthesis') {
    payload.keyPoints = (payload.keyPoints as { point: string }[]).map((k) => ({
      point: k.point,
      evidence: located,
    }));
  }
  if (type === 'critic_result') {
    payload.critiques = (payload.critiques as Record<string, unknown>[]).map((c) => ({
      ...c,
      evidence: located,
    }));
  }
  return {
    ...NO_FINDING_TAIL,
    type,
    statement: proposal.statement,
    reasoning: proposal.reasoning,
    confidenceBasis: proposal.confidenceBasis,
    confidence: proposal.confidence,
    uncertainty: proposal.uncertainty,
    contradictions: proposal.contradictions,
    payload,
    ...overrides,
  };
}

describe('versions, vocabulary and plain-language labels', () => {
  it('names the finding schema version and the eight finding types', () => {
    expect(FINDING_SCHEMA_VERSION).toBe('caseguard.ai-finding/1');
    expect(FINDING_TYPES).toEqual([
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'critic_result',
      'case_synthesis',
    ]);
    expect(Object.keys(PROPOSAL_SCHEMAS).sort()).toEqual([...FINDING_TYPES].sort());
    expect(new Set(Object.values(PROPOSAL_SCHEMA_IDS)).size).toBe(FINDING_TYPES.length);
  });

  it('has the six hybrid statuses, each with a label and a sentence a support lead can read', () => {
    expect(HYBRID_STATUSES).toEqual([
      'DETERMINISTIC',
      'MODEL_CORROBORATED',
      'MODEL_PROPOSED',
      'CONFLICTING',
      'REJECTED',
      'NEEDS_HUMAN_REVIEW',
    ]);
    for (const status of HYBRID_STATUSES) {
      expect(HYBRID_STATUS_LABELS[status]).toMatch(/^[A-Z][a-z]/);
      expect(HYBRID_STATUS_LABELS[status]).not.toMatch(/[_]|MODEL|HUMAN/);
      expect(HYBRID_STATUS_DESCRIPTIONS[status].endsWith('.')).toBe(true);
    }
    expect(new Set(HYBRID_STATUSES.map((s) => HYBRID_STATUS_LABELS[s])).size).toBe(6);
  });

  it('labels every value of every enumeration', () => {
    const complete = (values: readonly string[], labels: Record<string, string>): void => {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const label of Object.values(labels)) expect(label.length).toBeGreaterThan(3);
    };
    complete(FINDING_TYPES, FINDING_TYPE_LABELS);
    complete(CONFIDENCE_BASES, CONFIDENCE_BASIS_LABELS);
    complete(CORROBORATION_STATES, CORROBORATION_STATE_LABELS);
    complete(FINDING_REVIEW_STATES, FINDING_REVIEW_STATE_LABELS);
    complete(CRITIQUE_KINDS, CRITIQUE_KIND_LABELS);
    complete(CRITIC_VERDICTS, CRITIC_VERDICT_LABELS);
  });

  it('lets a model claim only its own estimate for a counterfactual, from the vocabulary of the engine', () => {
    expect(MODEL_COUNTERFACTUAL_BASES).toEqual(['model_estimate']);
    for (const basis of MODEL_COUNTERFACTUAL_BASES) expect(COUNTERFACTUAL_BASES).toContain(basis);
    expect(
      ProposedCounterfactualSchema.safeParse({ ...VALID.counterfactual, basis: 'model_estimate' })
        .success,
    ).toBe(true);
    for (const basis of ['measured', 'deterministic_estimate', 'illustrative', 'a_guess']) {
      expect(
        ProposedCounterfactualSchema.safeParse({ ...VALID.counterfactual, basis }).success,
      ).toBe(false);
    }
  });

  it('escalates only the six critiques that question a proposal', () => {
    expect([...ESCALATING_CRITIQUE_KINDS].sort()).toEqual(
      [
        'unsupported_claim',
        'circular_reasoning',
        'premature_closure',
        'counterfactual_overclaim',
        'uncertainty_hidden_as_fact',
        'contradiction',
      ].sort(),
    );
    for (const kind of [
      'missing_evidence',
      'alternative_explanation',
      'weak_recommendation',
      'supported',
    ] as const) {
      expect(ESCALATING_CRITIQUE_KINDS).not.toContain(kind);
    }
  });
});

describe('proposal schemas: what a model may return', () => {
  it.each(FINDING_TYPES)('accepts a complete %s proposal', (type) => {
    const parsed = PROPOSAL_SCHEMAS[type].safeParse(VALID[type]);
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it.each(FINDING_TYPES)(
    'has no optional key in %s: leaving any key out is a violation',
    (type) => {
      for (const key of Object.keys(VALID[type])) {
        const { [key]: _removed, ...without } = VALID[type];
        expect(PROPOSAL_SCHEMAS[type].safeParse(without).success, `${type} without ${key}`).toBe(
          false,
        );
      }
    },
  );

  it.each(FINDING_TYPES)(
    'refuses an unknown key in %s, at the top and inside a citation',
    (type) => {
      expect(PROPOSAL_SCHEMAS[type].safeParse({ ...VALID[type], extra: 1 }).success).toBe(false);
      const nested = {
        ...VALID[type],
        evidence: [{ ...evidence[0], offset: 3 }],
      };
      expect(PROPOSAL_SCHEMAS[type].safeParse(nested).success).toBe(false);
    },
  );

  it('carries no numeric field at all: a model states no probability and no saved minutes', () => {
    const numeric = (node: unknown, path: string): string[] => {
      if (Array.isArray(node)) return node.flatMap((n, i) => numeric(n, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return [];
      const record = node as Record<string, unknown>;
      const here =
        record.type === 'number' || record.type === 'integer' ? [path] : ([] as string[]);
      return [
        ...here,
        ...Object.entries(record).flatMap(([key, value]) => numeric(value, `${path}.${key}`)),
      ];
    };
    for (const schema of [CaseReasonerOutputSchema, CaseCriticOutputSchema]) {
      const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' });
      expect(numeric(json, '$')).toEqual([]);
    }
  });

  it('bounds every string and list the way the brief says', () => {
    const base = VALID.signal;
    const fails = (patch: Record<string, unknown>): boolean =>
      !ProposedSignalSchema.safeParse({ ...base, ...patch }).success;
    expect(fails({ statement: 'x'.repeat(PROPOSAL_LIMITS.statement + 1) })).toBe(true);
    expect(fails({ statement: 'x'.repeat(PROPOSAL_LIMITS.statement) })).toBe(false);
    expect(fails({ reasoning: 'x'.repeat(PROPOSAL_LIMITS.reasoning + 1) })).toBe(true);
    expect(fails({ evidence: [] })).toBe(true);
    const six = Array.from({ length: 6 }, () => evidence[0]);
    expect(fails({ evidence: six })).toBe(false);
    expect(fails({ evidence: [...six, evidence[0]] })).toBe(true);
    expect(fails({ evidence: [{ eventId: 'e07', excerpt: 'x'.repeat(301) }] })).toBe(true);
    const note = { eventId: 'e01', note: 'Opposes this.' };
    expect(fails({ contradictions: [note, note, note, note] })).toBe(false);
    expect(fails({ contradictions: [note, note, note, note, note] })).toBe(true);
    expect(fails({ id: 'S1' })).toBe(true);
    expect(fails({ id: '1s' })).toBe(true);
    expect(fails({ id: 'a'.repeat(33) })).toBe(true);
    expect(fails({ id: `a${'b'.repeat(31)}` })).toBe(false);
    expect(fails({ confidence: 'certain' })).toBe(true);
    expect(fails({ confidence: 0.9 })).toBe(true);
    expect(fails({ confidenceBasis: 'vibes' })).toBe(true);
  });

  it('keeps the literal type, so a proposal cannot pass as another kind', () => {
    expect(
      ProposedSignalSchema.safeParse({ ...VALID.signal, type: 'recommendation' }).success,
    ).toBe(false);
    expect(
      ProposedRecommendationSchema.safeParse({ ...VALID.recommendation, type: 'signal' }).success,
    ).toBe(false);
  });

  it('requires exactly two sides in a contradiction and a participant role or null for an owner', () => {
    const sides = VALID.contradiction.sides as unknown[];
    expect(
      ProposedContradictionSchema.safeParse({ ...VALID.contradiction, sides: [sides[0]] }).success,
    ).toBe(false);
    expect(
      ProposedContradictionSchema.safeParse({
        ...VALID.contradiction,
        sides: [...sides, sides[0]],
      }).success,
    ).toBe(false);
    expect(
      ProposedContradictionSchema.safeParse({ ...VALID.contradiction, conflictClass: 'feud' })
        .success,
    ).toBe(false);
    expect(
      ProposedRecommendationSchema.safeParse({ ...VALID.recommendation, ownerRole: null }).success,
    ).toBe(true);
    expect(
      ProposedRecommendationSchema.safeParse({ ...VALID.recommendation, ownerRole: 'the CEO' })
        .success,
    ).toBe(false);
  });

  it('lets a requirement or an action be null, and nothing else about them', () => {
    expect(
      ProposedMissingEvidenceSchema.safeParse({ ...VALID.missing_evidence, requirementId: null })
        .success,
    ).toBe(true);
    expect(
      ProposedMissedStepSchema.safeParse({ ...VALID.missed_step, actionId: null }).success,
    ).toBe(true);
    expect(
      ProposedMissedStepSchema.safeParse({
        ...VALID.missed_step,
        availableEventIds: Array(9).fill('e01'),
      }).success,
    ).toBe(false);
  });

  it('allows up to twelve critiques, a null target (refused later) and a critique without evidence (refused later)', () => {
    const critique = (VALID.critic_result.critiques as Record<string, unknown>[])[0];
    expect(
      CriticResultSchema.safeParse({
        ...VALID.critic_result,
        critiques: Array.from({ length: 12 }, () => critique),
      }).success,
    ).toBe(true);
    expect(
      CriticResultSchema.safeParse({
        ...VALID.critic_result,
        critiques: Array.from({ length: 13 }, () => critique),
      }).success,
    ).toBe(false);
    expect(
      CriticResultSchema.safeParse({
        ...VALID.critic_result,
        critiques: [{ ...critique, targetId: null, evidence: [] }],
      }).success,
    ).toBe(true);
    expect(
      CriticResultSchema.safeParse({
        ...VALID.critic_result,
        critiques: [{ ...critique, kind: 'rejected' }],
      }).success,
    ).toBe(false);
  });

  it('caps a synthesis at six key points, five open questions and 800 characters', () => {
    const point = { point: 'A point.', evidence };
    const fails = (patch: Record<string, unknown>): boolean =>
      !CaseSynthesisSchema.safeParse({ ...VALID.case_synthesis, ...patch }).success;
    expect(fails({ keyPoints: Array(6).fill(point) })).toBe(false);
    expect(fails({ keyPoints: Array(7).fill(point) })).toBe(true);
    expect(fails({ openQuestions: Array(5).fill('Why?') })).toBe(false);
    expect(fails({ openQuestions: Array(6).fill('Why?') })).toBe(true);
    expect(fails({ summary: 'x'.repeat(801) })).toBe(true);
    expect(fails({ keyPoints: [{ point: 'No quote.', evidence: [] }] })).toBe(true);
  });
});

describe('the two combined outputs', () => {
  const empty = {
    signals: [],
    contradictions: [],
    missingEvidence: [],
    missedSteps: [],
    counterfactuals: [],
    recommendations: [],
    synthesis: null,
    uncertainty: { level: 'high', note: 'Model assistance not used.' },
  };

  it('accepts the empty reasoner output and lists exactly its keys', () => {
    expect(CaseReasonerOutputSchema.safeParse(empty).success).toBe(true);
    expect(Object.keys(empty)).toEqual([...CASE_REASONER_KEYS]);
    expect(Object.keys(CaseReasonerOutputSchema.shape)).toEqual([...CASE_REASONER_KEYS]);
  });

  it('accepts one proposal of each kind and refuses an extra top-level key', () => {
    const full = {
      ...empty,
      signals: [VALID.signal],
      contradictions: [VALID.contradiction],
      missingEvidence: [VALID.missing_evidence],
      missedSteps: [VALID.missed_step],
      counterfactuals: [VALID.counterfactual],
      recommendations: [VALID.recommendation],
      synthesis: VALID.case_synthesis,
    };
    expect(CaseReasonerOutputSchema.safeParse(full).success).toBe(true);
    expect(CaseReasonerOutputSchema.safeParse({ ...full, approved: true }).success).toBe(false);
  });

  it('caps the arrays at 12, 6, 6, 6, 4 and 6', () => {
    const over = (key: string, count: number): boolean =>
      !CaseReasonerOutputSchema.safeParse({
        ...empty,
        [key]: Array.from({ length: count }, () => VALID[typeFor(key)]),
      }).success;
    const typeFor = (key: string): FindingType =>
      ({
        signals: 'signal',
        contradictions: 'contradiction',
        missingEvidence: 'missing_evidence',
        missedSteps: 'missed_step',
        counterfactuals: 'counterfactual',
        recommendations: 'recommendation',
      })[key] as FindingType;
    const caps: [string, number][] = [
      ['signals', 12],
      ['contradictions', 6],
      ['missingEvidence', 6],
      ['missedSteps', 6],
      ['counterfactuals', 4],
      ['recommendations', 6],
    ];
    for (const [key, cap] of caps) {
      expect(over(key, cap), `${key} at its cap`).toBe(false);
      expect(over(key, cap + 1), `${key} above its cap`).toBe(true);
    }
  });

  it('accepts a critic output with no result and with one result', () => {
    const note = { level: 'low', note: 'Nothing to criticise.' };
    expect(CaseCriticOutputSchema.safeParse({ result: null, uncertainty: note }).success).toBe(
      true,
    );
    expect(
      CaseCriticOutputSchema.safeParse({ result: VALID.critic_result, uncertainty: note }).success,
    ).toBe(true);
    expect(Object.keys(CaseCriticOutputSchema.shape)).toEqual([...CASE_CRITIC_KEYS]);
  });
});

describe('server-computed names a model must not write', () => {
  it('names the eight fields', () => {
    expect([...PROHIBITED_MODEL_FIELDS].sort()).toEqual(
      [
        'accepted',
        'approved',
        'deterministicCorroboration',
        'hybridStatus',
        'modelOnly',
        'reviewState',
        'status',
        'validationStatus',
      ].sort(),
    );
  });

  it.each(PROHIBITED_MODEL_FIELDS)('finds %s at any depth', (name) => {
    expect(findProhibitedFields({ [name]: true })).toEqual([name]);
    expect(findProhibitedFields({ signals: [{ id: 's1', [name]: 'x' }] })).toEqual([
      `signals[0].${name}`,
    ]);
    expect(findProhibitedFields({ a: { b: { c: [{ [name]: 1 }] } } })).toEqual([
      `a.b.c[0].${name}`,
    ]);
  });

  it('is not fooled by case, underscores or hyphens', () => {
    expect(
      findProhibitedFields({ Approved: true, review_state: 'x', 'hybrid-status': 'y' }),
    ).toEqual(['Approved', 'review_state', 'hybrid-status']);
  });

  it('leaves the fields of a proposal alone', () => {
    for (const type of FINDING_TYPES) expect(findProhibitedFields(VALID[type])).toEqual([]);
  });

  it('stays bounded for a hostile reply', () => {
    let deep: Record<string, unknown> = { approved: true };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    expect(findProhibitedFields(deep)).toEqual([]);
    const wide = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`k${i}`, { approved: i }]),
    );
    expect(findProhibitedFields(wide).length).toBeLessThanOrEqual(20);
  });
});

describe('the stored finding', () => {
  it.each(FINDING_TYPES)('accepts a complete %s finding', (type) => {
    const parsed = AiFindingSchema.safeParse(finding(type));
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('keeps the type-specific part in the payload and never accepts a stray key', () => {
    expect(AiFindingSchema.safeParse(finding('signal', { extra: 1 })).success).toBe(false);
    const bad = finding('signal');
    expect(
      AiFindingSchema.safeParse({ ...bad, payload: { ...bad.payload, extra: 1 } }).success,
    ).toBe(false);
    expect(AiFindingSchema.safeParse({ ...bad, payload: {} }).success).toBe(false);
  });

  it('names a schema version, a hybrid status and a review state from the fixed lists', () => {
    expect(AiFindingSchema.safeParse(finding('signal', { schemaVersion: 'x' })).success).toBe(
      false,
    );
    expect(AiFindingSchema.safeParse(finding('signal', { hybridStatus: 'ACCEPTED' })).success).toBe(
      false,
    );
    expect(AiFindingSchema.safeParse(finding('signal', { reviewState: 'approved' })).success).toBe(
      false,
    );
    for (const status of HYBRID_STATUSES) {
      expect(AiFindingSchema.safeParse(finding('signal', { hybridStatus: status })).success).toBe(
        true,
      );
    }
    for (const state of FINDING_REVIEW_STATES) {
      expect(AiFindingSchema.safeParse(finding('signal', { reviewState: state })).success).toBe(
        true,
      );
    }
  });

  it('requires at least one verified quotation, each with its hash', () => {
    expect(AiFindingSchema.safeParse(finding('signal', { evidence: [] })).success).toBe(false);
    const quote = finding('signal').evidence[0];
    expect(
      AiFindingSchema.safeParse(finding('signal', { evidence: [{ ...quote, verified: false }] }))
        .success,
    ).toBe(false);
    expect(
      AiFindingSchema.safeParse(finding('signal', { evidence: [{ ...quote, sourceHash: 'abc' }] }))
        .success,
    ).toBe(false);
  });

  it('ties offsets to where the quotation was verified', () => {
    const quote = finding('signal').evidence[0];
    const asView = { ...quote, verifiedIn: 'redacted_view', field: null, start: null, end: null };
    expect(AiFindingSchema.safeParse(finding('signal', { evidence: [asView] })).success).toBe(true);
    expect(
      AiFindingSchema.safeParse(finding('signal', { evidence: [{ ...asView, start: 3 }] })).success,
    ).toBe(false);
    expect(
      AiFindingSchema.safeParse(
        finding('signal', { evidence: [{ ...quote, field: null, start: null, end: null }] }),
      ).success,
    ).toBe(false);
  });

  it('records where it came from, and says when it is simulated', () => {
    const f = AiFindingSchema.parse(finding('signal'));
    expect(f.provenance.provider).toBe('scripted');
    expect(f.provenance.simulated).toBe(true);
    expect(
      AiFindingSchema.safeParse(
        finding('signal', { provenance: { ...NO_FINDING_TAIL.provenance, model: '' } }),
      ).success,
    ).toBe(false);
  });
});
