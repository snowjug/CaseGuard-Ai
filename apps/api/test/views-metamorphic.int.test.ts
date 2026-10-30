/*
 * METAMORPHIC TEMPORAL-INTEGRITY TEST (FR-TL-06, NFR-SEC-01)
 *
 * WHAT IT PROVES. An as-of response is a function of the record up to that instant and of nothing
 * else. For each sample case there is the REAL case (tenant A) and, for the instants tested, a
 * METAMORPHIC COPY of it (tenant B, the same case id) in which EVERYTHING AFTER the cut is rewritten:
 *   - the text, title, structured data, action and usage of every later event, and their instants
 *     (all moved 9 days later, which keeps their order and keeps them after the instant);
 *   - the resolution (summary, root cause, workaround, fix, validation, hypothesis key and time);
 *   - the closing time of the case;
 *   - the human input recorded after the instant: in each world one claim is relabelled with a note
 *     and one action-value override is recorded per instant, with different labels, notes, ranks,
 *     actions and times (the clock is months after the case) in the real case and in the copy.
 * The copy goes through the real normaliser and the repositories and is analysed by the real analysis
 * service, so its stored artefacts (claims, forks, warnings, run, input hash, source hash) are as
 * different from the real case's as the rewrite makes them. At every instant the twin, timeline,
 * evidence ledger, hypotheses, actions, action values, forks, graph, quality, metrics, warnings and
 * the last visible source event must then answer BYTE-IDENTICALLY in both worlds.
 *
 * MASKING. Only what names a world or a request rather than the case is masked: the tenant id, the
 * analysis run id, the ids derived from the run id (quality assessments and metric estimates carry the
 * run in their id) and the moment a view was generated (`generatedAt` is the clock of the request).
 *
 * WHAT IT DOES NOT PROVE. Both worlds share the code under test, so it shows independence from the
 * future, not that the past is analysed correctly (other suites compare against a fresh engine).
 * `coaching.get` has no `asOf`: it is the retrospective report of the finished case and depends on
 * the whole record by design, so it is not compared. Warning dismissals are not in the rewrite: a
 * finished case has no open stored warning to dismiss. The comparison is blind to anything the two
 * worlds share, for example a leak of the instant's own past.
 *
 * TEETH. The comparison is shown to be able to fail: the whole-record views of a copy differ from the
 * real case's (the future, the resolution and the reviewer input really were rewritten), and a copy
 * rewritten INSIDE the window is told apart from the real case.
 *
 * SAMPLING AND BOUND. A copy costs an ingestion, an analysis (about two seconds) and a cold pass per
 * instant in each world, so the instants are bounded by SAMPLES below and the file runs in about three
 * minutes:
 *   Case One: all 31 event times, 6 midpoints between two events and one instant before the first
 *     event (everything is then rewritten): 38 instants. Events 1 to 12 and the last have a copy of
 *     their own, cut right after them; from the 13th on, two neighbouring events share the copy cut
 *     after the second, so the first of them keeps one unrewritten event after it (the next one).
 *   Case Two: 6 of its 15 event times, 2 midpoints and one instant before the first event: 9 instants.
 * That is 47 instants in 30 copies. A midpoint is compared against the copy cut after the event before
 * it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCompiledPack } from '@caseguard/domain';
import type { CaseBundle, EvidenceCategory } from '@caseguard/schemas';
import { permissionsFor, type AuthContext } from '@caseguard/security';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { buildRequestContext } from '../src/http/context-factory';
import type { RequestContext } from '../src/http/request-context';
import { ENGINE_BUDGET_WINDOW_MS } from '../src/services/engine-budget';
import { overrideAction, reviewClaim, viewDepsFor } from '../src/services/views';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, loadSampleBundle, type SampleFile } from './support/samples';
import {
  FUTURE_MARK,
  firstDifference,
  ingestBundle,
  maskWorld,
  rewriteAfter,
} from './views-rewrite';

interface Sample {
  readonly name: string;
  readonly file: SampleFile;
  readonly caseId: string;
  /**
   * One copy per entry: everything after event `cut` (0-based, in time order) is rewritten, and the
   * copy is compared at the instants of the events in `at` (each at or before the cut).
   */
  readonly copies: readonly { readonly cut: number; readonly at: readonly number[] }[];
  /** A midpoint between event i and the next is compared too, against the copy cut after event i. */
  readonly midpointsAfter: readonly number[];
}

const tight = (indexes: readonly number[]) => indexes.map((cut) => ({ cut, at: [cut] }));
const paired = (firsts: readonly number[]) =>
  firsts.map((first) => ({ cut: first + 1, at: [first, first + 1] }));

/** The bound of this file: which instants of which sample are compared. */
const SAMPLES: readonly Sample[] = [
  {
    name: 'Case One',
    file: SAMPLE_FILES.caseOne,
    caseId: 'case_meta_one',
    copies: [
      ...tight(Array.from({ length: 12 }, (_, index) => index)),
      ...paired([12, 14, 16, 18, 20, 22, 24, 26, 28]),
      ...tight([30]),
    ],
    midpointsAfter: [1, 3, 6, 10, 15, 25],
  },
  {
    name: 'Case Two',
    file: SAMPLE_FILES.caseTwo,
    caseId: 'case_meta_two',
    copies: tight([0, 2, 5, 8, 11, 14]),
    midpointsAfter: [2, 8],
  },
];

const ANALYSED_AT = '2026-10-29T09:00:00.000Z';
const REAL_REVIEWED_AT = '2026-11-05T10:00:00.000Z';
const COPY_REVIEWED_AT = '2026-12-10T16:30:00.000Z';
const HOUR = 3_600_000;

interface Copy {
  readonly label: string;
  /** Index of the event the copy is cut after; -1 rewrites everything. */
  readonly cut: number;
  /** Everything recorded after this instant is rewritten in the copy. */
  readonly cutMs: number;
  /** The instants compared against the copy. */
  readonly instants: readonly string[];
}

interface Prepared {
  readonly bundle: CaseBundle;
  readonly rootKeys: readonly string[];
  /** Instants of the whole sample, for the reviewer input of the real case. */
  readonly all: readonly string[];
  readonly copies: readonly Copy[];
  readonly times: readonly string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

function prepare(sample: Sample): Prepared {
  const bundle = loadSampleBundle(sample.file);
  const pack = getCompiledPack(bundle.case.workload);
  if (pack === null) throw new Error(`No knowledge pack for ${bundle.case.workload}`);
  const times = bundle.events
    .map((event) => event.timestamp)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const first = Date.parse(times[0] ?? '');
  const copies: Copy[] = [
    {
      label: 'rewritten from the start, compared before the first event',
      cut: -1,
      cutMs: first - HOUR,
      instants: [iso(first - HOUR)],
    },
  ];
  for (const { cut, at } of sample.copies) {
    const cutAt = times[cut];
    if (cutAt === undefined) throw new Error(`${sample.name} has no event ${cut}`);
    const instants = at.map((index) => {
      const instant = times[index];
      if (instant === undefined || index > cut) throw new Error(`${sample.name}: bad plan`);
      return instant;
    });
    const next = times[cut + 1];
    if (sample.midpointsAfter.includes(cut) && next !== undefined) {
      const middle = Math.floor((Date.parse(cutAt) + Date.parse(next)) / 2);
      if (middle > Date.parse(cutAt) && middle < Date.parse(next)) instants.push(iso(middle));
    }
    copies.push({
      label: `rewritten after event ${cut + 1}, compared at ${instants.length} instant(s)`,
      cut,
      cutMs: Date.parse(cutAt),
      instants,
    });
  }
  for (const index of sample.midpointsAfter) {
    if (!sample.copies.some((copy) => copy.cut === index)) {
      throw new Error(`${sample.name}: no copy is cut after event ${index}`);
    }
  }
  return {
    bundle,
    rootKeys: pack.pack.hypotheses.map((hypothesis) => hypothesis.id),
    all: copies.flatMap((copy) => copy.instants),
    copies,
    times,
  };
}

let database: Database;
let real: Harness;
/** The claim the real case's reviewer relabelled: the copies relabel the same one. */
const reviewedClaim = new Map<string, string>();

function reviewerContext(harness: Harness, tenantId: string, userId: string): RequestContext {
  const auth: AuthContext = {
    userId,
    tenantId,
    displayName: 'Metamorphic Reviewer (synthetic)',
    roles: ['reviewer'],
    permissions: permissionsFor(['reviewer']),
    authMode: 'dev',
    synthetic: true,
    subject: userId,
    email: null,
  };
  return buildRequestContext(harness.infra, {
    requestId: 'req_metamorphic',
    auth,
    permission: null,
    signal: new AbortController().signal,
    logger: harness.infra.logger,
  });
}

/** A read as a persona, with a full engine budget (the clock only ever moves forward). */
function ask(harness: Harness, persona: string, path: string) {
  harness.clock.advance(ENGINE_BUDGET_WINDOW_MS);
  return harness.call(persona, { method: 'GET', url: path });
}

const at = (asOf: string): string => `asOf=${encodeURIComponent(asOf)}`;

interface LaterInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly instants: readonly string[];
  readonly category: (aiCategory: EvidenceCategory) => EvidenceCategory;
  readonly mark: string;
  readonly rank: 1 | 2;
  readonly action: 0 | 1;
  /** The claim to relabel, or null for the first pending claim of the case. */
  readonly claimId: string | null;
}

/**
 * The human input of one world, recorded long after the case: one relabelled claim and one override
 * per instant. It returns the claim it relabelled.
 */
async function recordLaterInput(
  harness: Harness,
  ctx: RequestContext,
  persona: string,
  input: LaterInput,
): Promise<string | null> {
  const repos = harness.repos(input.tenantId);
  const claims = (await repos.analysis.listClaims(input.caseId, { limit: 200 })).items;
  const pending = claims
    .filter((claim) => claim.reviewState === 'pending')
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const claim =
    input.claimId === null ? pending[0] : pending.find((item) => item.id === input.claimId);
  if (claim !== undefined) {
    harness.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    await reviewClaim(ctx, input.caseId, claim.id, {
      category: input.category(claim.aiCategory),
      reason: `${input.mark}: relabelled with hindsight, the later logs showed the cache was stale`,
      expectedVersion: claim.version,
    });
  }
  const deps = viewDepsFor(harness.infra);
  for (const instant of input.instants) {
    const ranked = (
      await ask(harness, persona, `/api/v1/cases/${input.caseId}/action-values?${at(instant)}`)
    ).data;
    const candidates = ranked.candidates as { actionKey: string }[];
    const target = candidates[Math.min(input.action, candidates.length - 1)];
    if (target === undefined) continue;
    harness.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    await overrideAction(ctx, deps, input.caseId, {
      asOf: instant,
      actionKey: target.actionKey,
      rank: Math.min(input.rank, candidates.length),
      reason: `${input.mark}: with hindsight this action should have come first`,
    });
  }
  return claim?.id ?? null;
}

beforeAll(async () => {
  database = await openSharedDatabase();
  real = await createHarness({ database });
  const analyst = contextFor(real, PERSONAS.engineer);
  for (const sample of SAMPLES) {
    const plan = prepare(sample);
    await ingestBundle(real.repos(CONTOSO), CONTOSO, sample.caseId, plan.bundle);
    real.clock.set(ANALYSED_AT);
    await real.infra.services.analysis.analyzeCase(analyst, sample.caseId);
    real.clock.set(REAL_REVIEWED_AT);
    const claimId = await recordLaterInput(
      real,
      contextFor(real, PERSONAS.reviewer),
      PERSONAS.engineer,
      {
        caseId: sample.caseId,
        tenantId: CONTOSO,
        instants: plan.all,
        category: (ai) => (ai === 'confirmed_fact' ? 'customer_reported' : 'confirmed_fact'),
        mark: 'REALREVIEW',
        rank: 1,
        action: 0,
        claimId: null,
      },
    );
    if (claimId === null) throw new Error(`${sample.name} has no claim to relabel`);
    reviewedClaim.set(sample.caseId, claimId);
  }
}, TEST_DATABASE_STARTUP_TIMEOUT_MS * 3);

afterAll(async () => {
  await real.close();
  await database.close();
});

/** What is compared at one instant of one case: every as-of read view, and the last visible event. */
function views(
  caseId: string,
  asOf: string,
  lastVisibleEventId: string | null,
): [string, string][] {
  const base = `/api/v1/cases/${caseId}`;
  const list: [string, string][] = [
    ['twin', `${base}/twin?${at(asOf)}`],
    ['timeline', `${base}/timeline?${at(asOf)}&limit=200`],
    ['evidence', `${base}/evidence?${at(asOf)}&limit=200`],
    ['hypotheses', `${base}/hypotheses?${at(asOf)}`],
    ['actions', `${base}/actions?${at(asOf)}`],
    ['action values', `${base}/action-values?${at(asOf)}`],
    ['forks', `${base}/forks?${at(asOf)}`],
    ['graph', `${base}/graph?${at(asOf)}`],
    ['quality', `${base}/quality?${at(asOf)}`],
    ['metrics', `${base}/metrics?${at(asOf)}`],
    ['warnings', `${base}/warnings?${at(asOf)}`],
  ];
  if (lastVisibleEventId !== null) {
    list.push(['event', `${base}/events/${lastVisibleEventId}?${at(asOf)}`]);
  }
  return list;
}

/** Every difference between the real case and the copy at one instant, named by view. */
async function compareAt(
  copy: Harness,
  plan: Prepared,
  caseId: string,
  asOf: string,
): Promise<{ differences: string[]; visible: number; compared: number }> {
  const visible = plan.bundle.events.filter(
    (event) => Date.parse(event.timestamp) <= Date.parse(asOf),
  );
  const last = [...visible].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  const differences: string[] = [];
  let compared = 0;
  const mask = (body: string): string => maskWorld(body, [FABRIKAM, CONTOSO]);
  for (const [name, path] of views(caseId, asOf, last?.id ?? null)) {
    const original = await ask(real, PERSONAS.engineer, path);
    const rewritten = await ask(copy, PERSONAS.otherTenantEngineer, path);
    if (original.statusCode !== 200 || rewritten.statusCode !== 200) {
      differences.push(`${asOf} ${name}: status ${original.statusCode} / ${rewritten.statusCode}`);
      continue;
    }
    const diff = firstDifference(mask(original.body), mask(rewritten.body));
    compared += original.body.length;
    if (rewritten.body.includes(FUTURE_MARK)) {
      differences.push(`${asOf} ${name}: carries rewritten text`);
    }
    if (diff !== null) {
      differences.push(
        `${asOf} ${name}: differs at ${diff.at}\n  real: ${diff.real}\n  copy: ${diff.copy}`,
      );
    }
    if (name === 'timeline') {
      // The view being compared is not vacuous: it holds exactly the events of the window.
      const events = (original.data.events as unknown[]).length;
      if (events !== visible.length) {
        differences.push(`${asOf} timeline: ${events} events, expected ${visible.length}`);
      }
    }
  }
  return { differences, visible: visible.length, compared };
}

/** Ingests, analyses and relabels one copy in a harness of its own (its clock starts and stays forward). */
async function makeCopy(
  sample: Sample,
  plan: Prepared,
  copy: Copy,
  shiftMs?: number,
): Promise<Harness> {
  const harness = await createHarness({ database });
  const repos = harness.repos(FABRIKAM);
  await repos.cases.delete(sample.caseId);
  expect(await repos.analysis.getLatestRun(sample.caseId)).toBeNull();
  const bundle = rewriteAfter(plan.bundle, copy.cutMs, plan.rootKeys, shiftMs);
  await ingestBundle(repos, FABRIKAM, sample.caseId, bundle);
  harness.clock.set(ANALYSED_AT);
  await harness.infra.services.analysis.analyzeCase(
    contextFor(harness, PERSONAS.otherTenantEngineer),
    sample.caseId,
  );
  harness.clock.set(COPY_REVIEWED_AT);
  await recordLaterInput(
    harness,
    reviewerContext(harness, FABRIKAM, 'user_fabi_reviewer'),
    PERSONAS.otherTenantEngineer,
    {
      caseId: sample.caseId,
      tenantId: FABRIKAM,
      instants: copy.instants,
      category: (ai) => (ai === 'ai_inference' ? 'engineer_assumption' : 'ai_inference'),
      mark: 'COPYREVIEW',
      rank: 2,
      action: 1,
      claimId: reviewedClaim.get(sample.caseId) ?? null,
    },
  );
  return harness;
}

for (const sample of SAMPLES) {
  describe(`${sample.name}: a copy with everything after the cut rewritten`, () => {
    const plan = prepare(sample);
    for (const copy of plan.copies) {
      it(`[FR-TL-06] ${copy.label}: every as-of view is byte-identical`, async () => {
        const harness = await makeCopy(sample, plan, copy);
        try {
          const found: string[] = [];
          for (const instant of copy.instants) {
            const result = await compareAt(harness, plan, sample.caseId, instant);
            found.push(...result.differences);
            expect(result.compared, instant).toBeGreaterThan(500);
          }
          expect(found).toEqual([]);

          // The comparison has teeth: the whole record of the copy is not the real case's.
          if (copy.instants.length > 1) {
            for (const name of ['evidence', 'timeline']) {
              const path = `/api/v1/cases/${sample.caseId}/${name}?limit=200`;
              const a = await ask(real, PERSONAS.engineer, path);
              const b = await ask(harness, PERSONAS.otherTenantEngineer, path);
              expect(maskWorld(b.body, [FABRIKAM, CONTOSO]), path).not.toBe(
                maskWorld(a.body, [FABRIKAM, CONTOSO]),
              );
            }
          }
        } finally {
          await harness.close();
        }
      }, 240_000);
    }
  });
}

describe('the comparison can fail', () => {
  it('[FR-TL-06] tells a copy rewritten inside the window from the real case', async () => {
    const sample = SAMPLES[0];
    if (sample === undefined) throw new Error('no sample');
    const plan = prepare(sample);
    const cut = plan.copies.find((copy) => copy.cut === 3);
    const instant = plan.times[14];
    if (cut === undefined || instant === undefined) throw new Error('the sample plan has changed');
    // The rewritten events keep their instants (a shift of 0), so the window sees the rewritten text.
    const harness = await makeCopy(sample, plan, cut, 0);
    try {
      const result = await compareAt(harness, plan, sample.caseId, instant);
      const named = new Set(result.differences.map((line) => line.split(': ')[0]?.split(' ')[1]));
      for (const view of ['timeline', 'evidence', 'hypotheses', 'quality', 'twin', 'graph']) {
        expect(named.has(view), `${view} should differ`).toBe(true);
      }
    } finally {
      await harness.close();
    }
  }, 240_000);

  it('[FR-TL-06] samples the instants it names, each once, including e02, e03, e07 and e15', () => {
    for (const sample of SAMPLES) {
      const plan = prepare(sample);
      const instants = plan.copies.flatMap((copy) => copy.instants);
      expect(new Set(instants).size).toBe(instants.length);
      expect(plan.copies).toHaveLength(sample.copies.length + 1);
      const events = sample.copies.reduce((sum, copy) => sum + copy.at.length, 0);
      expect(instants).toHaveLength(events + sample.midpointsAfter.length + 1);
    }
    const [one] = SAMPLES;
    if (one === undefined) throw new Error('no sample');
    const plan = prepare(one);
    const instants = plan.copies.flatMap((copy) => copy.instants);
    // Case One is tested at every one of its event times.
    for (const event of plan.bundle.events) expect(instants, event.id).toContain(event.timestamp);
    for (const id of ['e02', 'e03', 'e07', 'e15']) {
      const event = plan.bundle.events.find((candidate) => candidate.id === id);
      expect(instants, id).toContain(event?.timestamp);
    }
  });
});
