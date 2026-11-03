import { describe, expect, it } from 'vitest';
import {
  SKILL_QUALITY_DIMENSIONS,
  SkillQualityAssessmentSchema,
  SkillUseAssessmentSchema,
  type SkillCondition,
  type SkillContent,
  type SkillDna,
  type SkillMatch,
} from '@caseguard/schemas';
import {
  STALE_AFTER_DAYS,
  assessSkillQuality,
  assessSkillUse,
  type CompiledPack,
  type SkillQualityInput,
} from '../src';
import { CONFIG, NOW, type Prepared } from './helpers';
import {
  IRRELEVANT,
  ONE,
  TWO,
  asOf,
  draftAggregate,
  first,
  matchAt,
  matchableOf,
  publishedAggregate,
  versionOf,
} from './skills-fixtures';

const published = publishedAggregate();
const draft = draftAggregate();
const content = versionOf(published).content;
const DAY = 86_400_000;
const daysBefore = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

type Aggregate = typeof published;

function inputFor(
  aggregate: Aggregate,
  over: {
    skill?: Partial<SkillDna>;
    content?: Partial<SkillContent>;
    version?: Partial<SkillQualityInput['version']>;
    library?: SkillQualityInput['library'];
    tenantId?: string;
  } = {},
): SkillQualityInput {
  const version = versionOf(aggregate);
  return {
    skill: { ...aggregate.skill, ...over.skill },
    version: { ...version, ...over.version, content: { ...version.content, ...over.content } },
    pack: ONE.pack,
    library: over.library ?? [],
    now: NOW,
    tenantId: over.tenantId ?? aggregate.skill.tenantId,
  };
}

const assess = (over: Parameters<typeof inputFor>[1] = {}, aggregate: Aggregate = published) =>
  assessSkillQuality(inputFor(aggregate, over));
const ratingOf = (
  result: ReturnType<typeof assess>,
  id: (typeof SKILL_QUALITY_DIMENSIONS)[number],
) => result.dimensions.find((d) => d.id === id)?.rating;
const kinds = (result: ReturnType<typeof assess>): string[] =>
  result.issues.map((issue) => `${issue.severity}:${issue.kind}`);

const withStep = (patch: Partial<SkillContent['decisionSequence'][number]>, index = 0) =>
  content.decisionSequence.map((step, i) => (i === index ? { ...step, ...patch } : step));

describe('SkillDNA quality: the twelve dimensions on a real skill', () => {
  const result = assess();

  it('rates every dimension, in order, with a reason, and satisfies the contract', () => {
    expect(() => SkillQualityAssessmentSchema.parse(result)).not.toThrow();
    expect(result.dimensions.map((d) => d.id)).toEqual([...SKILL_QUALITY_DIMENSIONS]);
    for (const dimension of result.dimensions) expect(dimension.findings.length).toBeGreaterThan(0);
  });

  it('a published skill that passed every gate still needs work: nothing shows it helped, and its cause rests on one case', () => {
    expect(result.verdict).toBe('needs_work');
    expect(ratingOf(result, 'governance_status')).toBe('strong');
    expect(ratingOf(result, 'effectiveness_evidence')).toBe('missing');
    expect(ratingOf(result, 'evidence_basis')).toBe('adequate');
    expect(kinds(result)).toEqual(['warning:unsupported_causal_claim']);
    expect(result.summary).toMatch(/^Needs work before it is relied on: 1 warning, 1 missing\./);
  });

  it('example addresses in the pack’s own templates are not case data', () => {
    expect(JSON.stringify(content.queryTemplates)).toMatch(/10\.0\.0\.10/);
    expect(kinds(result)).not.toContain('blocking:case_specific_data');
  });

  it('a draft is also held back by its review status, and says who is missing', () => {
    const asDraft = assess({}, draft);
    expect(ratingOf(asDraft, 'governance_status')).toBe('missing');
    expect(
      asDraft.dimensions.find((d) => d.id === 'governance_status')?.findings.join(' '),
    ).toMatch(/No reviewer other than its owner/);
  });

  it('is a pure function: the same skill gives the same answer and nothing is changed', () => {
    const input = inputFor(published);
    const before = JSON.stringify(input);
    expect(assessSkillQuality(input)).toEqual(assessSkillQuality(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('can reach "ready": a skill with a second source case, three validated cases and measured applications', () => {
    const ready = assess({
      skill: {
        effectiveness: {
          ...published.skill.effectiveness,
          applications: 6,
          matchedCases: 6,
          synthetic: false,
          precedent: {
            cases: 2,
            references: ['CG-1', 'CG-2'],
            avgTimeToDiagnosisMinutes: 180,
            precedentAvgTimeToDiagnosisMinutes: 2994,
            tokenChangePct: -20,
            evidenceCompletenessPoints: 10,
            basis: 'Different cases, no control group.',
          },
        },
        synthetic: false,
      },
      content: {
        sourceCases: [
          ...content.sourceCases,
          { caseId: 'case_validation_1', reference: 'CG-2', role: 'validation' },
        ],
        applicability: {
          scope: 'Intermittent Teams sign-in failures across sites.',
          validatedOnCases: 3,
          limitations: ['Not validated for a single device.'],
        },
      },
    });
    expect(result.verdict).not.toBe('ready');
    expect(ready.issues).toEqual([]);
    expect(ready.dimensions.filter((d) => d.rating !== 'strong').map((d) => d.id)).toEqual([]);
    expect(ready).toMatchObject({
      verdict: 'ready',
      summary: 'Nothing stands in the way of reusing it.',
    });
  });
});

describe('SkillDNA quality: what a reusable skill must not contain', () => {
  // Built from parts so that no token-shaped literal is stored in the repository.
  const FAKE_JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJl'].join(
    '.',
  );
  const instructionWith = (text: string) =>
    assess({ content: { decisionSequence: withStep({ instruction: text }, 1) } });

  it('a customer’s address, mailbox, identifier, token or password blocks the skill, and is never repeated', () => {
    const cases: [string, string, string][] = [
      ['Ask whether resolver 10.20.1.11 answers.', 'an IP address', '10.20.1.11'],
      ['Write to jan.kowalski@contoso-fictional.example first.', 'an e-mail address', 'kowalski'],
      [
        'Look up 3f2b8c1e-4a5d-4e6f-9a7b-0c1d2e3f4a5b in the logs.',
        'an identifier (GUID)',
        '3f2b8c1e',
      ],
      [`Use ${FAKE_JWT} as the bearer.`, 'a token', 'eyJhbGci'],
      ['Sign in with password=Hunter2Hunter2 to test.', 'a secret or password', 'Hunter2'],
      [
        'The thumbprint is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.',
        'a long hexadecimal value',
        '9f86d081',
      ],
    ];
    for (const [text, kind, value] of cases) {
      const found = instructionWith(text);
      expect(kinds(found), text).toContain('blocking:case_specific_data');
      expect(found.verdict, text).toBe('blocked');
      const issue = found.issues.find(
        (i) => i.kind === 'case_specific_data' && i.message.includes(kind),
      );
      expect(issue, kind).toBeDefined();
      expect(issue?.message, kind).toMatch(/in step 2/);
      expect(JSON.stringify(found), `${kind} must not be echoed`).not.toContain(value);
    }
  });

  it('an example, a documentation address, a public resolver or a placeholder is not case data', () => {
    for (const text of [
      'List the resolvers, for example "10.0.0.10" and "10.0.0.11".',
      'Test against 203.0.113.9 (a documentation address).',
      'Compare with 8.8.8.8 as a control.',
      'Run with -Server {{resolver_list}} and password={{secret}}.',
    ]) {
      expect(kinds(instructionWith(text)), text).not.toContain('blocking:case_specific_data');
    }
  });

  it('a skill that would match almost any case is blocked as too generic', () => {
    const text: SkillCondition = {
      id: 'trg-text',
      description: 'A sign-in problem',
      kind: 'text',
      pattern: 'sign.?in',
      weight: 0.5,
      required: false,
    };
    const generic = assess({ content: { triggerConditions: [text] } });
    expect(kinds(generic)).toContain('blocking:too_generic');
    expect(generic.verdict).toBe('blocked');
    expect(ratingOf(generic, 'specificity')).toBe('weak');
    expect(ratingOf(generic, 'false_positive_risk')).toBe('weak');
    expect(ratingOf(generic, 'trigger_conditions')).toBe('weak');
  });

  it('a general-guide name with one telling trigger is a warning, not a block', () => {
    const one = content.triggerConditions.filter((c) => c.required).slice(0, 1);
    const named = assess({
      content: { name: 'General troubleshooting guide for Teams', triggerConditions: one },
    });
    expect(kinds(named)).toContain('warning:too_generic');
    expect(kinds(named)).not.toContain('blocking:too_generic');
  });

  it('a skill learned with the recorded cause must say which parts, and a required trigger from the cause is flagged', () => {
    const provenance = content.provenance;
    if (provenance === undefined) throw new Error('the seed skill records its provenance');
    const undisclosed = assess({
      content: { provenance: { ...provenance, hindsight: { ...provenance.hindsight, parts: [] } } },
    });
    expect(kinds(undisclosed)).toContain('blocking:unsupported_causal_claim');

    const fromCause = assess({
      content: {
        triggerConditions: content.triggerConditions.map((c, i) =>
          i === 0
            ? { ...c, required: true, description: `${c.description} (hindsight-informed)` }
            : c,
        ),
      },
    });
    expect(fromCause.issues.map((i) => i.message).join(' ')).toMatch(
      /learned from the recorded cause/,
    );
  });

  it('a cause stated as general needs more than one source case behind it', () => {
    const states = {
      description: 'Intermittent sign-in failures are caused by one resolver dropping answers.',
    };
    expect(kinds(assess({ content: states }))).toContain('warning:unsupported_causal_claim');
    const backed = assess({
      content: {
        ...states,
        knownFailureModes: [],
        sourceCases: [
          ...content.sourceCases,
          { caseId: 'case_validation_1', reference: 'CG-2', role: 'validation' },
        ],
      },
    });
    expect(backed.issues.map((i) => i.message).join(' ')).not.toMatch(/rests on a single case/);
  });

  it('a branch that carries only a probability given the recorded cause is flagged', () => {
    const steps = content.decisionSequence.map((step) => ({
      ...step,
      branches: step.branches.map(({ probability: _decisionTime, ...branch }) => ({
        ...branch,
        hindsightProbability: 0.9,
      })),
    }));
    const flagged = assess({ content: { decisionSequence: steps } });
    expect(flagged.issues.map((i) => i.message).join(' ')).toMatch(
      /carry only a probability given the recorded cause/,
    );
  });
});

describe('SkillDNA quality: against the rest of the library', () => {
  const lib = (
    over: Partial<Pick<SkillDna, 'id' | 'tenantId' | 'workload' | 'lifecycle' | 'name'>>,
    patch: Partial<SkillContent> = {},
  ) => ({
    skill: {
      id: 'skl_other',
      tenantId: published.skill.tenantId,
      workload: published.skill.workload,
      lifecycle: 'validated' as const,
      name: 'Another skill',
      ...over,
    },
    content: { ...content, ...patch },
  });

  it('the same situation with the same first step is a duplicate, and blocks when nothing differs', () => {
    const exact = assess({ library: [lib({ name: 'A copy' })] });
    expect(exact.issues).toContainEqual(
      expect.objectContaining({
        kind: 'duplicate',
        severity: 'blocking',
        relatedSkillId: 'skl_other',
      }),
    );
    const extra: SkillCondition = {
      id: 'trg-extra',
      description: 'A site is affected',
      kind: 'signal',
      signalId: 'sig.single-user-scope',
      weight: 0.1,
      required: false,
    };
    const near = assess({
      library: [lib({}, { triggerConditions: [...content.triggerConditions, extra] })],
    });
    expect(near.issues).toContainEqual(
      expect.objectContaining({ kind: 'duplicate', severity: 'warning' }),
    );
  });

  it('the same situation with another first step is contradictory guidance, named for a reviewer to settle', () => {
    const other = assess({
      library: [
        lib(
          { name: 'Check service health first' },
          { decisionSequence: withStep({ actionKey: 'act.check-service-health' }) },
        ),
      ],
    });
    expect(other.issues).toContainEqual(
      expect.objectContaining({
        kind: 'contradictory',
        severity: 'warning',
        relatedSkillId: 'skl_other',
      }),
    );
    expect(other.issues.find((i) => i.kind === 'contradictory')?.message).toMatch(
      /Check service health first/,
    );
  });

  it('a different situation, itself, a retired skill, another tenant or another workload is no duplicate', () => {
    const fewer = content.triggerConditions.slice(0, 3);
    const unrelated = [
      lib({ id: 'skl_fewer' }, { triggerConditions: fewer }),
      lib({ id: published.skill.id }),
      lib({ id: 'skl_retired', lifecycle: 'retired' }),
      lib({ id: 'skl_deprecated', lifecycle: 'deprecated' }),
      lib({ id: 'skl_tenant', tenantId: 'tenant_other' }),
      lib({ id: 'skl_workload', workload: 'another-workload' }),
    ];
    expect(assess({ library: unrelated }).issues.map((i) => i.kind)).not.toContain('duplicate');
    expect(assess({ library: unrelated }).issues.map((i) => i.kind)).not.toContain('contradictory');
  });
});

describe('SkillDNA quality: stale skills and other tenants', () => {
  it('a skill in use is flagged after the validation limit, or when it was never dated, and a draft is not', () => {
    const fresh = assess({ skill: { lastValidatedAt: daysBefore(STALE_AFTER_DAYS - 1) } });
    expect(kinds(fresh)).not.toContain('warning:stale');
    const old = assess({ skill: { lastValidatedAt: daysBefore(STALE_AFTER_DAYS + 20) } });
    expect(old.issues.find((i) => i.kind === 'stale')?.message).toMatch(
      new RegExp(`${STALE_AFTER_DAYS + 20} days ago \\(the limit is ${STALE_AFTER_DAYS}\\)`),
    );
    expect(kinds(assess({ skill: { lastValidatedAt: null } }))).toContain('warning:stale');
    expect(kinds(assess({ skill: { lastValidatedAt: null } }, draft))).not.toContain(
      'warning:stale',
    );
    expect(
      kinds(assess({ skill: { lifecycle: 'deprecated', lastValidatedAt: daysBefore(999) } })),
    ).not.toContain('warning:stale');
  });

  it('a skill of another organisation is blocked, whatever else is true of it', () => {
    const foreign = assess({ tenantId: 'tenant_other' });
    expect(kinds(foreign)).toContain('blocking:cross_tenant');
    expect(foreign.verdict).toBe('blocked');
    expect(foreign.summary).toMatch(/^Do not suggest it yet: 1 blocking issue/);
  });
});

describe('SkillDNA quality: single dimensions', () => {
  it('an action the knowledge pack does not have makes the recommended action weak', () => {
    const unknown = assess({
      content: { decisionSequence: withStep({ actionKey: 'act.does-not-exist' }) },
    });
    expect(ratingOf(unknown, 'expected_action')).toBe('weak');
    expect(unknown.dimensions.find((d) => d.id === 'expected_action')?.findings.join(' ')).toMatch(
      /1 step name an action the knowledge pack does not have/,
    );
  });

  it('a text condition that can backtrack is not run, and a signal the pack lacks is named', () => {
    const risky: SkillCondition = {
      id: 'trg-risky',
      description: 'x',
      kind: 'text',
      pattern: '(a+)+$',
      weight: 0.5,
      required: false,
    };
    const unknownSignal: SkillCondition = {
      id: 'trg-unknown',
      description: 'y',
      kind: 'signal',
      signalId: 'sig.not-in-the-pack',
      weight: 0.5,
      required: false,
    };
    const result = assess({
      content: { triggerConditions: [...content.triggerConditions, risky, unknownSignal] },
    });
    expect(ratingOf(result, 'trigger_conditions')).not.toBe('strong');
    const findings =
      result.dimensions.find((d) => d.id === 'trigger_conditions')?.findings.join(' ') ?? '';
    expect(findings).toMatch(/1 text condition cannot be run safely/);
    expect(findings).toMatch(/name a signal the knowledge pack does not have/);
  });

  it('a skill that says nothing about what it needs, or where it must not be used, is rated for that', () => {
    const bare = assess({
      content: {
        requiredInputs: [],
        minimumEvidence: [],
        exclusions: [],
        stopConditions: [],
        escalationConditions: [],
      },
    });
    expect(ratingOf(bare, 'required_context')).toBe('missing');
    expect(ratingOf(bare, 'prohibited_context')).toBe('weak');
    expect(bare.dimensions.find((d) => d.id === 'false_positive_risk')?.findings.join(' ')).toMatch(
      /no exclusion/,
    );
  });

  it('a version that is only proposed is weak, and one that was rejected or replaced is missing', () => {
    expect(ratingOf(assess({ version: { state: 'proposed' } }), 'version')).toBe('weak');
    expect(ratingOf(assess({ version: { state: 'rejected' } }), 'version')).toBe('missing');
    expect(ratingOf(assess({ version: { state: 'superseded' } }), 'version')).toBe('missing');
  });

  it('review by its own owner is not independent review', () => {
    const own = assess({ skill: { reviewer: published.skill.owner } });
    expect(ratingOf(own, 'governance_status')).toBe('adequate');
    expect(own.dimensions.find((d) => d.id === 'governance_status')?.findings.join(' ')).toMatch(
      /No reviewer other than its owner/,
    );
  });

  it('applications on synthetic cases are counted but never called evidence that it helps', () => {
    const synthetic = assess({
      skill: {
        effectiveness: {
          ...published.skill.effectiveness,
          applications: 9,
          matchedCases: 9,
          synthetic: true,
        },
      },
    });
    expect(ratingOf(synthetic, 'effectiveness_evidence')).toBe('adequate');
    expect(
      synthetic.dimensions.find((d) => d.id === 'effectiveness_evidence')?.findings.join(' '),
    ).toMatch(/show the pipeline works, not that the skill helps/);
  });
});

describe('SkillDNA applicability: evaluation cases for the five answers', () => {
  const skill = matchableOf(published);
  const matchOf = (p: Prepared, suffix: string): SkillMatch =>
    first(matchAt(p, asOf(p, suffix), [skill]).matches);
  const packWith = (
    key: string,
    patch: Partial<CompiledPack['actions'] extends ReadonlyMap<string, infer A> ? A : never>,
  ): CompiledPack => {
    const action = ONE.pack.actions.get(key);
    if (action === undefined) throw new Error(`no action ${key}`);
    return { ...ONE.pack, actions: new Map(ONE.pack.actions).set(key, { ...action, ...patch }) };
  };
  const use = (match: SkillMatch, over: { pack?: CompiledPack; content?: SkillContent } = {}) => {
    const result = assessSkillUse({
      match,
      content: over.content ?? content,
      pack: over.pack ?? ONE.pack,
      riskCeiling: CONFIG.riskCeiling,
    });
    expect(() => SkillUseAssessmentSchema.parse(result)).not.toThrow();
    return result;
  };
  const nextKey = (match: SkillMatch): string => {
    const key = match.recommendedSteps.find(
      (step) => step.status === 'recommended_next',
    )?.actionKey;
    if (key === undefined || key === null) throw new Error('the match recommends no next step');
    return key;
  };

  describe('the skill applies', () => {
    it('a later case that shows the same signals: the second sample at its first event', () => {
      const match = matchOf(TWO, 'g01');
      expect(match.applicability).toBe('applies');
      expect(use(match).verdict).toBe('applies');
    });
    it('the case it came from, once its signals are in', () => {
      const match = matchOf(ONE, 'e04');
      expect(use(match).verdict).toBe('applies');
    });
  });

  describe('the skill partly applies', () => {
    it('the case it came from before its second required trigger has appeared', () => {
      for (const suffix of ['e01', 'e03']) {
        const match = matchOf(ONE, suffix);
        expect(match.applicability, suffix).toBe('partial');
        expect(use(match).verdict, suffix).toBe('partially_applies');
      }
    });
  });

  describe('the skill does not apply', () => {
    it('a one-laptop case that shares nothing with it', () => {
      const match = matchOf(IRRELEVANT, 'x02');
      expect(match.applicability).toBe('not_applicable');
      expect(use(match).verdict).toBe('does_not_apply');
    });
    it('a situation where it must not be used holds, even though most triggers do', () => {
      const match = {
        ...matchOf(TWO, 'g01'),
        exclusionsHit: [{ id: 'exc-single', description: 'Only one user is affected' }],
      };
      const result = use(match);
      expect(result.verdict).toBe('does_not_apply');
      expect(result.reasons[0]).toMatch(/Only one user is affected/);
    });
    it('a required trigger does not hold, even when the match is partial', () => {
      const required = first(content.triggerConditions.filter((c) => c.required));
      const match: SkillMatch = {
        ...matchOf(ONE, 'e03'),
        unmatchedTriggers: [
          { id: required.id, description: required.description, weight: required.weight },
        ],
      };
      const result = use(match);
      expect(result.verdict).toBe('does_not_apply');
      expect(result.reasons[0]).toMatch(/A required trigger does not hold/);
    });
  });

  describe('the skill is unsafe to apply', () => {
    const match = matchOf(TWO, 'g01');
    it('its next step changes or removes something', () => {
      const result = use(match, { pack: packWith(nextKey(match), { destructive: true }) });
      expect(result.verdict).toBe('unsafe_to_apply');
      expect(result.reasons[0]).toMatch(/changes or removes something/);
    });
    it('its next step is at the risk ceiling', () => {
      const result = use(match, {
        pack: packWith(nextKey(match), { operationalRisk: CONFIG.riskCeiling }),
      });
      expect(result.verdict).toBe('unsafe_to_apply');
      expect(result.reasons[0]).toMatch(/at or above the risk ceiling/);
    });
    it('the skill itself rates the step high risk and asks for no approval', () => {
      const risky: SkillContent = {
        ...content,
        candidateActions: content.candidateActions.map((c) =>
          c.actionKey === nextKey(match) ? { ...c, risk: 'high', requiresApproval: false } : c,
        ),
      };
      expect(use(match, { content: risky }).verdict).toBe('unsafe_to_apply');
    });
  });

  describe('applying the skill needs approval', () => {
    const match = matchOf(TWO, 'g01');
    it('the skill asks for approval before its next step', () => {
      const approval: SkillContent = {
        ...content,
        candidateActions: content.candidateActions.map((c) =>
          c.actionKey === nextKey(match) ? { ...c, requiresApproval: true } : c,
        ),
      };
      const result = use(match, { content: approval });
      expect(result.verdict).toBe('requires_approval');
      expect(result.reasons[0]).toMatch(/needs approval before it is run/);
    });
    it('the knowledge pack says the step needs approval', () => {
      expect(
        use(match, { pack: packWith(nextKey(match), { requiresApproval: true }) }).verdict,
      ).toBe('requires_approval');
    });
    it('the skill has not passed the gates that allow it to be suggested', () => {
      const result = use({ ...match, lifecycle: 'expert_reviewed' });
      expect(result.verdict).toBe('requires_approval');
      expect(result.reasons.join(' ')).toMatch(/not yet passed the gates/);
    });
  });

  describe('which answer wins when several hold', () => {
    const match = matchOf(TWO, 'g01');
    it('not applying beats everything: a skill that does not apply is not "unsafe"', () => {
      const excluded = { ...match, exclusionsHit: [{ id: 'e', description: 'x' }] };
      expect(use(excluded, { pack: packWith(nextKey(match), { destructive: true }) }).verdict).toBe(
        'does_not_apply',
      );
    });
    it('unsafe beats needing approval: approval does not make a destructive step acceptable', () => {
      const both = packWith(nextKey(match), { destructive: true, requiresApproval: true });
      expect(use(match, { pack: both }).verdict).toBe('unsafe_to_apply');
    });
    it('needing approval beats a partial match', () => {
      const partial = { ...matchOf(ONE, 'e03'), lifecycle: 'expert_reviewed' as const };
      expect(use(partial).verdict).toBe('requires_approval');
    });
  });
});
