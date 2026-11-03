import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCompiledPack } from '../src';
import { caseToBundle } from './evaluation/bundle';
import { eventsDigest, loadDataset, loadVocabulary, type LoadedCase } from './evaluation/dataset';
import { evaluateSplit } from './evaluation/evaluate';
import { acceptedFor } from './evaluation/labels';
import type { CaseCategory } from './evaluation/schema';
import { WAVE1_ANNOTATOR, WAVE1_PLAN, wave1Id } from './evaluation/wave1-plan';

/**
 * The 16 cases of Wave 1, as framework v2 holds them (`evaluation/cases/dev`, annotator `copilot-wave1`, an AI assistant,
 * not a human). Their numbers are history (`evaluation/runs/baseline-wave1.json`): detectors improve, so nothing here pins
 * what the engine reads of them. What is pinned is that the migration lost nothing, as data, and what must hold whatever
 * the detectors do: the order of events does not matter, a workload without a pack is refused, a negative control stays
 * silent. The floors under the dev measures are in `evaluation-floors.test.ts`; the open defects are in `known-defects.test.ts`.
 * The other cases of the dev split are measured by `pnpm --filter @caseguard/domain run eval:dev`, not here.
 */
const dataset = loadDataset({ splits: ['dev'] });
const vocabulary = loadVocabulary();
const migrated = (legacyId: string): LoadedCase => {
  const found = dataset.cases.find((loaded) => loaded.case.id === wave1Id(legacyId));
  if (!found) throw new Error(`the migrated case ${legacyId} is missing`);
  return found;
};
const independent = WAVE1_PLAN.filter((plan) => !plan.categories.includes('reordered')).map(
  (plan) => migrated(plan.legacyId),
);
const copies = WAVE1_PLAN.filter((plan) => plan.categories.includes('reordered')).map((plan) =>
  migrated(plan.legacyId),
);

const pairsOf = (loaded: LoadedCase): string[] =>
  (loaded.annotations?.annotations[0]?.signals ?? [])
    .map((label) => `${label.event}|${label.id}`)
    .sort();

describe('[eval] the migrated Wave 1 set is intact', () => {
  it('has the 13 independent cases and the 3 reordered copies Wave 1 had, in the dev split', () => {
    expect(dataset.problems).toEqual([]);
    expect(independent).toHaveLength(13);
    expect(copies).toHaveLength(3);
    for (const loaded of [...independent, ...copies]) expect(loaded.case.split).toBe('dev');
    const counts = (category: CaseCategory): number =>
      independent.filter((loaded) => loaded.case.categories.includes(category)).length;
    expect({
      paraphrase: counts('paraphrase'),
      noisy: counts('noisy'),
      negative: counts('negative-control'),
    }).toEqual({
      paraphrase: 6,
      noisy: 3,
      negative: 4,
    });
  });

  it('carries 83 events and 66 labelled signal occurrences over the 13 independent cases, from one AI annotator', () => {
    expect(independent.reduce((sum, loaded) => sum + loaded.case.events.length, 0)).toBe(83);
    expect(independent.reduce((sum, loaded) => sum + pairsOf(loaded).length, 0)).toBe(66);
    for (const loaded of independent) {
      expect(loaded.annotations?.annotations, loaded.case.id).toHaveLength(1);
      expect(loaded.annotations?.annotations[0], loaded.case.id).toMatchObject({
        annotatorId: WAVE1_ANNOTATOR,
        kind: 'ai_draft',
        excluded: false,
      });
      expect(acceptedFor(dataset, loaded)?.status, loaded.case.id).toBe('single_annotator');
    }
  });

  it('annotates only what Wave 1 labelled: the signals of each event, the earliest missed moment and the causes', () => {
    for (const loaded of independent) {
      const record = loaded.annotations?.annotations[0];
      expect(record?.actions, loaded.case.id).toBeUndefined();
      expect(record?.absent, loaded.case.id).toBeUndefined();
      expect(record?.forks, loaded.case.id).toBeUndefined();
      expect(record?.conflicts, loaded.case.id).toBeUndefined();
      expect(record?.counterfactualDirection, loaded.case.id).toBeUndefined();
      expect(record?.qualityBand, loaded.case.id).toBeUndefined();
      expect(record?.earliestMissed, loaded.case.id).not.toBeUndefined();
      expect(record?.causes, loaded.case.id).not.toBeUndefined();
    }
  });

  it('gives each reordered copy the events of its source and no labels of its own', () => {
    const sources = new Map([
      ['r1-warsaw-shuffled', 'p1-warsaw-resolver'],
      ['r2-utrecht-reversed', 'p2-utrecht-proxy'],
      ['r3-warsaw-noisy-swapped', 'n1-warsaw-noisy'],
    ]);
    for (const loaded of copies) {
      const legacyId =
        WAVE1_PLAN.find((plan) => wave1Id(plan.legacyId) === loaded.case.id)?.legacyId ?? '';
      const source = migrated(sources.get(legacyId) ?? '');
      expect(loaded.case.derivedFrom, legacyId).toBe(source.case.id);
      expect(loaded.case.events, legacyId).toEqual(source.case.events);
      expect(loaded.annotations, legacyId).toBeNull();
      expect(new Set(loaded.case.handedOverOrder).size, legacyId).toBe(source.case.events.length);
      expect(acceptedFor(dataset, loaded)?.labels?.signals, legacyId).toEqual(
        acceptedFor(dataset, source)?.labels?.signals,
      );
    }
  });

  it('uses only identifiers of the vocabulary, on events that exist', () => {
    const signals = new Set(vocabulary.signals.map((signal) => signal.id));
    const hypotheses = new Set(vocabulary.hypotheses.map((hypothesis) => hypothesis.id));
    for (const loaded of independent) {
      const keys = new Set(loaded.case.events.map((event) => event.key));
      const record = loaded.annotations?.annotations[0];
      for (const label of record?.signals ?? []) {
        expect(signals.has(label.id), `${loaded.case.id} ${label.id}`).toBe(true);
        expect(keys.has(label.event), `${loaded.case.id} ${label.event}`).toBe(true);
      }
      for (const cause of record?.causes ?? [])
        expect(hypotheses.has(cause), `${loaded.case.id} ${cause}`).toBe(true);
      if (record?.earliestMissed)
        expect(keys.has(record.earliestMissed), loaded.case.id).toBe(true);
    }
  });

  it('is plain text: every bundle is valid and no event carries structured data or an action', () => {
    for (const loaded of [...independent, ...copies]) {
      const bundle = caseToBundle(loaded.case);
      expect(bundle.events.length, loaded.case.id).toBe(loaded.case.events.length);
      for (const event of bundle.events) {
        expect(event.structured, `${loaded.case.id} ${event.id}`).toBeUndefined();
        expect(event.action, `${loaded.case.id} ${event.id}`).toBeUndefined();
      }
    }
  });

  it('is the set the Wave 1 harness measured: events, labels, earliest moment and causes equal the historical record', () => {
    const file = resolve(import.meta.dirname, '../../../evaluation/runs/baseline-wave1.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as {
      kind: string;
      reproduce: { commit: string };
      totals: { independentCases: number; labelledSignals: number; events: number };
      cases: {
        legacyId: string;
        caseId: string;
        derivedFrom: string | null;
        eventCount: number;
        eventsSha256: string;
        expected: string[];
        earliestMissed: string | null;
        causes: string[];
      }[];
    };
    expect(record.kind).toBe('historical');
    expect(record.reproduce.commit).toBe('c5f5d96');
    expect(record.totals).toMatchObject({ independentCases: 13, labelledSignals: 66, events: 83 });
    expect(record.cases).toHaveLength(16);
    for (const entry of record.cases) {
      const loaded = migrated(entry.legacyId);
      expect(loaded.case.id, entry.legacyId).toBe(entry.caseId);
      expect(loaded.case.events.length, entry.legacyId).toBe(entry.eventCount);
      expect(eventsDigest(loaded.case.events), entry.legacyId).toBe(entry.eventsSha256);
      if (entry.derivedFrom !== null) {
        expect(loaded.case.derivedFrom, entry.legacyId).toBe(wave1Id(entry.derivedFrom));
        continue;
      }
      const annotation = loaded.annotations?.annotations[0];
      expect(pairsOf(loaded), entry.legacyId).toEqual([...entry.expected].sort());
      expect(annotation?.earliestMissed, entry.legacyId).toBe(entry.earliestMissed);
      expect(annotation?.causes, entry.legacyId).toEqual(entry.causes);
    }
  });
});

/** The engine on the migrated cases only: what must hold whatever the detectors read. */
const run = evaluateSplit('dev', { annotator: WAVE1_ANNOTATOR, recommendations: false });

describe('[eval] the order in which events are handed over does not matter', () => {
  it('measures the 13 independent cases and checks the 3 copies against their sources', () => {
    expect(run.inputs).toHaveLength(13);
    expect(run.invariance).toHaveLength(3);
  });

  it.each(copies.map((loaded) => [loaded.case.id, loaded.case.derivedFrom ?? ''] as const))(
    '%s gives exactly the analysis of %s',
    (copy, source) => {
      const entry = run.invariance.find((candidate) => candidate.caseId === copy);
      expect(entry?.derivedFrom).toBe(source);
      expect(entry?.differences).toEqual([]);
      expect(entry?.identical).toBe(true);
    },
  );

  it('really hands the events over in another order', () => {
    for (const loaded of copies) {
      const handedOver = caseToBundle(loaded.case).events.map((event) => event.id);
      const byTime = [...caseToBundle(loaded.case).events]
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        .map((event) => event.id);
      expect(handedOver, loaded.case.id).not.toEqual(byTime);
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
    (legacyId) => {
      const input = run.inputs.find((candidate) => candidate.id === wave1Id(legacyId));
      expect(input?.engine.signals).toEqual([]);
      expect(input?.engine.forks).toEqual([]);
    },
  );

  it('stay silent as a group: every control with nothing to find raises nothing', () => {
    expect(run.metrics.rejection.negativeControls).toMatchObject({ successes: 3, n: 3 });
  });
});
