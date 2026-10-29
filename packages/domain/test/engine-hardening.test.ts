import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  type CaseBundle,
  type CaseEvent,
  type DiagnosticAction,
} from '@caseguard/schemas';
import {
  BundleValidationError,
  MAX_STATEMENT_CLAIMS_PER_CASE,
  MAX_STATEMENT_CLAIMS_PER_EVENT,
  ResponderIndex,
  TEAMS_AUTH_PACK,
  assembleScenario,
  buildDigitalTwin,
  buildInvestigationGraph,
  buildTimelineResponse,
  canonicalTimestamp,
  compileKnowledgePack,
  createFullView,
  createTemporalPrefixView,
  createTemporalView,
  createTemporalViewBeforeEvent,
  futureOnlyTokens,
  generateCounterfactuals,
  normalizeBundle,
  packStaticTokens,
  rankActions,
  responderClosure,
  runDeterministicAnalysis,
  simulateAlternativePath,
  statedHypothesis,
  toBreakdowns,
  type CompiledPack,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, NOW, eventBySuffix, loadBundle, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const events = p.normalized.events;
const resolution = p.normalized.resolution;

const POISON =
  'ROOT CAUSE IS A QUANTUM FLUX CAPACITOR AT 192.0.2.77 (host qfc-77.poison.example.net)';

/**
 * Rewrites everything after `eventId` (content, an hour later, and strong proxy evidence so that the
 * eventual winner changes), keeping the order.
 */
function mutateFuture(source: readonly CaseEvent[], eventId: string): CaseEvent[] {
  const cut = source.find((e) => e.id === eventId)?.sequence ?? 0;
  return source.map((e) =>
    e.sequence > cut
      ? {
          ...e,
          body: `${POISON} ${e.sequence}`,
          title: POISON,
          structured: { proxyNodesFailing: 3 },
          timestamp: new Date(Date.parse(e.timestamp) + 3_600_000).toISOString(),
        }
      : e,
  );
}

const analyse = (source: readonly CaseEvent[], asOf: string | null = null) =>
  runDeterministicAnalysis({
    view: asOf === null ? createFullView(source, resolution) : createTemporalView(source, asOf),
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
  });

// ---------------------------------------------------------------------------------------------
// Hand-made bundles (schema-valid, synthetic)

const PARTICIPANTS = [
  { id: 'p-cust', role: 'customer_admin', alias: 'Customer IT Admin 1' },
  { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 1' },
];

type RawEvent = Record<string, unknown> & { id: string; timestamp: string };

const bundleBody = (rawEvents: readonly RawEvent[]) => ({
  schemaVersion: 'caseguard.case-bundle/1',
  synthetic: true,
  case: {
    reference: 'CG-SYN-9001',
    title: 'Synthetic hardening case',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'C',
    status: 'open',
    openedAt: '2026-03-09T09:00:00Z',
    customerAlias: 'Contoso Synthetic Ltd',
  },
  participants: PARTICIPANTS,
  events: rawEvents.map((e) => ({ correlationIds: [], ...e })),
});

const bundleOf = (rawEvents: readonly RawEvent[]): CaseBundle =>
  CaseBundleSchema.parse(bundleBody(rawEvents));

function normalized(bundle: CaseBundle) {
  return normalizeBundle(bundle, {
    tenantId: 'tenant_test',
    caseId: 'case_hardening',
    sourceId: 'src_test',
    createdBy: 'test',
    now: NOW,
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(bundle),
    redactionReplacements: 0,
  });
}

const customer = (id: string, timestamp: string, body: string, extra: object = {}): RawEvent => ({
  id,
  timestamp,
  participantId: 'p-cust',
  type: 'customer_email',
  body,
  ...extra,
});
const engineer = (id: string, timestamp: string, body: string, extra: object = {}): RawEvent => ({
  id,
  timestamp,
  participantId: 'p-eng',
  type: 'engineer_action',
  body,
  action: {
    actionKey: 'act.dns-resolver-comparison',
    label: 'Compare resolvers',
    customerEffort: 'low',
  },
  ...extra,
});

/** Every event answers the previous one: the worst case for reply-closure bookkeeping. */
function chainEvents(count: number): RawEvent[] {
  const start = Date.parse('2026-03-09T09:00:00Z');
  return Array.from({ length: count }, (_, i) => {
    const id = `c${String(i).padStart(4, '0')}`;
    const at = new Date(start + i * 600_000).toISOString().replace('.000Z', 'Z');
    const reply = i > 0 ? { inResponseTo: `c${String(i - 1).padStart(4, '0')}` } : {};
    return i % 2 === 0
      ? customer(
          id,
          at,
          `Users still cannot sign in, ERR_NAME_NOT_RESOLVED again (round ${i}).`,
          reply,
        )
      : engineer(id, at, `Compared the DNS resolvers again (round ${i}).`, reply);
  });
}

// ---------------------------------------------------------------------------------------------
describe('[FR-TL-06] the as-of timeline ranks hypotheses by what was believed at asOf', () => {
  const cuts = ['e02', 'e03', 'e04', 'e05', 'e06', 'e07'];
  const finalOrder = [...p.analysis.hypotheses]
    .sort((a, b) => b.currentConfidence - a.currentConfidence)
    .slice(0, 5)
    .map((h) => h.key);

  for (const suffix of cuts) {
    it(`at ${suffix} the order equals a faithful as-of re-analysis, not the final ranking`, () => {
      const asOf = eventBySuffix(p, suffix).timestamp;
      const replay = analyse(events, asOf);
      const expected = [...replay.hypotheses]
        .sort((a, b) => b.currentConfidence - a.currentConfidence)
        .slice(0, 5)
        .map((h) => h.key);
      const response = buildTimelineResponse({
        caseRecord: p.normalized.case,
        events,
        analysis: p.analysis,
        asOf,
      });
      expect(response.hypothesisSeries.map((s) => s.key)).toEqual(expected);
      expect(expected).not.toEqual(finalOrder);
    });
  }

  it('does not depend on events after asOf (rewriting them changes nothing visible)', () => {
    const asOf = eventBySuffix(p, 'e04').timestamp;
    const mutated = mutateFuture(events, eventBySuffix(p, 'e04').id);
    const leaderOf = (source: readonly CaseEvent[]) =>
      [...analyse(source).hypotheses].sort((a, b) => b.currentConfidence - a.currentConfidence)[0]
        ?.key;
    // The rewrite really does change who wins in the end, so the check below can see a leak.
    expect(leaderOf(mutated)).not.toBe(leaderOf(events));
    const at = (source: readonly CaseEvent[]) =>
      JSON.stringify(
        buildTimelineResponse({
          caseRecord: p.normalized.case,
          events: source,
          analysis: analyse(source),
          asOf,
        }),
      );
    expect(at(mutated)).toBe(at(events));
  });

  it('keeps ordering the whole record by final confidence when asOf is null', () => {
    const response = buildTimelineResponse({
      caseRecord: p.normalized.case,
      events,
      analysis: p.analysis,
      asOf: null,
    });
    expect(response.hypothesisSeries.map((s) => s.key)).toEqual(finalOrder);
  });
});

// ---------------------------------------------------------------------------------------------
describe('[FR-TL-06] the as-of graph shows only what was known at asOf', () => {
  const graphAt = (
    analysis: typeof p.analysis,
    source: readonly CaseEvent[],
    asOf: string | null,
  ) =>
    buildInvestigationGraph({
      caseTitle: p.normalized.case.title,
      caseId: p.ctx.caseId,
      events: source,
      analysis,
      asOf,
      now: NOW,
    });
  const actionNodes = (g: ReturnType<typeof graphAt>) => g.nodes.filter((n) => n.kind === 'action');

  it('prints 0 bits for the e03 request instead of the 1.22 bits its later answers produced', () => {
    const e03 = eventBySuffix(p, 'e03');
    const stored = p.analysis.actions.find((a) => a.eventId === e03.id);
    expect(stored?.realizedInformationGainBits).toBeGreaterThan(0.5);
    const node = actionNodes(graphAt(p.analysis, events, e03.timestamp)).find((n) =>
      n.refs.some((r) => r.type === 'event' && r.id === e03.id),
    );
    expect(node?.detail).toContain('0 bits gained');
    expect(node?.detail).not.toContain(String(stored?.realizedInformationGainBits.toFixed(1)));
  });

  for (const suffix of ['e03', 'e05', 'e09', 'e13']) {
    it(`at ${suffix} the whole graph equals the one built from a faithful as-of re-analysis`, () => {
      const asOf = eventBySuffix(p, suffix).timestamp;
      const replayView = createTemporalView(events, asOf);
      const replay = analyse(events, asOf);
      expect(JSON.stringify(graphAt(p.analysis, events, asOf))).toBe(
        JSON.stringify(graphAt(replay, replayView.events, asOf)),
      );
    });
  }

  it('is identical when every later event is rewritten', () => {
    const e03 = eventBySuffix(p, 'e03');
    const mutated = mutateFuture(events, e03.id);
    const at = (source: readonly CaseEvent[]) =>
      JSON.stringify(graphAt(analyse(source), source, e03.timestamp));
    expect(at(mutated)).toBe(at(events));
  });

  it('colours steps from decision-time fields only, ignoring the stored hindsight', () => {
    const asOf = eventBySuffix(p, 'e13').timestamp;
    const hindsightFlipped = {
      ...p.analysis,
      actions: p.analysis.actions.map((a): DiagnosticAction => ({
        ...a,
        realizedInformationGainBits: 9,
        informationGainClass: a.informationGainClass === 'none' ? 'high' : 'none',
      })),
    };
    expect(JSON.stringify(graphAt(hindsightFlipped, events, asOf))).toBe(
      JSON.stringify(graphAt(p.analysis, events, asOf)),
    );
    // The whole-record view is retrospective and still reads the stored class.
    expect(JSON.stringify(actionNodes(graphAt(hindsightFlipped, events, null)))).not.toBe(
      JSON.stringify(actionNodes(graphAt(p.analysis, events, null))),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('reply closure is indexed (no per-call scan of the whole case)', () => {
  /** The previous implementation: scans every event for every queue entry. */
  function legacyClosure(source: readonly CaseEvent[], eventId: string): string[] {
    const out: string[] = [];
    const queue = [eventId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const e of source) {
        if (e.inResponseTo === current && !seen.has(e.id)) {
          seen.add(e.id);
          out.push(e.id);
          queue.push(e.id);
        }
      }
    }
    return out;
  }

  it('returns exactly what the scanning implementation returned, in the same order', () => {
    const index = new ResponderIndex(events);
    for (const e of events) {
      expect(index.closure(e.id).map((x) => x.id)).toEqual(legacyClosure(events, e.id));
      expect(responderClosure(events, e.id).map((x) => x.id)).toEqual(legacyClosure(events, e.id));
    }
  });

  it('answers 2,000 closures over a 2,000-event reply chain quickly (was ~75 s per pass)', () => {
    const chain = normalized(bundleOf(chainEvents(2000))).events;
    const start = performance.now();
    const index = new ResponderIndex(chain);
    let visited = 0;
    for (const e of chain) visited += index.closure(e.id).length;
    expect(visited).toBe((1999 * 2000) / 2);
    expect(performance.now() - start).toBeLessThan(5000);

    // The event-list form rebuilds the index on every call; it must still be far from the old scan.
    const rebuilt = performance.now();
    let again = 0;
    for (const e of chain) again += responderClosure(chain, e.id).length;
    expect(again).toBe(visited);
    expect(performance.now() - rebuilt).toBeLessThan(10_000);
  }, 120_000);

  it('credits an action with the information of its whole answer chain, however deep', () => {
    const chain = normalized(bundleOf(chainEvents(120)));
    const view = createFullView(chain.events, null);
    const analysis = runDeterministicAnalysis({ view, pack: p.pack, config: CONFIG, ctx: p.ctx });
    const gain = new Map(analysis.timeline.steps.map((s) => [s.eventId, s.gainBits]));
    for (const action of analysis.actions) {
      const involved = [action.eventId, ...legacyClosure(chain.events, action.eventId)];
      const expected = involved.reduce((sum, id) => sum + (gain.get(id) ?? 0), 0);
      expect(action.realizedInformationGainBits).toBe(Math.round(expected * 1000) / 1000);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('[NFR-SEC-05] the leak check cannot be used for denial of service', () => {
  // The unrestricted pattern the engine used before the hardening pass.
  const LEGACY =
    /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+){2,}|[a-z]{2,}\d{2,}[a-z0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,})\b/gi;
  const legacyTokens = (text: string) =>
    new Set((text.match(LEGACY) ?? []).map((t) => t.toLowerCase()));

  /** A one-event boundary followed by `later` events that carry `body` (built without the 20,000-character schema limit). */
  function futureOf(bodies: readonly string[]) {
    const raw: RawEvent[] = [
      customer('t000', '2026-03-09T09:00:00Z', 'Users cannot sign in.'),
      ...bodies.map((body, i) =>
        engineer(
          `t${String(i + 1).padStart(3, '0')}`,
          `2026-03-09T09:${String(i + 1).padStart(2, '0')}:00Z`,
          body,
          { type: 'case_note', action: undefined },
        ),
      ),
    ];
    const source = normalized(bundleBody(raw) as unknown as CaseBundle).events;
    return { source, pre: createTemporalViewBeforeEvent(source, source[1]?.id ?? '') };
  }

  it('scans 20 events of "a-" x 10,000 in well under a second (was ~22 s)', () => {
    const { source, pre } = futureOf(Array.from({ length: 20 }, () => 'a-'.repeat(10_000)));
    const start = performance.now();
    const tokens = futureOnlyTokens(source, pre, '');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(tokens.size).toBe(0);
  });

  it('stays linear for other hostile runs and caps the text it scans', () => {
    const hostile = [
      '_' + 'a-'.repeat(10_000),
      'ab-'.repeat(6000) + '.x',
      '-'.repeat(20_000),
      'a.'.repeat(10_000),
    ];
    const { source, pre } = futureOf(hostile);
    const start = performance.now();
    futureOnlyTokens(source, pre, '');
    expect(performance.now() - start).toBeLessThan(1000);
    const huge = futureOf([`${'z'.repeat(40_000)} host.example.test.invalid 10.9.8.7`]);
    // Text beyond the scan cap is not read, so a token placed after it is not reported.
    expect(futureOnlyTokens(huge.source, huge.pre, '').has('10.9.8.7')).toBe(false);
  });

  it('extracts the same identifiers as the unrestricted pattern on realistic text', () => {
    const texts = [
      ...events.flatMap((e) => [`${e.title ?? ''} ${e.body}`]),
      `${resolution?.summary ?? ''} ${resolution?.rootCause ?? ''}`,
      'Resolver 10.20.1.10 and 10.20.1.11 returned NXDOMAIN for login.microsoftonline.com and aadcdn.msftauth.net; error AADSTS50076, code caa82ee7, session 8c1d2f64-3a1e-4f0b-9d55-0a7d1e6b2c01.',
      'See dc1-corp.contoso-synthetic.invalid, proxy-eu-west-01.corp.example.test and x-y-z.a-b.c-d.example.',
    ];
    for (const text of texts) {
      const { source, pre } = futureOf([text]);
      expect(futureOnlyTokens(source, pre, '')).toEqual(
        legacyTokens(`${source[1]?.title ?? ''} ${text}`),
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('statement claims are bounded and selected deterministically', () => {
  const wall = (count: number, body: string) =>
    bundleOf(
      Array.from({ length: count }, (_, i) =>
        engineer(
          `h${String(i).padStart(3, '0')}`,
          new Date(Date.parse('2026-03-09T09:00:00Z') + i * 60_000)
            .toISOString()
            .replace('.000Z', 'Z'),
          body,
          {
            type: 'case_note',
            action: undefined,
          },
        ),
      ),
    );
  const statementClaims = (analysis: ReturnType<typeof analyse>) =>
    analysis.claims.filter((c) => c.ruleId.startsWith('statement.'));

  it('turns 100 x 20,000 characters of "Likely. " into a bounded set of claims, quickly', () => {
    const bundle = wall(100, 'Likely. '.repeat(2500));
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThan(2_097_152);
    const n = normalized(bundle);
    const start = performance.now();
    const analysis = runDeterministicAnalysis({
      view: createFullView(n.events, null),
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(20_000); // was ~41 s with 250,006 claims and 262 MB
    expect(statementClaims(analysis).length).toBeLessThanOrEqual(
      100 * MAX_STATEMENT_CLAIMS_PER_EVENT,
    );
    expect(analysis.claims.length).toBeLessThan(2000);
    expect(analysis.notes.join(' ')).toMatch(/per event/);
    expect(analysis.notes.join(' ')).toContain('100 events');
  }, 60_000);

  it('keeps the strongest sentences first, then the earliest, in sentence order', () => {
    const body = `${'Likely a cache problem. '.repeat(30)}The root cause is the DNS resolver policy.`;
    const n = normalized(wall(1, body));
    const analysis = runDeterministicAnalysis({
      view: createFullView(n.events, null),
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
    const claims = statementClaims(analysis);
    expect(claims).toHaveLength(MAX_STATEMENT_CLAIMS_PER_EVENT);
    expect(claims.some((c) => /root cause is the DNS resolver policy/.test(c.text))).toBe(true);
    // Claims are ordered by time then id; the kept sentences are the root-cause statement plus the
    // earliest 11 hedged ones.
    const starts = claims.map((c) => c.sourceRef?.start ?? -1).sort((a, b) => a - b);
    expect(starts).toEqual([...Array.from({ length: 11 }, (_, i) => i * 24), 30 * 24]);
    expect(JSON.stringify(analysis.claims)).toBe(
      JSON.stringify(
        runDeterministicAnalysis({
          view: createFullView(n.events, null),
          pack: p.pack,
          config: CONFIG,
          ctx: p.ctx,
        }).claims,
      ),
    );
  });

  it('applies a case-wide limit and says so', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Probably cause ${i}.`).join(' ');
    const n = normalized(wall(200, sentences));
    const analysis = runDeterministicAnalysis({
      view: createFullView(n.events, null),
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
    expect(statementClaims(analysis)).toHaveLength(MAX_STATEMENT_CLAIMS_PER_CASE);
    expect(analysis.notes.join(' ')).toMatch(/case-wide limit/);
  }, 60_000);

  it('reports nothing for the synthetic cases, which stay far below the limits', () => {
    expect(p.analysis.notes).toEqual([]);
    expect(prepareCase(CASE_TWO).analysis.notes).toEqual([]);
  });

  it('counts keyword hits with regexes built once, exactly as before', () => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacy = (text: string, pack: CompiledPack): string | null => {
      const lower = text.toLowerCase();
      let best: { id: string; hits: number; prior: number } | null = null;
      for (const h of pack.pack.hypotheses) {
        const hits = h.keywords.reduce((sum, keyword) => {
          const needle = keyword.toLowerCase();
          const tail = needle.length <= 4 ? '(?![\\w])' : '';
          const found = lower.match(new RegExp(`(?<![\\w])${escape(needle)}${tail}`, 'g'));
          return sum + (found ? found.length : 0);
        }, 0);
        if (
          hits > 0 &&
          (best === null || hits > best.hits || (hits === best.hits && h.prior > best.prior))
        ) {
          best = { id: h.id, hits, prior: h.prior };
        }
      }
      return best?.id ?? null;
    };
    const samples = [
      ...prepareCase(CASE_ONE).normalized.events.map((e) => e.body),
      ...prepareCase(CASE_TWO).normalized.events.map((e) => e.body),
      'The DNS resolver policy, a proxy node and the conditional access rule all look suspicious.',
      '',
    ];
    for (const text of samples) expect(statedHypothesis(text, p.pack)).toBe(legacy(text, p.pack));
    for (const patterns of p.pack.keywordPatterns.values())
      for (const pattern of patterns) expect(pattern.lastIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('repeat detection compares each action with its predecessors cheaply', () => {
  const same = 'Compared the resolver answers for the sign-in hosts from two sites.';
  const run = (rawEvents: readonly RawEvent[]) => {
    const n = normalized(bundleOf(rawEvents));
    return runDeterministicAnalysis({
      view: createFullView(n.events, null),
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
  };

  it('keeps its rules: similar wording, a repeat cue, and nothing outside the 48 h window', () => {
    const analysis = run([
      engineer('a01', '2026-03-09T09:00:00Z', same),
      engineer('a02', '2026-03-09T10:00:00Z', same),
      engineer(
        'a03',
        '2026-03-09T11:00:00Z',
        'Reviewed the packet capture alpha beta gamma delta.',
      ),
      engineer(
        'a04',
        '2026-03-09T12:00:00Z',
        'Ran the resolver comparison again for the other site.',
      ),
      engineer('a05', '2026-03-12T09:00:00Z', same),
    ]);
    const of = (id: string) => analysis.actions.find((a) => a.eventId === id);
    const first = of('a01');
    expect(first?.repeatOfActionId).toBeNull();
    expect(of('a02')?.repeatOfActionId).toBe(first?.id);
    expect(of('a03')?.repeatOfActionId).toBeNull();
    expect(of('a04')?.repeatOfActionId).toBe(first?.id);
    expect(of('a05')?.repeatOfActionId).toBeNull();
  });

  it('analyses 600 same-key actions with distinct 150-word bodies in bounded time (was ~30 s)', () => {
    const start = Date.parse('2026-03-09T09:00:00Z');
    const bundle = Array.from({ length: 600 }, (_, i) =>
      engineer(
        `b${String(i).padStart(4, '0')}`,
        new Date(start + i * 60_000).toISOString().replace('.000Z', 'Z'),
        Array.from({ length: 150 }, (_, j) => `x${i}y${j}z`).join(' '),
      ),
    );
    const began = performance.now();
    const analysis = run(bundle);
    expect(analysis.actions).toHaveLength(600);
    expect(performance.now() - began).toBeLessThan(12_000);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('[FR-CF-02] the leak check ignores identifiers that come from the pack itself', () => {
  const e03 = eventBySuffix(p, 'e03');
  const pre = createTemporalViewBeforeEvent(events, e03.id);
  const resolutionText = resolution
    ? `${resolution.summary} ${resolution.rootCause} ${resolution.workaround ?? ''} ${resolution.permanentFix ?? ''}`
    : '';
  const packTokens = packStaticTokens(p.pack);
  const fork = p.analysis.forks.find((f) => f.eventId === e03.id);
  if (!fork) throw new Error('expected a fork at e03');
  const minimalScoping = p.pack.actions.get('act.request-minimal-scoping');
  const packOutcome = minimalScoping?.outcomes.find((o) => /caa82ee7/.test(o.simulatedResult));

  const scenarioWith = (futureTokens: ReadonlySet<string>, simulatedResult?: string) => {
    const sim = simulateAlternativePath({
      preView: pre,
      fork,
      strategy: 'balanced',
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 20,
    });
    const first = sim.steps[0];
    if (!first) throw new Error('expected a simulated step');
    if (simulatedResult !== undefined) first.outcome = { ...first.outcome, simulatedResult };
    const actual = generateCounterfactuals({
      analysis: p.analysis,
      fork,
      strategies: ['balanced'],
      events,
      resolution,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 20,
    }).actual.metrics;
    return assembleScenario({
      sim,
      preView: pre,
      fork,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      evidence: p.analysis.evidence,
      actualMetrics: actual,
      futureTokens,
    });
  };

  it('finds the codes the pack quotes (and real cases repeat) in its own text', () => {
    expect(packOutcome).toBeDefined();
    expect(packTokens.has('caa82ee7')).toBe(true);
    expect(futureOnlyTokens(events, pre, resolutionText).has('caa82ee7')).toBe(true);
    expect(futureOnlyTokens(events, pre, resolutionText, packTokens).has('caa82ee7')).toBe(false);
  });

  it('no longer rejects a scenario for quoting the pack outcome that carries caa82ee7', () => {
    const futureTokens = futureOnlyTokens(events, pre, resolutionText, packTokens);
    const scenario = scenarioWith(futureTokens, packOutcome?.simulatedResult);
    expect(scenario.steps[0]?.predictedOutcome.simulatedResult).toContain('caa82ee7');
    expect(scenario.status).toBe('completed');
    expect(scenario.boundary.leakCheck.passed).toBe(true);
    // The unfiltered default still reports it, which is the false positive the pipeline now avoids.
    const naive = scenarioWith(
      futureOnlyTokens(events, pre, resolutionText),
      packOutcome?.simulatedResult,
    );
    expect(naive.status).toBe('rejected');
  });

  it('still rejects a real leak: a future-only identifier injected into a step', () => {
    const futureTokens = futureOnlyTokens(events, pre, resolutionText, packTokens);
    const token = [...futureTokens].find((t) => /^10\.20\./.test(t)) ?? [...futureTokens][0] ?? '';
    expect(token).not.toBe('');
    expect(packTokens.has(token)).toBe(false);
    const scenario = scenarioWith(futureTokens, `The resolver ${token} fails`);
    expect(scenario.status).toBe('rejected');
    expect(scenario.boundary.leakCheck.passed).toBe(false);
  });

  it('generates every Case One fork with the pack filter on and no scenario rejected', () => {
    for (const f of p.analysis.forks) {
      const result = generateCounterfactuals({
        analysis: p.analysis,
        fork: f,
        strategies: ['balanced', 'lowest_customer_effort'],
        events,
        resolution,
        pack: p.pack,
        config: CONFIG,
        ctx: p.ctx,
        rolloutCount: 20,
      });
      for (const s of result.scenarios) {
        expect(s.status).toBe('completed');
        expect(s.validity.checks.find((c) => c.id === 'no-future-identifiers')?.passed).toBe(true);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('forward references cannot let a later event change an earlier classification', () => {
  const reviewer = () => {
    const raw = normalized(
      bundleOf([
        customer('e01', '2026-03-09T09:00:00Z', 'Users cannot sign in to Teams.'),
        customer('e02', '2026-03-09T10:00:00Z', 'It fails with ERR_NAME_NOT_RESOLVED every time.'),
        engineer('e03', '2026-03-09T11:00:00Z', 'Compared the DNS resolvers.'),
      ]),
    ).events;
    // Bypasses ingestion on purpose: the engine must cope with data that never went through it.
    return raw.map((e) => (e.id === 'e02' ? { ...e, inResponseTo: 'e03' } : e));
  };
  const categoryOf = (analysis: ReturnType<typeof analyse>) =>
    analysis.evidence.filter((ev) => ev.eventId === 'e02').map((ev) => [ev.signalId, ev.category]);

  it('classifies e02 the same in the full run and in the run as of 10:00', () => {
    const source = reviewer();
    const full = categoryOf(analyse(source));
    const asOf = categoryOf(analyse(source, '2026-03-09T10:00:00Z'));
    expect(full.length).toBeGreaterThan(0);
    expect(full).toEqual(asOf);
    expect(full.every(([, category]) => category === 'customer_reported')).toBe(true);
  });

  it('ignores a forward "repeatOf" and still honours a backward one', () => {
    const raw = normalized(
      bundleOf([
        customer('e01', '2026-03-09T09:00:00Z', 'Users cannot sign in.'),
        engineer('e02', '2026-03-09T10:00:00Z', 'Compared the resolvers.'),
        customer('e03', '2026-03-09T11:00:00Z', 'Still failing.'),
        engineer('e04', '2026-03-09T12:00:00Z', 'Looked at the resolvers once more.'),
      ]),
    ).events;
    const withRefs = raw.map((e) =>
      e.id === 'e02' && e.action
        ? { ...e, action: { ...e.action, repeatOf: 'e04' } }
        : e.id === 'e04' && e.action
          ? { ...e, action: { ...e.action, repeatOf: 'e02' } }
          : e,
    );
    const full = analyse(withRefs);
    const first = full.actions.find((a) => a.eventId === 'e02');
    const second = full.actions.find((a) => a.eventId === 'e04');
    expect(first?.isRepeat).toBe(false);
    expect(first?.repeatOfActionId).toBeNull();
    expect(second?.repeatOfActionId).toBe(first?.id);
    const prefix = analyse(withRefs, '2026-03-09T10:30:00Z');
    expect(prefix.actions.find((a) => a.eventId === 'e02')?.repeatOfActionId).toBeNull();
  });

  it('never follows a forward reply when closing over answers', () => {
    const source = reviewer();
    expect(responderClosure(source, 'e03').map((e) => e.id)).toEqual([]);
    expect(responderClosure(source, 'e01').map((e) => e.id)).toEqual([]);
  });

  describe('ingestion rejects non-causal references', () => {
    const rawBundle = (events: RawEvent[]) => bundleBody(events) as unknown as CaseBundle;
    const forward = [
      customer('e01', '2026-03-09T09:00:00Z', 'Users cannot sign in.'),
      customer('e02', '2026-03-09T10:00:00Z', 'ERR_NAME_NOT_RESOLVED', { inResponseTo: 'e03' }),
      engineer('e03', '2026-03-09T11:00:00Z', 'Compared the resolvers.'),
    ];

    it('normalizeBundle throws a BundleValidationError with schema-style issues', () => {
      const run = () => normalized(rawBundle(forward));
      expect(run).toThrow(BundleValidationError);
      try {
        run();
      } catch (error) {
        expect((error as BundleValidationError).issues).toEqual([
          {
            path: ['events', 1, 'inResponseTo'],
            message:
              'inResponseTo must point at an earlier event, but "e03" is not earlier than "e02"',
          },
        ]);
      }
    });

    it('also rejects self references, forward repeatOf and same-instant forward references', () => {
      const bundles: [string, RawEvent[], (string | number)[]][] = [
        [
          'self',
          [customer('e01', '2026-03-09T09:00:00Z', 'Hi.', { inResponseTo: 'e01' })],
          ['events', 0, 'inResponseTo'],
        ],
        [
          'repeatOf',
          [
            engineer('e01', '2026-03-09T09:00:00Z', 'Check.', {
              action: { label: 'Check', customerEffort: 'low', repeatOf: 'e02' },
            }),
            engineer('e02', '2026-03-09T10:00:00Z', 'Check again.'),
          ],
          ['events', 0, 'action', 'repeatOf'],
        ],
        [
          'same instant',
          [
            customer('e01', '2026-03-09T09:00:00Z', 'Hi.', { inResponseTo: 'e02' }),
            engineer('e02', '2026-03-09T09:00:00.000Z', 'Check.'),
          ],
          ['events', 0, 'inResponseTo'],
        ],
      ];
      for (const [, list, path] of bundles) {
        expect(() => normalized(rawBundle(list))).toThrow(BundleValidationError);
        const parsed = CaseBundleSchema.safeParse(bundleBody(list));
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((i) => i.path)).toContainEqual(path);
      }
    });

    it('accepts a reply to an earlier event at the same instant', () => {
      const ok = [
        engineer('e01', '2026-03-09T09:00:00Z', 'Check.'),
        customer('e02', '2026-03-09T09:00:00Z', 'Done.', { inResponseTo: 'e01' }),
      ];
      expect(CaseBundleSchema.safeParse(bundleBody(ok)).success).toBe(true);
      expect(() => normalized(rawBundle(ok))).not.toThrow();
    });

    it('the bundle schema rejects the reviewer case and accepts every synthetic example', () => {
      expect(CaseBundleSchema.safeParse(bundleBody(forward)).success).toBe(false);
      for (const file of [CASE_ONE, CASE_TWO]) expect(() => loadBundle(file)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('timestamps are compared as instants, not as strings', () => {
  it('canonicalises one instant to one spelling and leaves whole-second stamps alone', () => {
    expect(canonicalTimestamp('2026-03-09T10:00:00.000Z')).toBe('2026-03-09T10:00:00Z');
    expect(canonicalTimestamp('2026-03-09T10:00:00Z')).toBe('2026-03-09T10:00:00Z');
    expect(canonicalTimestamp('2026-03-09T10:00:00.5Z')).toBe('2026-03-09T10:00:00.500Z');
    expect(canonicalTimestamp('2026-03-09T10:00:00.123456Z')).toBe('2026-03-09T10:00:00.123Z');
    expect(canonicalTimestamp('not a time')).toBe('not a time');
    const n = normalized(
      bundleOf([
        customer('e01', '2026-03-09T10:00:00Z', 'First.'),
        customer('e02', '2026-03-09T10:00:00.000Z', 'Second.'),
      ]),
    );
    expect(n.events.map((e) => e.timestamp)).toEqual([
      '2026-03-09T10:00:00Z',
      '2026-03-09T10:00:00Z',
    ]);
    // The existing synthetic cases keep their stored form.
    expect(events.every((e) => e.timestamp === canonicalTimestamp(e.timestamp))).toBe(true);
    expect(events[0]?.timestamp).toBe(loadBundle(CASE_ONE).events[0]?.timestamp);
  });

  it('the decision-moment view and the prefix view agree for equal instants spelled differently', () => {
    const mixed = normalized(
      bundleOf([
        customer('e01', '2026-03-09T10:00:00Z', 'First.'),
        customer('e02', '2026-03-09T10:00:00.000Z', 'Second.'),
      ]),
    ).events.map((e) => (e.id === 'e02' ? { ...e, timestamp: '2026-03-09T10:00:00.000Z' } : e));
    const before = createTemporalViewBeforeEvent(mixed, 'e02');
    const prefix = createTemporalPrefixView(createFullView(mixed, null), 1);
    expect(before.events.map((e) => e.id)).toEqual(['e01']);
    expect(prefix.events.map((e) => e.id)).toEqual(['e01']);
  });

  it('keeps the as-of builders consistent with the temporal view at sub-second precision', () => {
    const e06 = eventBySuffix(p, 'e06');
    const asOf = e06.timestamp;
    const shifted = events.map((e) =>
      e.id === e06.id ? { ...e, timestamp: '2026-03-09T11:41:00.500Z' } : e,
    );
    const view = createTemporalView(shifted, asOf);
    const response = buildTimelineResponse({
      caseRecord: p.normalized.case,
      events: shifted,
      analysis: p.analysis,
      asOf,
    });
    expect(response.total).toBe(view.events.length);
    expect(response.withheldFutureEventCount).toBe(view.withheldFutureEventCount);
    const graph = buildInvestigationGraph({
      caseTitle: p.normalized.case.title,
      caseId: p.ctx.caseId,
      events: shifted,
      analysis: p.analysis,
      asOf,
      now: NOW,
    });
    expect(
      graph.nodes.every((n) => n.timestamp === null || Date.parse(n.timestamp) <= Date.parse(asOf)),
    ).toBe(true);
    const twin = buildDigitalTwin({
      caseRecord: p.normalized.case,
      events: shifted,
      resolution: null,
      analysis: p.analysis,
      pack: p.pack,
      ctx: p.ctx,
      asOf,
    });
    expect(twin.withheldFutureEventCount).toBe(view.withheldFutureEventCount);
    expect(
      twin.fields.every(
        (f) => f.observedAt === null || Date.parse(f.observedAt) <= Date.parse(asOf),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('compiled regexes carry no state between calls', () => {
  const withFlags = (flags: string) => {
    const pack = structuredClone(TEAMS_AUTH_PACK);
    const detector = pack.signals.flatMap((s) => s.detectors).find((d) => d.kind === 'regex');
    if (!detector || detector.kind !== 'regex') throw new Error('expected a regex detector');
    detector.flags = flags;
    return pack;
  };

  it('rejects the g and y flags on detectors', () => {
    expect(() => compileKnowledgePack(withFlags('gi'))).toThrow(/"g" and "y" flags/);
    expect(() => compileKnowledgePack(withFlags('y'))).toThrow(/"g" and "y" flags/);
    expect(() => compileKnowledgePack(withFlags('im'))).not.toThrow();
  });

  it('rejects the g and y flags on claim patterns', () => {
    const pack = structuredClone(TEAMS_AUTH_PACK);
    const claim = pack.claimPatterns[0];
    if (!claim) throw new Error('expected a claim pattern');
    claim.flags = 'gi';
    expect(() => compileKnowledgePack(pack)).toThrow(/claim pattern/);
  });

  it('the built-in pack compiles to stateless expressions (keyword counters aside)', () => {
    const all: RegExp[] = [
      ...[...p.pack.signalDetectors.values()].flat().flatMap((d) => (d.regex ? [d.regex] : [])),
      ...[...p.pack.actionDetectors.values()].flat().flatMap((d) => (d.regex ? [d.regex] : [])),
      ...[...p.pack.requirementDetectors.values()]
        .flat()
        .flatMap((d) => (d.regex ? [d.regex] : [])),
      ...Object.values(p.pack.lexicon).flat(),
      ...p.pack.claimPatterns.map((c) => c.regex),
      ...Object.values(p.pack.lexiconAny).flatMap((re) => (re ? [re] : [])),
    ];
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((re) => re.global || re.sticky)).toEqual([]);
  });

  it('one combined cue expression agrees with testing every lexicon entry', () => {
    const samples = [
      ...events.flatMap((e) => e.body.split(/(?<=[.!?])\s+/)),
      'Probably the proxy.',
      'It is definitely DNS.',
      'Please confirm the steps.',
    ];
    for (const group of ['hedges', 'definitive', 'template'] as const) {
      const combined = p.pack.lexiconAny[group];
      for (const sentence of samples) {
        expect(combined?.test(sentence) ?? false).toBe(
          p.pack.lexicon[group].some((re) => re.test(sentence)),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('ranking shortcuts are exact', () => {
  const state = {
    belief: p.analysis.timeline.steps[8]?.posterior ?? p.analysis.timeline.prior,
    observedSignals: new Set(
      p.analysis.observations.filter((o) => o.eventIndex <= 8).map((o) => o.signalId),
    ),
    satisfied: new Set<string>(['req.affected-scope']),
  };

  it('re-scoring the candidates reproduces a full re-ranking under every perturbed weight set', () => {
    const { candidates } = toBreakdowns(p.pack, CONFIG, state);
    const delta = CONFIG.sensitivityDelta;
    const base = CONFIG.weights;
    const scenarios = [
      { time: 0.25, token: 0.25, customer: 0.25, risk: 0.25 },
      ...(['time', 'token', 'customer', 'risk'] as const).flatMap((key) => [
        { ...base, [key]: base[key] * (1 + delta) },
        { ...base, [key]: base[key] * (1 - delta) },
      ]),
    ];
    expect(candidates.length).toBeGreaterThan(3);
    scenarios.forEach((weights, scenarioIndex) => {
      const ranked = rankActions(p.pack, CONFIG, state, { weights }).candidates;
      ranked.forEach((e, i) => {
        const breakdown = candidates.find((c) => c.actionKey === e.action.id);
        const entry = breakdown?.sensitivity.scenarios[scenarioIndex];
        expect(entry?.rank).toBe(i + 1);
        expect(entry?.score).toBe(Math.round(e.score * 1000) / 1000);
      });
    });
  });

  it('a shared information-gain cache changes nothing', () => {
    const plain = rankActions(p.pack, CONFIG, state);
    const cached = rankActions(p.pack, CONFIG, state, { eigCache: new Map() });
    expect(JSON.stringify(cached)).toBe(JSON.stringify(plain));
  });
});
