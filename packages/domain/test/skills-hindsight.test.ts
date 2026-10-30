import { describe, expect, it } from 'vitest';
import { SkillContentSchema, type SkillContent } from '@caseguard/schemas';
import { hashJson, proposeMutations, type MatchableSkill, type SkillMatchSet } from '../src';
import { HINDSIGHT_NOTICE } from '../src/skills/extraction-parts';
import type { Prepared } from './helpers';
import {
  CASEY,
  IRRELEVANT,
  ONE,
  TWO,
  asOf,
  draftAggregate,
  first,
  makeOp,
  matchAt,
  matchableOf,
  publishedAggregate,
  seeded,
  toSeedCase,
  withPoisonedFuture,
} from './skills-fixtures';

/*
 * The provenance of a skill lists the parts that were derived with knowledge of the source case's
 * recorded resolution, and says what they do when the skill is matched. That sentence has to be true:
 * trigger conditions and exclusions are read when matching (against the matched case's own evidence at
 * the match instant, and nothing else), and nothing else of what is listed ever decides a match.
 */

const entry = matchableOf(publishedAggregate());
const content = entry.version.content;
const provenance = content.provenance;
if (provenance === undefined) throw new Error('the seeded skill has no provenance');
const parts = provenance.hindsight.parts;
const TRIGGER_PREFIX = 'triggerConditions.';
const hindsightTriggers = content.triggerConditions.filter((c) =>
  parts.includes(`${TRIGGER_PREFIX}${c.id}`),
);

/** A copy of the skill whose content was rewritten (same ids, so every difference comes from the content). */
function rewritten(skill: MatchableSkill, edit: (c: SkillContent) => void): MatchableSkill {
  const next = structuredClone(skill.version.content);
  edit(next);
  return {
    skill: skill.skill,
    version: { ...skill.version, content: next, contentHash: hashJson(next) },
  };
}

/** Makes one trigger depend on a signal no case ever records, so it can never hold. */
function unobserved(c: SkillContent, id: string): void {
  c.triggerConditions = c.triggerConditions.map((t) =>
    t.id === id ? { ...t, kind: 'signal', signalId: 'sig.never-observed' } : t,
  );
}

/** What a match decides: the score, the verdict, which triggers hold on which evidence, and what excludes it. */
const decisionOf = (set: SkillMatchSet) =>
  set.matches.map((m) => ({
    skillId: m.skillId,
    score: m.score,
    applicability: m.applicability,
    matched: m.matchedTriggers.map((t) => [t.id, [...t.evidenceIds].sort()]),
    unmatched: m.unmatchedTriggers.map((t) => t.id),
    excluded: m.exclusionsHit.map((e) => e.id),
  }));

type Moment = readonly [name: string, p: Prepared, at: string];
const moment = (p: Prepared, suffix: string): Moment => [
  `${p.bundle.case.reference} at ${suffix}`,
  p,
  asOf(p, suffix),
];
// Case Two as it meets the skill, the source case as it unfolds, and a case the skill must stay out of.
const MOMENTS: readonly Moment[] = [
  moment(TWO, 'g01'),
  moment(TWO, 'g09'),
  moment(ONE, 'e03'),
  moment(ONE, 'e04'),
  moment(ONE, 'e24'),
  moment(ONE, 'e31'),
  moment(IRRELEVANT, 'x01'),
];

const decisions = (skill: MatchableSkill) =>
  MOMENTS.map(([, p, at]) => decisionOf(matchAt(p, at, [skill])));

describe('the provenance notice says what hindsight parts do', () => {
  it('[FR-SK-01] says what hindsight parts do in matching, and no longer claims they are never used', () => {
    expect(HINDSIGHT_NOTICE).toMatch(
      /derived with knowledge of the source case’s recorded resolution/,
    );
    expect(HINDSIGHT_NOTICE).toMatch(/are labelled estimates/);
    expect(HINDSIGHT_NOTICE).toMatch(
      /Hindsight trigger conditions and exclusions do take part in matching/,
    );
    expect(HINDSIGHT_NOTICE).toMatch(
      /only against what the matched case had recorded at that moment/,
    );
    expect(HINDSIGHT_NOTICE).toMatch(
      /hindsight branch probabilities and the other listed parts never decide whether the skill matches/,
    );
    // The earlier sentence said that nothing derived with hindsight is ever used to decide a match.
    expect(HINDSIGHT_NOTICE).not.toMatch(/never used to decide whether the skill matches a case/);
    expect(HINDSIGHT_NOTICE.length).toBeLessThanOrEqual(400);
  });

  it('[FR-SK-01] is what the extracted skill and every proposal built on it carry', () => {
    expect(provenance.hindsight.notice).toBe(HINDSIGHT_NOTICE);
    expect(provenance.hindsight.used).toBe(true);
    expect(() => SkillContentSchema.parse(content)).not.toThrow();
    const preview = seeded().previewMutation;
    if (preview === null) throw new Error('the seed proposes no mutation');
    expect(preview.version.content.provenance?.hindsight.notice).toBe(HINDSIGHT_NOTICE);
  });

  it('[FR-SK-01] a proposal states what is true now, even when its base was written with the old wording', () => {
    const OLD =
      'Parts listed as hindsight were derived with knowledge of the recorded resolution. They are labelled estimates and are never used to decide whether the skill matches a case.';
    const base = draftAggregate();
    const [version] = base.versions;
    if (version === undefined || version.content.provenance === undefined) {
      throw new Error('the seeded draft has no provenance');
    }
    const stale = structuredClone(version.content);
    if (stale.provenance === undefined) throw new Error('unreachable');
    stale.provenance.hindsight.notice = OLD;
    const aggregate = {
      ...base,
      versions: [{ ...version, content: stale, contentHash: hashJson(stale) }],
    };
    const result = proposeMutations({
      aggregate,
      source: toSeedCase(TWO),
      actor: CASEY,
      op: makeOp('stale-notice'),
    });
    if (!result.ok || result.value.status !== 'proposed') throw new Error('no proposal was made');
    expect(stale.provenance.hindsight.notice).toBe(OLD);
    expect(result.value.proposal.version.content.provenance?.hindsight.notice).toBe(
      HINDSIGHT_NOTICE,
    );
  });
});

describe('what each listed hindsight part does when the skill is matched', () => {
  /** Rewrites one listed part, and says whether a match is expected to read it. */
  function rewriteOf(part: string): { reads: boolean; edit: (c: SkillContent) => void } {
    if (part.startsWith(TRIGGER_PREFIX)) {
      const id = part.slice(TRIGGER_PREFIX.length);
      return { reads: true, edit: (c) => unobserved(c, id) };
    }
    if (part === 'exclusions') {
      return {
        reads: true,
        edit: (c) => {
          c.exclusions = [];
        },
      };
    }
    if (part === 'decisionSequence.*.branches.hindsightProbability') {
      return {
        reads: false,
        edit: (c) => {
          for (const step of c.decisionSequence) {
            for (const branch of step.branches) {
              if (branch.hindsightProbability !== undefined) {
                branch.hindsightProbability =
                  Math.round((1 - branch.hindsightProbability) * 1000) / 1000;
              }
            }
          }
        },
      };
    }
    const next = /^decisionSequence\.([^.]+)\.branches\.next$/.exec(part);
    if (next !== null) {
      return {
        reads: false,
        edit: (c) => {
          for (const step of c.decisionSequence) {
            if (step.id !== next[1]) continue;
            step.branches = step.branches.map((b) => ({ ...b, next: 'stop' }));
          }
        },
      };
    }
    const simple: Record<string, (c: SkillContent) => void> = {
      successConditions: (c) => {
        c.successConditions = ['Rewritten success condition.'];
      },
      knownFailureModes: (c) => {
        c.knownFailureModes = [];
      },
      expectedBenefit: (c) => {
        delete c.expectedBenefit;
      },
      confidence: (c) => {
        c.confidence = { score: 0.99, rationale: 'Rewritten for the test.' };
      },
    };
    const edit = simple[part];
    // A part added to the provenance list must be classified here, so the notice stays true of it.
    if (edit === undefined) throw new Error(`The hindsight part "${part}" is not classified`);
    return { reads: false, edit };
  }

  it('[FR-SK-05] lists trigger conditions, exclusions and the branch probabilities among the hindsight parts', () => {
    expect(hindsightTriggers.length).toBeGreaterThan(0);
    for (const t of hindsightTriggers) {
      expect(t.required).toBe(false);
      expect(t.description).toMatch(/\(hindsight-informed\)/);
    }
    expect(parts).toEqual(
      expect.arrayContaining([
        'exclusions',
        'decisionSequence.*.branches.hindsightProbability',
        'successConditions',
        'knownFailureModes',
        'expectedBenefit',
        'confidence',
      ]),
    );
    // Every condition marked in its text is also listed, and the other way round.
    const marked = content.triggerConditions
      .filter((c) => /\(hindsight-informed\)/.test(c.description))
      .map((c) => c.id);
    expect(marked.sort()).toEqual(hindsightTriggers.map((c) => c.id).sort());
  });

  const baseline = decisions(entry);

  it.each(parts)('[FR-SK-05] "%s" is read when matching only if the notice says it is', (part) => {
    const { reads, edit } = rewriteOf(part);
    const changed = decisions(rewritten(entry, edit));
    const differs = changed.some((d, i) => JSON.stringify(d) !== JSON.stringify(baseline[i]));
    expect(differs).toBe(reads);
  });

  it('[FR-SK-05] rewriting every hindsight branch probability leaves the whole match, plan included, as it was', () => {
    const flipped = rewritten(
      entry,
      rewriteOf('decisionSequence.*.branches.hindsightProbability').edit,
    );
    const hasHindsightValues = content.decisionSequence.some((s) =>
      s.branches.some((b) => b.hindsightProbability !== undefined),
    );
    expect(hasHindsightValues).toBe(true);
    expect(flipped.version.contentHash).not.toBe(entry.version.contentHash);
    for (const [name, p, at] of MOMENTS) {
      expect(matchAt(p, at, [flipped]), name).toEqual(matchAt(p, at, [entry]));
    }
  });

  it('[FR-SK-05] the same check does see the decision-time probabilities in the plan, so it is not blind to branch data', () => {
    const other = rewritten(entry, (c) => {
      for (const step of c.decisionSequence) {
        for (const branch of step.branches) {
          if (branch.probability !== undefined) {
            branch.probability = Math.round((1 - branch.probability) * 1000) / 1000;
          }
        }
      }
    });
    const [, p, at] = moment(TWO, 'g01');
    const before = matchAt(p, at, [entry]);
    const after = matchAt(p, at, [other]);
    // The decision does not read them either, but the guided plan shows them (decision-time, labelled).
    expect(decisionOf(after)).toEqual(decisionOf(before));
    expect(JSON.stringify(after.plans)).not.toBe(JSON.stringify(before.plans));
  });
});

describe('hindsight trigger conditions count, and only through the matched case’s own evidence', () => {
  const total = content.triggerConditions.reduce((s, c) => s + c.weight, 0);

  it('[FR-SK-05] their weights are part of the score: Case Two applies because of them', () => {
    const [, p, at] = moment(TWO, 'g01');
    const match = first(matchAt(p, at).matches);
    const heldWeight = (ids: ReadonlySet<string>) =>
      content.triggerConditions.filter((c) => ids.has(c.id)).reduce((s, c) => s + c.weight, 0);
    const matched = new Set(match.matchedTriggers.map((t) => t.id));
    const hindsightHeld = hindsightTriggers.filter((t) => matched.has(t.id));
    expect(hindsightHeld.length).toBeGreaterThan(0);
    expect(match.score).toBeCloseTo(heldWeight(matched) / total, 3);

    // Without them the same evidence reaches only the decision-time triggers.
    const withoutHindsight = rewritten(entry, (c) => {
      for (const t of hindsightTriggers) unobserved(c, t.id);
    });
    const after = first(matchAt(p, at, [withoutHindsight]).matches);
    const dropped = hindsightHeld.reduce((s, t) => s + t.weight, 0);
    expect(match.score - after.score).toBeCloseTo(dropped / total, 3);
    expect(match.applicability).toBe('applies');
    expect(after.applicability).toBe('partial');
    expect(after.matchedTriggers.every((t) => !hindsightHeld.some((h) => h.id === t.id))).toBe(
      true,
    );
  });

  it('[FR-SK-05] each one holds exactly when the matched case has recorded its signal by then, even on the source case', () => {
    for (const event of ONE.normalized.events) {
      const match = first(matchAt(ONE, event.timestamp).matches);
      for (const trigger of hindsightTriggers) {
        const recorded = ONE.analysis.observations
          .filter((o) => o.signalId === trigger.signalId && o.timestamp <= event.timestamp)
          .map((o) => o.id)
          .sort();
        const held = match.matchedTriggers.find((t) => t.id === trigger.id);
        expect(held !== undefined, `${trigger.id} at ${event.id}`).toBe(recorded.length > 0);
        expect([...(held?.evidenceIds ?? [])].sort(), `${trigger.id} at ${event.id}`).toEqual(
          recorded,
        );
      }
    }
    // The skill was learned from this case, yet at the third event it knows nothing the case had not said.
    const early = first(matchAt(ONE, asOf(ONE, 'e03')).matches);
    expect(early.matchedTriggers.map((t) => t.id).sort()).toEqual(
      content.triggerConditions
        .filter((c) => c.required)
        .map((c) => c.id)
        .sort(),
    );
    for (const trigger of hindsightTriggers) {
      expect(early.unmatchedTriggers.map((t) => t.id)).toContain(trigger.id);
    }
  });

  it('[FR-SK-05] nothing after the match instant, and not the source case’s resolution, reaches a hindsight trigger', () => {
    const at = asOf(ONE, 'e03');
    expect(matchAt(ONE, at, undefined, withPoisonedFuture(ONE, at))).toEqual(matchAt(ONE, at));
    // The rewrite is not vacuous: read at the end of the case it changes the answer.
    const end = asOf(ONE, 'e31');
    expect(decisionOf(matchAt(ONE, end, undefined, withPoisonedFuture(ONE, at)))).not.toEqual(
      decisionOf(matchAt(ONE, end)),
    );
  });

  it('[FR-SK-05] a case that never records the signal never satisfies the trigger, whatever the skill learned', () => {
    const match = first(matchAt(TWO, asOf(TWO, 'g15')).matches);
    const neverSeen = hindsightTriggers.filter(
      (t) => !TWO.analysis.observations.some((o) => o.signalId === t.signalId),
    );
    expect(neverSeen.length).toBeGreaterThan(0);
    for (const t of neverSeen) {
      expect(match.unmatchedTriggers.map((u) => u.id)).toContain(t.id);
    }
  });

  it('[FR-SK-05] the exclusions listed as hindsight rule a case out only on that case’s own evidence', () => {
    const [, p, at] = moment(IRRELEVANT, 'x01');
    const match = first(matchAt(p, at).matches);
    expect(parts).toContain('exclusions');
    expect(match.exclusionsHit.map((e) => e.id)).toContain('exc-single-user-scope');
    expect(match).toMatchObject({ applicability: 'not_applicable', score: 0 });
    const hitSignals = content.exclusions
      .filter((e) => match.exclusionsHit.some((h) => h.id === e.id))
      .map((e) => e.signalId);
    for (const signalId of hitSignals) {
      expect(
        p.analysis.observations.some((o) => o.signalId === signalId && o.timestamp <= at),
      ).toBe(true);
    }
    // Take the exclusions away and the same evidence no longer rules the case out by them.
    const lifted = first(
      matchAt(p, at, [
        rewritten(entry, (c) => {
          c.exclusions = [];
        }),
      ]).matches,
    );
    expect(lifted.exclusionsHit).toEqual([]);
    expect(match.rationale).toMatch(/Excluded because/);
    expect(lifted.rationale).not.toMatch(/Excluded because/);
  });
});
