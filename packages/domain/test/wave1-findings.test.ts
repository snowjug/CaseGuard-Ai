import { describe, expect, it } from 'vitest';
import { parsePastedTranscript } from '../src/ingest/parsers';
import { evaluateCase } from './evaluation/evaluate';
import { wave1Id } from './evaluation/wave1-plan';
import { prepareBundle } from './helpers';

/**
 * What the first independent evaluation found wrong, kept as regression tests now that it is fixed. Each test states what
 * must stay true: a sentence that denies a signal is not read as stating it, and the same finding is read whichever word
 * opens a pasted message. While the defects were open these tests were marked `it.fails`, so the suite stayed green until
 * the day it was fixed; they went red on that day, which was the cue to make them ordinary tests. The cases are the migrated
 * Wave 1 cases of `evaluation/cases/dev`.
 */
const p4 = evaluateCase(wave1Id('p4-hourly-signout'), 'dev', { recommendations: false });
const z4 = evaluateCase(wave1Id('z4-negations'), 'dev', { recommendations: false });

describe('[eval] a statement that denies a signal is not read as stating it', () => {
  it('"nothing active in service health" is not read as an incident (p4)', () => {
    expect(p4.detail.signals?.fp).toEqual([]);
  });

  it('and so does not make an incident the leading cause of an unrelated story (p4)', () => {
    expect(p4.detail.leader?.agreement).not.toBe('wrong');
  });

  it('"this is not intermittent" is not read as intermittent failures (z4)', () => {
    expect(z4.detail.signals?.fp).toEqual([]);
  });

  it('the same log finding is read whichever word opens a pasted message', () => {
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
