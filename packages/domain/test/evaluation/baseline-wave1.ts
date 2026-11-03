import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineVersion } from './artifact';
import { TOOL_EVENT_TYPES } from './bundle';
import { EVALUATION_ROOT, REPOSITORY_ROOT, eventsDigest, writeJson } from './dataset';
import { enginePackIdentity } from './engine';
import { evaluateSplit } from './evaluate';
import { WAVE1_ANNOTATOR, WAVE1_COMMIT, WAVE1_PLAN, wave1Id } from './wave1-plan';

/**
 * One-off: writes `evaluation/runs/baseline-wave1.json`, the record of what the Wave 1 harness measured on the 16 cases
 * of its independent evaluation set. It is HISTORY, not a test: detectors improve, so the live engine moves away from
 * these numbers, and nothing pins them.
 *
 * The numbers come from the old harness itself (`evaluate.ts` of commit c5f5d96, read from git into a scratch directory
 * next to this file and removed afterwards), run on the old corpus with the engine of that commit. Before writing, the
 * file is checked against the framework v2 harness on the migrated cases: signal by signal, decision point by decision
 * point, leader by leader, they must agree, which is the proof that the migration lost nothing. Run it once, on a tree
 * whose engine source is that of c5f5d96 (`git diff c5f5d96 -- packages/domain/src` is empty):
 *
 *   pnpm --filter @caseguard/domain exec tsx test/evaluation/baseline-wave1.ts
 */

const LEGACY_DIRECTORY = 'packages/domain/test/evaluation';
const LEGACY_FILES = [
  'types.ts',
  'corpus-paraphrase.ts',
  'corpus-other.ts',
  'evaluate.ts',
] as const;

interface LegacyEvent {
  key: string;
  at: number;
  who: string;
  type: string;
  channel?: string;
  title?: string;
  text: string;
  signals?: readonly string[];
}
interface LegacyCase {
  id: string;
  group: string;
  about: string;
  events: readonly LegacyEvent[];
  earliestMissed: string | null;
  causes?: readonly string[];
  basedOn?: string;
}
interface LegacyResult {
  id: string;
  group: string;
  truePositives: string[];
  falsePositives: string[];
  misses: string[];
  missCauses: Record<string, string>;
  forkCount: number;
  earliestFork: string | null;
  expectedFork: string | null;
  forkAgreement: string;
  leader: string;
  leaderConfidence: number;
  leaderAgreement: string;
  causeRank: number | null;
  causeConfidence: number | null;
  causePrior: number | null;
}
interface LegacyRate {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}
interface LegacyModule {
  EVAL_CASES: readonly LegacyCase[];
  evaluateAll(): { results: LegacyResult[]; scored: LegacyResult[] };
  rate(results: readonly LegacyResult[]): LegacyRate;
  missSummary(results: readonly LegacyResult[]): Record<string, number>;
  reachableRecall(results: readonly LegacyResult[]): number | null;
  rateBySignal(results: readonly LegacyResult[]): Map<string, LegacyRate>;
  leaderSummary(results: readonly LegacyResult[]): Record<string, number>;
  forkSummary(results: readonly LegacyResult[]): Record<string, number>;
}

function readLegacyHarness(scratch: string): Promise<LegacyModule> {
  mkdirSync(scratch, { recursive: true });
  for (const name of LEGACY_FILES) {
    let source = execFileSync('git', ['show', `${WAVE1_COMMIT}:${LEGACY_DIRECTORY}/${name}`], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    // The scratch directory is one level deeper than the directory the files were written for.
    source = source
      .replace("from '../../src'", "from '../../../src'")
      .replace("from '../helpers'", "from '../../helpers'");
    writeFileSync(join(scratch, name), source);
  }
  return import(pathToFileURL(join(scratch, 'evaluate.ts')).href) as Promise<LegacyModule>;
}

const sorted = (items: readonly string[]): string[] => [...items].sort();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  const scratch = join(import.meta.dirname, '.legacy-wave1');
  try {
    const legacy = await readLegacyHarness(scratch);
    const { results, scored } = legacy.evaluateAll();
    const byLegacyId = new Map(results.map((result) => [result.id, result]));
    const casesById = new Map(legacy.EVAL_CASES.map((entry) => [entry.id, entry]));

    const cases = WAVE1_PLAN.map((plan) => {
      const source = casesById.get(plan.legacyId);
      const result = byLegacyId.get(plan.legacyId);
      if (!source || !result) throw new Error(`the old harness has no case ${plan.legacyId}`);
      const expected = source.events.flatMap((event) =>
        (event.signals ?? []).map((signal) => `${event.key}|${signal}`),
      );
      return {
        legacyId: plan.legacyId,
        caseId: wave1Id(plan.legacyId),
        group: source.group,
        derivedFrom: source.basedOn ?? null,
        eventCount: source.events.length,
        eventsSha256: eventsDigest(
          source.events.map((event) => ({
            key: event.key,
            at: event.at,
            who: event.who,
            type: event.type,
            channel:
              event.channel ??
              ((TOOL_EVENT_TYPES as ReadonlySet<string>).has(event.type) ? 'tool' : 'email'),
            title: event.title,
            text: event.text,
          })),
        ),
        expected: sorted(expected),
        earliestMissed: source.earliestMissed,
        causes: [...(source.causes ?? [])],
        reported: sorted([...result.truePositives, ...result.falsePositives]),
        truePositives: result.truePositives,
        falsePositives: result.falsePositives,
        misses: result.misses,
        missCauses: result.missCauses,
        forkCount: result.forkCount,
        earliestFork: result.earliestFork,
        expectedFork: result.expectedFork,
        forkAgreement: result.forkAgreement,
        leader: result.leader,
        leaderConfidence: result.leaderConfidence,
        leaderAgreement: result.leaderAgreement,
        causeRank: result.causeRank,
        causeConfidence: result.causeConfidence,
        causePrior: result.causePrior,
      };
    });

    const group = (name: string) => legacy.rate(scored.filter((result) => result.group === name));
    const pack = enginePackIdentity();
    const version = engineVersion();
    const baseline = {
      schema: 'caseguard.eval-baseline/1',
      kind: 'historical',
      description:
        'What the Wave 1 harness measured on the 16 cases of its independent evaluation set (13 independent cases, 3 reordered copies), with the engine and knowledge pack of that time. It is a historical record, not a test: detectors improve, so the live engine moves away from these numbers and nothing pins them.',
      reproduce: {
        commit: WAVE1_COMMIT,
        commands: [
          'git checkout c5f5d96',
          'pnpm install --frozen-lockfile',
          'pnpm --filter @caseguard/domain run eval',
        ],
        note: 'The old harness, its TypeScript corpus and its report script exist only at that commit and before. This file was derived from that harness on the migrated cases, then checked against the framework v2 harness (see migration.checkedAgainst).',
      },
      engine: {
        version: version.version,
        package: version.package,
        source: 'ENGINE_VERSION in apps/api/src/services/analysis/inputs.ts',
      },
      pack: { id: pack.id, version: pack.version },
      annotator: WAVE1_ANNOTATOR,
      totals: {
        cases: results.length,
        independentCases: scored.length,
        reorderedCopies: results.length - scored.length,
        events: cases
          .filter((entry) => entry.derivedFrom === null)
          .reduce((sum, entry) => sum + entry.eventCount, 0),
        labelledSignals: cases
          .filter((entry) => entry.derivedFrom === null)
          .reduce((sum, entry) => sum + entry.expected.length, 0),
      },
      groups: {
        paraphrase: group('paraphrase'),
        noisy: group('noisy'),
        negative: group('negative'),
        all: legacy.rate(scored),
      },
      missCauses: legacy.missSummary(scored),
      reachableRecall: legacy.reachableRecall(scored),
      perSignal: [...legacy.rateBySignal(scored).entries()].map(([signal, rate]) => ({
        signal,
        ...rate,
      })),
      forkAgreement: legacy.forkSummary(scored),
      leaderAgreement: legacy.leaderSummary(scored),
      migration: {
        annotatorOfTheMigratedLabels: WAVE1_ANNOTATOR,
        caseIds: Object.fromEntries(cases.map((entry) => [entry.legacyId, entry.caseId])),
        checkedAgainst:
          'framework v2 harness (evaluateSplit on the migrated cases of the dev split)',
      },
      cases,
    };

    // The framework v2 harness, on the migrated cases only, must say what the old one said.
    const live = evaluateSplit('dev', { annotator: WAVE1_ANNOTATOR, recommendations: false });
    const problems: string[] = [];
    for (const entry of cases.filter((candidate) => candidate.derivedFrom === null)) {
      const detail = live.details.find((candidate) => candidate.id === entry.caseId);
      if (!detail?.signals) {
        problems.push(`${entry.legacyId}: not measured by the framework v2 harness`);
        continue;
      }
      if (!same(sorted(detail.signals.tp), sorted(entry.truePositives)))
        problems.push(`${entry.legacyId}: reported-and-labelled signals differ`);
      if (!same(sorted(detail.signals.fp), sorted(entry.falsePositives)))
        problems.push(`${entry.legacyId}: reported-only signals differ`);
      if (!same(sorted(detail.signals.fn), sorted(entry.misses)))
        problems.push(`${entry.legacyId}: labelled-only signals differ`);
      if (detail.earliest?.agreement !== entry.forkAgreement)
        problems.push(`${entry.legacyId}: earliest decision point agreement differs`);
      if ((detail.leader?.agreement ?? 'n/a') !== entry.leaderAgreement)
        problems.push(`${entry.legacyId}: leader agreement differs`);
    }
    const overall = live.metrics.signals.overall;
    const legacyAll = baseline.groups.all;
    if (overall.tp !== legacyAll.tp || overall.fp !== legacyAll.fp || overall.fn !== legacyAll.fn) {
      problems.push(
        `totals differ: ${overall.tp}/${overall.fp}/${overall.fn} against ${legacyAll.tp}/${legacyAll.fp}/${legacyAll.fn}`,
      );
    }
    if (live.invariance.length !== 3 || live.invariance.some((entry) => !entry.identical))
      problems.push('a reordered copy does not give the analysis of its source');
    if (problems.length > 0)
      throw new Error(
        `The framework v2 harness does not reproduce the Wave 1 harness:\n${problems.join('\n')}`,
      );

    await writeJson(join(EVALUATION_ROOT, 'runs', 'baseline-wave1.json'), baseline);
    process.stdout.write(
      `wrote evaluation/runs/baseline-wave1.json: ${baseline.groups.all.tp} read, ${baseline.groups.all.fp} not labelled, ${baseline.groups.all.fn} missed; the framework v2 harness agrees\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
