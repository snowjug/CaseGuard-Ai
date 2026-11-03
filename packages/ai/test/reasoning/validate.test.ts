import { describe, expect, it } from 'vitest';
import { verifyExcerpt } from '@caseguard/domain';
import { PROPOSAL_LIMITS } from '@caseguard/schemas';
import { validateProposalOutput, type AgentTask } from '../../src';
import { PROPOSAL_CODES } from '../../src/reasoning/types';
import { baseOf } from '../tasks';
import {
  VALID_PROPOSAL_COUNT,
  conclusionsOf,
  criticReply,
  eid,
  emptyCriticReply,
  one,
  validProposals,
  validReply,
  validateReasoner,
  vctxOf,
  view,
} from './case-one';

const criticTask = (conclusions = conclusionsOf()): AgentTask => ({
  agent: 'case_critic',
  input: { ...baseOf(one, view), conclusions },
});

const validateCritic = (reply: unknown, task = criticTask()) =>
  validateProposalOutput('case_critic', reply, vctxOf(task));

const withProposal = (
  key: string,
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const reply = validReply();
  const list = reply[key] as Record<string, unknown>[];
  list[index] = { ...list[index], ...patch };
  return reply;
};

describe('validating the reply of the reasoner (Case One, real context, scripted text)', () => {
  it('keeps every grounded proposal and records where each quotation is, which the domain verifies', () => {
    const report = validateReasoner(validReply());
    expect(report.ok).toBe(true);
    expect(report.repairable).toBe(false);
    expect(report.issues).toEqual([]);
    expect(report.proposals).toMatchObject({
      agent: 'case_reasoner',
      proposed: VALID_PROPOSAL_COUNT,
      kept: VALID_PROPOSAL_COUNT,
    });
    expect(report.proposals?.dropped).toEqual([]);
    expect(report.proposals?.rejectedByCode).toEqual({});
    expect(report.proposals?.wholeReply).toEqual([]);
    expect(report.outcome).toEqual({
      schemaValid: true,
      citationsValid: true,
      policyValid: true,
      temporalValid: true,
      issues: [],
    });
    expect(report.stats).toMatchObject({
      claims: VALID_PROPOSAL_COUNT,
      supportedClaims: VALID_PROPOSAL_COUNT,
      groundedness: 1,
    });

    const kept = report.proposals?.reasoner ?? [];
    expect(kept).toHaveLength(VALID_PROPOSAL_COUNT);
    for (const item of kept) {
      expect(item.checks.length).toBeGreaterThan(8);
      expect(item.checks.every((c) => c.passed)).toBe(true);
      expect(item.checks.every((c) => (PROPOSAL_CODES as readonly string[]).includes(c.id))).toBe(
        true,
      );
      for (const evidence of [...item.evidence, ...item.keyPointEvidence.flat()]) {
        const stored = one.normalized.events.find((e) => e.id === evidence.eventId);
        expect(stored).toBeDefined();
        expect(evidence).toMatchObject({ verifiedIn: 'stored_text', verified: true });
        const check = verifyExcerpt(
          { id: evidence.eventId, title: stored?.title ?? null, body: stored?.body ?? '' },
          {
            eventId: evidence.eventId,
            ...(evidence.field === null ? {} : { field: evidence.field }),
            ...(evidence.start === null ? {} : { start: evidence.start }),
            ...(evidence.end === null ? {} : { end: evidence.end }),
            excerpt: evidence.excerpt,
          },
        );
        expect(check.verification).toBe('verified');
      }
    }
  });

  it('hands back, in the filtered output, exactly the proposals it kept', () => {
    const report = validateReasoner(
      withProposal('signals', 1, { signalId: 'sig.not-in-the-pack' }),
    );
    const output = report.output as { signals: { id: string }[]; synthesis: { id: string } | null };
    expect(output.signals.map((s) => s.id)).toEqual(['sg1']);
    expect(output.synthesis?.id).toBe('sy1');
  });

  it('is the same every time: the report is a function of the reply and the case', () => {
    const reply = withProposal('signals', 1, { signalId: 'sig.not-in-the-pack' });
    expect(validateReasoner(structuredClone(reply))).toEqual(
      validateReasoner(structuredClone(reply)),
    );
  });

  describe('a proposal that fails a rule is dropped on its own', () => {
    it('drops one proposal and keeps the other seven, by code and path', () => {
      const report = validateReasoner(
        withProposal('signals', 1, { signalId: 'sig.not-in-the-pack' }),
      );
      expect(report.ok).toBe(true);
      expect(report.proposals).toMatchObject({ proposed: 8, kept: 7 });
      expect(report.proposals?.dropped).toEqual([
        { type: 'signal', path: 'signals[1]', codes: ['unknown_vocabulary_id'] },
      ]);
      expect(report.proposals?.rejectedByCode).toEqual({ unknown_vocabulary_id: 1 });
      expect(report.outcome).toMatchObject({
        schemaValid: true,
        citationsValid: false,
        policyValid: true,
        temporalValid: true,
      });
      expect(report.stats).toMatchObject({ claims: 8, supportedClaims: 7 });
      expect(report.stats.groundedness).toBeCloseTo(7 / 8);
    });

    it('counts a proposal that fails two rules under both codes', () => {
      const bad = {
        signalId: 'sig.not-in-the-pack',
        evidence: [{ eventId: eid('e14'), excerpt: 'Root cause is the Conditional Access policy' }],
      };
      const report = validateReasoner(withProposal('signals', 1, bad));
      expect(report.proposals?.dropped).toHaveLength(1);
      expect(new Set(report.proposals?.dropped[0]?.codes)).toEqual(
        new Set(['unknown_vocabulary_id', 'excerpt_wrong_event']),
      );
      expect(report.proposals?.rejectedByCode).toEqual({
        unknown_vocabulary_id: 1,
        excerpt_wrong_event: 1,
      });
      expect(report.proposals?.kept).toBe(7);
    });

    it('drops a quotation that is not in the event, one that is in another event, and one from a later event', () => {
      const notFound = validateReasoner(
        withProposal('signals', 0, {
          evidence: [{ eventId: eid('e07'), excerpt: 'The firewall dropped every packet.' }],
        }),
      );
      expect(notFound.proposals?.rejectedByCode).toEqual({ excerpt_not_found: 1 });
      const wrongEvent = validateReasoner(
        withProposal('signals', 0, {
          evidence: [{ eventId: eid('e07'), excerpt: 'ERR_NAME_NOT_RESOLVED' }],
        }),
      );
      expect(wrongEvent.proposals?.rejectedByCode).toEqual({ excerpt_wrong_event: 1 });
      const future = validateReasoner(
        withProposal('signals', 0, {
          eventId: eid('e24'),
          evidence: [{ eventId: eid('e24'), excerpt: 'Resolver 10.20.1.11 returns SERVFAIL' }],
        }),
      );
      expect(future.proposals?.rejectedByCode.future_information).toBe(1);
      expect(future.proposals?.rejectedByCode.unknown_event).toBeUndefined();
      expect(future.outcome.temporalValid).toBe(false);
    });

    it('drops a proposal that names an event the model was never shown', () => {
      const report = validateReasoner(withProposal('signals', 0, { eventId: 'no-such-event' }));
      expect(report.proposals?.rejectedByCode.unknown_event).toBe(1);
    });

    it('drops a proposal that names a field only the server may set, and says so by code', () => {
      const report = validateReasoner(withProposal('signals', 0, { approved: true }));
      expect(report.ok).toBe(true);
      expect(report.proposals?.rejectedByCode).toEqual({ prohibited_field: 1 });
      expect(report.proposals?.kept).toBe(7);
      expect(report.outcome.schemaValid).toBe(false);
    });

    it('drops a proposal with no citation, and one with too much text', () => {
      const none = validateReasoner(withProposal('signals', 0, { evidence: [] }));
      expect(none.proposals?.rejectedByCode).toEqual({ missing_evidence: 1 });
      const long = validateReasoner(
        withProposal('signals', 0, { statement: 'x'.repeat(PROPOSAL_LIMITS.statement + 1) }),
      );
      expect(long.proposals?.rejectedByCode).toEqual({ excessive_output: 1 });
    });

    it('drops a proposal of the wrong shape as a schema failure', () => {
      const report = validateReasoner(withProposal('signals', 0, { confidence: 'certain' }));
      expect(report.proposals?.rejectedByCode).toEqual({ schema: 1 });
    });

    it('drops the later of two proposals that say the same thing, not the earlier', () => {
      const reply = validReply();
      const twin = { ...(validProposals().sg1 as Record<string, unknown>), id: 'sg9' };
      (reply.signals as unknown[]).push(twin);
      const report = validateReasoner(reply);
      expect(report.proposals?.dropped).toEqual([
        { type: 'signal', path: 'signals[2]', codes: ['duplicate'] },
      ]);
      const ids = (report.output as { signals: { id: string }[] }).signals.map((s) => s.id);
      expect(ids).toEqual(['sg1', 'sg2']);
    });

    it('does not let a proposal dropped for another reason make a later one a duplicate', () => {
      const reply = validReply();
      const first = {
        ...(validProposals().sg1 as Record<string, unknown>),
        id: 'sg8',
        signalId: 'sig.not-in-the-pack',
      };
      reply.signals = [first, ...(reply.signals as unknown[])];
      const report = validateReasoner(reply);
      expect(report.proposals?.kept).toBe(8);
      expect(report.proposals?.dropped).toEqual([
        { type: 'signal', path: 'signals[0]', codes: ['unknown_vocabulary_id'] },
      ]);
    });

    it('counts the proposals past the cap of a list as dropped for size', () => {
      const reply = validReply();
      const many = Array.from({ length: PROPOSAL_LIMITS.signals + 2 }, (_, i) => ({
        ...(validProposals().sg1 as Record<string, unknown>),
        id: `x${i}`,
        statement: `Statement number ${i} about the record.`,
      }));
      reply.signals = many;
      const report = validateReasoner(reply);
      expect(report.proposals?.proposed).toBe(
        PROPOSAL_LIMITS.signals + 2 + (VALID_PROPOSAL_COUNT - 2),
      );
      const overflow =
        report.proposals?.dropped.filter((d) => d.codes.includes('excessive_output')) ?? [];
      expect(overflow.map((d) => d.path)).toEqual([
        `signals[${PROPOSAL_LIMITS.signals}]`,
        `signals[${PROPOSAL_LIMITS.signals + 1}]`,
      ]);
    });

    it('lists no more than a bounded number of dropped proposals, and still counts them all', () => {
      const reply = validReply();
      const total = 150;
      reply.signals = Array.from({ length: total }, (_, i) => ({
        ...(validProposals().sg1 as Record<string, unknown>),
        id: `x${i}`,
        signalId: 'sig.not-in-the-pack',
      }));
      const base = vctxOf();
      const roomy = { ...base, limits: { ...base.limits, maxOutputChars: 1_000_000 } };
      const report = validateProposalOutput('case_reasoner', reply, roomy);
      expect(report.ok).toBe(true);
      expect(report.proposals?.dropped).toHaveLength(100);
      expect(report.proposals?.rejectedByCode.excessive_output).toBe(
        total - PROPOSAL_LIMITS.signals,
      );
      expect(report.proposals?.rejectedByCode.unknown_vocabulary_id).toBe(PROPOSAL_LIMITS.signals);
    });

    it('never repeats what the model wrote, nor a key name it chose, in anything it reports', () => {
      const marker = 'ZEBRA-MARKER-9317';
      const reply = withProposal('signals', 1, {
        statement: `A statement that carries ${marker}.`,
        signalId: 'sig.not-in-the-pack',
        [`key ${marker}`]: 1,
      });
      const report = validateReasoner(reply);
      const reported = JSON.stringify([
        report.issues,
        report.outcome,
        report.proposals?.dropped,
        report.proposals?.wholeReply,
      ]);
      expect(reported).not.toContain(marker);
    });
  });

  describe('a reply that is unusable as a whole is rejected, and repairable once', () => {
    const wholeReply = (raw: unknown, vctx = vctxOf()) =>
      validateProposalOutput('case_reasoner', raw, vctx);

    it.each([
      ['no JSON at all', undefined, 'not_json', 'schema', 'schema'],
      ['a text', 'findings', 'invalid_type', 'schema', 'schema'],
      ['a list', [], 'invalid_type', 'schema', 'schema'],
      ['null', null, 'invalid_type', 'schema', 'schema'],
    ] as const)('%s', (_name, raw, issueCode, kind, code) => {
      const report = wholeReply(raw);
      expect(report.ok).toBe(false);
      expect(report.output).toBeNull();
      expect(report.repairable).toBe(true);
      expect(report.kinds).toEqual([kind]);
      expect(report.issues[0]?.code).toBe(issueCode);
      expect(report.proposals?.wholeReply.map((i) => i.code)).toEqual([code]);
      expect(report.proposals).toMatchObject({
        kept: 0,
        dropped: [{ type: 'reply', path: '$', codes: [code] }],
      });
      expect(report.outcome.schemaValid).toBe(false);
    });

    it('a reply that cannot be serialised', () => {
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      const report = wholeReply(loop);
      expect(report.ok).toBe(false);
      expect(report.issues[0]?.code).toBe('unserializable');
    });

    it('a reply larger than the cap, whatever it holds', () => {
      const base = vctxOf();
      const small = { ...base, limits: { ...base.limits, maxOutputChars: 500 } };
      const report = wholeReply(validReply(), small);
      expect(report.ok).toBe(false);
      expect(report.kinds).toEqual(['size']);
      expect(report.issues[0]?.code).toBe('output_too_large');
      expect(report.proposals?.wholeReply.map((i) => i.code)).toEqual(['excessive_output']);
      expect(report.repairable).toBe(true);
    });

    it('a reply with a key the schema does not have', () => {
      const report = wholeReply({ ...validReply(), notes: 'x' });
      expect(report.ok).toBe(false);
      expect(report.issues[0]?.code).toBe('unrecognized_keys');
    });

    it('a reply that names a field only the server may set, at the top level', () => {
      for (const field of ['approved', 'status', 'hybridStatus', 'reviewState']) {
        const report = wholeReply({ ...validReply(), [field]: 'accepted' });
        expect(report.ok).toBe(false);
        expect(report.proposals?.wholeReply.map((i) => i.code)).toEqual(['prohibited_field']);
      }
    });

    it('a reply that lacks a key, or has a list that is not a list, or no uncertainty', () => {
      const { synthesis: _synthesis, ...lacking } = validReply();
      expect(wholeReply(lacking).ok).toBe(false);
      expect(wholeReply({ ...validReply(), signals: 'none' }).ok).toBe(false);
      expect(wholeReply({ ...validReply(), synthesis: 5 }).ok).toBe(false);
      expect(wholeReply({ ...validReply(), uncertainty: 'unsure' }).ok).toBe(false);
    });

    it('reads nothing of a reply it rejects as a whole', () => {
      const report = wholeReply({ ...validReply(), extra: 1 });
      expect(report.stats).toMatchObject({ claims: 0, supportedClaims: 0 });
      expect(report.proposals).toMatchObject({
        proposed: 0,
        kept: 0,
        reasoner: null,
        critic: null,
      });
    });
  });
});

describe('validating the reply of the critic', () => {
  const conclusions = conclusionsOf();
  const task = criticTask(conclusions);
  const target = conclusions[0]?.id ?? 'C1';

  it('lists the conclusions of the engine first, then those of the reasoner, as C1, C2, ...', () => {
    expect(conclusions.length).toBeGreaterThan(VALID_PROPOSAL_COUNT);
    expect(conclusions.map((c) => c.id)).toEqual(conclusions.map((_, i) => `C${i + 1}`));
    expect(conclusions[0]?.source).toBe('engine');
    expect(conclusions.filter((c) => c.source === 'model')).toHaveLength(VALID_PROPOSAL_COUNT);
  });

  it('accepts a reply with nothing to criticise', () => {
    const report = validateCritic(emptyCriticReply(), task);
    expect(report.ok).toBe(true);
    expect(report.proposals).toMatchObject({
      agent: 'case_critic',
      proposed: 0,
      kept: 0,
      critic: null,
    });
  });

  it('keeps a critique of a conclusion under review, with its located quotation', () => {
    const report = validateCritic(criticReply([{ targetId: target }]), task);
    expect(report.ok).toBe(true);
    expect(report.proposals).toMatchObject({ proposed: 2, kept: 2 });
    const critic = report.proposals?.critic;
    expect(critic?.critiques).toHaveLength(1);
    expect(critic?.critiques[0]?.critique.targetId).toBe(target);
    expect(critic?.critiques[0]?.evidence[0]).toMatchObject({
      verifiedIn: 'stored_text',
      verified: true,
    });
    expect(critic?.evidence[0]).toMatchObject({ eventId: eid('e07'), verified: true });
  });

  it('drops a critique of a conclusion that was not under review, and keeps the rest', () => {
    const report = validateCritic(criticReply([{ targetId: target }, { targetId: 'C99' }]), task);
    expect(report.proposals?.rejectedByCode).toEqual({ critic_unknown_target: 1 });
    expect(report.proposals?.critic?.critiques).toHaveLength(1);
    expect(report.proposals?.kept).toBe(2);
    expect(report.proposals?.proposed).toBe(3);
  });

  it('drops a critique that is about nothing, one that cites nothing, and an alternative that is not a pack hypothesis', () => {
    const report = validateCritic(
      criticReply([
        { targetId: null },
        { targetId: target, evidence: [] },
        {
          targetId: target,
          kind: 'alternative_explanation',
          alternativeHypothesisId: 'hyp.invented',
        },
        { targetId: target, kind: 'alternative_explanation', alternativeHypothesisId: null },
      ]),
      task,
    );
    expect(report.proposals?.rejectedByCode).toEqual({ critic_new_story: 4 });
    expect(report.proposals?.critic?.critiques).toHaveLength(0);
  });

  it('keeps an alternative explanation that names a hypothesis of the knowledge pack', () => {
    const report = validateCritic(
      criticReply([
        {
          targetId: target,
          kind: 'alternative_explanation',
          alternativeHypothesisId: 'hyp.dns-resolution',
        },
      ]),
      task,
    );
    expect(report.proposals?.critic?.critiques[0]?.critique.alternativeHypothesisId).toBe(
      'hyp.dns-resolution',
    );
  });

  it('applies the same grounding rules to a critique: a quotation that is not in the event', () => {
    const report = validateCritic(
      criticReply([
        {
          targetId: target,
          evidence: [{ eventId: eid('e07'), excerpt: 'The firewall dropped every packet.' }],
        },
      ]),
      task,
    );
    expect(report.proposals?.rejectedByCode).toEqual({ excerpt_not_found: 1 });
  });

  it('drops the whole result when its own quotation is not in the record, and returns no result', () => {
    const reply = criticReply([{ targetId: target }]);
    (reply.result as Record<string, unknown>).evidence = [
      { eventId: eid('e07'), excerpt: 'The firewall dropped every packet.' },
    ];
    const report = validateCritic(reply, task);
    expect(report.ok).toBe(true);
    expect((report.output as { result: unknown }).result).toBeNull();
    expect(report.proposals).toMatchObject({ kept: 0, critic: null });
  });

  it('counts the critiques past the cap as dropped for size', () => {
    const over = PROPOSAL_LIMITS.critiques + 2;
    const report = validateCritic(
      criticReply(Array.from({ length: over }, () => ({ targetId: target }))),
      task,
    );
    const overflow =
      report.proposals?.dropped.filter((d) => d.codes.includes('excessive_output')) ?? [];
    expect(overflow).toHaveLength(2);
    expect(report.proposals?.proposed).toBe(1 + over);
  });

  it('rejects, as a whole, a reply that is not the shape of a critic reply', () => {
    const report = validateCritic({ ...emptyCriticReply(), extra: 1 }, task);
    expect(report.ok).toBe(false);
    expect(report.repairable).toBe(true);
    expect(validateCritic({ result: 'x', uncertainty: { level: 'low', note: 'n' } }, task).ok).toBe(
      false,
    );
  });
});
