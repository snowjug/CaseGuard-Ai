import { describe, expect, it } from 'vitest';
import { getCompiledPack, TEAMS_AUTH_PACK } from '../src';
import { parsePastedTranscript } from '../src/ingest/parsers';
import {
  EVAL_CASES,
  evaluateAll,
  forkSummary,
  leaderSummary,
  missSummary,
  rate,
  reachableRecall,
  type CaseResult,
} from './evaluation/evaluate';
import { S } from './evaluation/types';
import { CASE_ONE, CASE_TWO, loadBundle, prepareBundle } from './helpers';

/**
 * An independent evaluation of the deterministic engine. The two shipped samples were written together with the
 * knowledge pack, so they show that the engine is consistent, not that it reads other text correctly. These cases
 * were written separately (see docs/EVALUATION.md, "Independent evaluation"): different stories, different wording,
 * typos, quoted history and look-alike text, with every expected signal labelled by meaning before the engine ran.
 */
const ALL = evaluateAll();
const byId = new Map(ALL.results.map((result) => [result.id, result]));
const get = (id: string): CaseResult => {
  const found = byId.get(id);
  if (!found) throw new Error(`no result for ${id}`);
  return found;
};

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}.]+/gu) ?? [];
const shingles = (text: string, size: number): Set<string> => {
  const words = wordsOf(text);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
};

describe('[eval] the evaluation set is well formed', () => {
  it('has the intended groups', () => {
    const count = (group: string): number =>
      EVAL_CASES.filter((candidate) => candidate.group === group).length;
    expect({
      paraphrase: count('paraphrase'),
      noisy: count('noisy'),
      negative: count('negative'),
      reordered: count('reordered'),
    }).toEqual({ paraphrase: 6, noisy: 3, negative: 4, reordered: 3 });
  });

  it('has unique case ids and unique event keys, and valid bundles', () => {
    const ids = EVAL_CASES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const candidate of EVAL_CASES) {
      const keys = candidate.events.map((event) => event.key);
      expect(new Set(keys).size, candidate.id).toBe(keys.length);
      // toBundle parses with the real schema, so evaluating a case proves the bundle is valid.
      expect(get(candidate.id).bundle.events.length, candidate.id).toBe(keys.length);
    }
  });

  it('labels only signals that the pack defines, on events that exist', () => {
    const known = new Set(TEAMS_AUTH_PACK.signals.map((signal) => signal.id));
    for (const id of Object.values(S)) expect(known.has(id), id).toBe(true);
    for (const candidate of EVAL_CASES) {
      const keys = new Set(candidate.events.map((event) => event.key));
      if (candidate.earliestMissed !== null)
        expect(keys.has(candidate.earliestMissed), candidate.id).toBe(true);
      for (const key of candidate.order ?? []) expect(keys.has(key), candidate.id).toBe(true);
    }
  });

  it('is plain text: no event carries structured data or an action', () => {
    for (const result of ALL.results)
      for (const event of result.bundle.events) {
        expect(event.structured, `${result.id} ${event.id}`).toBeUndefined();
        expect(event.action, `${result.id} ${event.id}`).toBeUndefined();
      }
  });

  it('does not reuse the wording of the two shipped samples', () => {
    const sample = [CASE_ONE, CASE_TWO].flatMap((file) =>
      loadBundle(file).events.map((event) => `${event.title ?? ''} ${event.body}`),
    );
    const known = new Set(sample.flatMap((text) => [...shingles(text, 6)]));
    const copied: string[] = [];
    for (const result of ALL.results)
      for (const event of result.bundle.events)
        for (const shingle of shingles(`${event.title ?? ''} ${event.body}`, 6))
          if (known.has(shingle)) copied.push(`${result.id} ${event.id}: "${shingle}"`);
    expect(copied).toEqual([]);
  });
});

describe('[eval] the order in which events are handed over does not matter', () => {
  const reordered = EVAL_CASES.filter((candidate) => candidate.group === 'reordered');

  it.each(reordered.map((candidate) => [candidate.id, candidate.basedOn ?? ''] as const))(
    '%s gives exactly the analysis of %s',
    (id, basedOn) => {
      const shuffled = get(id);
      const original = get(basedOn);
      expect(shuffled.fingerprint).toBe(original.fingerprint);
      expect(shuffled.truePositives).toEqual(original.truePositives);
      expect(shuffled.falsePositives).toEqual(original.falsePositives);
      expect(shuffled.misses).toEqual(original.misses);
      expect(shuffled.earliestFork).toBe(original.earliestFork);
    },
  );

  it('really hands the events over in another order', () => {
    for (const candidate of reordered) {
      const handedOver = get(candidate.id).bundle.events.map((event) => event.id);
      const byTime = [...get(candidate.id).bundle.events]
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .map((event) => event.id);
      expect(handedOver, candidate.id).not.toEqual(byTime);
    }
  });
});

describe('[eval] cases the engine has no knowledge pack for', () => {
  it('are not given the Teams pack under a similar name', () => {
    expect(getCompiledPack('teams-authentication')).not.toBeNull();
    for (const workload of [
      'printer-queue',
      'teams-authentication-v2',
      'Teams-Authentication',
      ' teams-authentication',
      'teams',
      '',
    ])
      expect(getCompiledPack(workload), JSON.stringify(workload)).toBeNull();
  });
});

describe('[eval] negative controls', () => {
  it.each(['z1-scheduling', 'z2-licence-question', 'z3-printer-lookalike'])(
    '%s: nothing is reported and no decision point is raised',
    (id) => {
      const result = get(id);
      expect(result.truePositives).toEqual([]);
      expect(result.falsePositives).toEqual([]);
      expect(result.forkCount).toBe(0);
    },
  );
});

/**
 * What the engine measured on this set. These numbers are a baseline, not a quality bar: they are pinned so that a
 * change to the pack or the engine that alters how independently worded text is read cannot go unnoticed. When one
 * does, re-run `pnpm --filter @caseguard/domain run eval`, update docs/EVALUATION.md and then the numbers here.
 */
describe('[eval] measured baseline', () => {
  const counts = (results: readonly CaseResult[]) => {
    const { tp, fp, fn } = rate(results);
    return { tp, fp, fn };
  };
  const ofGroup = (group: string): CaseResult[] =>
    ALL.scored.filter((result) => result.group === group);

  it('reads about a fifth of the signals a reader finds in independently worded text', () => {
    expect(counts(ofGroup('paraphrase'))).toEqual({ tp: 9, fp: 2, fn: 30 });
    expect(counts(ofGroup('noisy'))).toEqual({ tp: 4, fp: 1, fn: 21 });
    expect(counts(ofGroup('negative'))).toEqual({ tp: 0, fp: 1, fn: 2 });
    expect(counts(ALL.scored)).toEqual({ tp: 13, fp: 4, fn: 53 });
  });

  it('misses mostly because the pattern does not match the wording', () => {
    expect(missSummary(ALL.scored)).toEqual({
      'structured-only': 4,
      'type-or-role-gate': 3,
      wording: 46,
    });
    expect(Math.round((reachableRecall(ALL.scored) ?? 0) * 100)).toBe(22);
  });

  it('reports four things nobody wrote, each from a sentence that denies them', () => {
    const reported = ALL.scored
      .flatMap((result) => result.falsePositives.map((item) => `${result.id} ${item}`))
      .sort();
    expect(reported).toEqual([
      'n3-lisbon-mixed-language ev05|sig.service-health-incident',
      'p4-hourly-signout ev05|sig.service-health-incident',
      'p5-single-laptop ev03|sig.web-client-also-fails',
      'z4-negations ev01|sig.intermittent-failures',
    ]);
  });

  it('agrees with the earliest missed decision point where there is one, and invents one in one case', () => {
    expect(forkSummary(ALL.scored)).toEqual({
      exact: 2,
      near: 0,
      different: 0,
      missed: 0,
      spurious: 1,
      'agree-none': 10,
    });
    expect(get('p5-single-laptop').forkAgreement).toBe('spurious');
  });

  it('puts the story’s cause first, moved by evidence, in four of nine stories', () => {
    expect(leaderSummary(ALL.scored)).toEqual({
      right: 4,
      'right-by-prior': 1,
      other: 0,
      wrong: 4,
      'n/a': 4,
    });
    expect(
      ALL.scored.filter((result) => result.leaderAgreement === 'wrong').map((result) => result.id),
    ).toEqual(['p1-warsaw-resolver', 'p4-hourly-signout', 'p5-single-laptop', 'n1-warsaw-noisy']);
  });
});

/**
 * Defects the evaluation found. Each states what should be true and is marked as known to fail (`it.fails`), so the
 * suite stays green while the defect is open and goes red the day it is fixed, which is the cue to turn the test
 * into a normal one and to update docs/EVALUATION.md and docs/KNOWN_LIMITATIONS.md.
 */
describe('[eval] known defects: a statement that denies a signal must not report it', () => {
  it.fails('"nothing active in service health" is not read as an incident (p4)', () => {
    expect(get('p4-hourly-signout').falsePositives).toEqual([]);
  });

  it.fails('and so does not make an incident the leading cause of an unrelated story (p4)', () => {
    expect(get('p4-hourly-signout').leaderAgreement).not.toBe('wrong');
  });

  it.fails('"this is not intermittent" is not read as intermittent failures (z4)', () => {
    expect(get('z4-negations').falsePositives).toEqual([]);
  });

  it.fails('the same log finding is read whichever word opens a pasted message', () => {
    const parsed = parsePastedTranscript(
      [
        '[2026-06-02 08:00 UTC] Customer: About 45 people in our Warsaw office get thrown out of Teams.',
        '[2026-06-02 08:40 UTC] Support Engineer: Checked the logs. No matching sign-in records for the failing attempts.',
        '[2026-06-02 09:10 UTC] Support Engineer: Result of the log lookup. No matching sign-in records for the failing attempts.',
      ].join('\n'),
      { synthetic: true, now: '2026-10-29T00:00:00Z' },
    );
    if (!parsed.ok) throw new Error('the transcript did not parse');
    const bundle = structuredClone(parsed.bundle);
    bundle.case.workload = 'teams-authentication';
    const { analysis, normalized } = prepareBundle(bundle, 'case_same_finding');
    // The parser types the first engineer message (it opens with the verb "Checked") as an engineer action, which the
    // signal's text detector does not accept; the second becomes a case note, which it does.
    const position = new Map(normalized.events.map((event, index) => [event.id, index + 1]));
    expect(
      analysis.evidence
        .filter((item) => item.signalId === 'sig.no-server-side-failure-records')
        .map((item) => position.get(item.eventId)),
    ).toEqual([2, 3]);
  });
});
