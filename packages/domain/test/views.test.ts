import { describe, expect, it } from 'vitest';
import {
  DigitalTwinSchema,
  InvestigationGraphSchema,
  TWIN_SECTIONS,
  TimelineResponseSchema,
} from '@caseguard/schemas';
import {
  GRAPH_NODE_LIMIT,
  buildDigitalTwin,
  buildInvestigationGraph,
  buildTimelineResponse,
  generateCounterfactuals,
} from '../src';
import { CASE_ONE, CONFIG, eventBySuffix, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const events = p.normalized.events;
const resolution = p.normalized.resolution;
const asOf = eventBySuffix(p, 'e09').timestamp;
const futureMarkers = [
  '10.20.1.11',
  'CDN and content delivery',
  'DNS security policy',
  'resolver 10.20',
];

const twinAt = (at: string | null) =>
  buildDigitalTwin({
    caseRecord: p.normalized.case,
    events,
    resolution,
    analysis: p.analysis,
    pack: p.pack,
    ctx: p.ctx,
    asOf: at,
  });

describe('digital twin (FR-TWIN-01, FR-TWIN-02, FR-TL-06)', () => {
  const full = twinAt(null);

  it('covers every section with provenance on every field', () => {
    expect(() => DigitalTwinSchema.parse(full)).not.toThrow();
    for (const section of TWIN_SECTIONS)
      expect(full.sectionCounts[section], section).toBeGreaterThanOrEqual(0);
    for (const section of [
      'problem_statement',
      'customer_impact',
      'environment',
      'scope',
      'participants',
      'observations',
      'actions',
      'decisions',
      'communications',
      'escalations',
      'resolution',
      'validation',
    ] as const) {
      expect(full.sectionCounts[section], section).toBeGreaterThan(0);
    }
    for (const field of full.fields) {
      expect(field.confidence).toBeGreaterThanOrEqual(0);
      expect(field.confidence).toBeLessThanOrEqual(1);
      expect(field.reviewStatus).toBe('pending');
      expect(field.extractedAt).toBe(p.ctx.now);
      expect(['structured', 'rule', 'pattern', 'derived']).toContain(field.method);
      if (field.method !== 'structured') expect(field.observedAt).not.toBeNull();
    }
  });

  it('[FR-TL-06] an as-of twin exposes nothing observed after the boundary', () => {
    const twin = twinAt(asOf);
    expect(twin.asOf).toBe(asOf);
    for (const field of twin.fields) expect((field.observedAt ?? '') <= asOf).toBe(true);
    expect(twin.withheldFutureEventCount).toBe(events.filter((e) => e.timestamp > asOf).length);
    expect(twin.sectionCounts.resolution).toBe(0);
    expect(twin.sectionCounts.validation).toBe(0);
    const text = JSON.stringify(twin);
    for (const marker of futureMarkers) expect(text, marker).not.toContain(marker);
    expect(twin.participants.every((participant) => (participant.firstSeenAt ?? '') <= asOf)).toBe(
      true,
    );
  });

  it('as-of unknowns reflect what was missing then, not what was found later', () => {
    const atEscalation = eventBySuffix(p, 'e19').timestamp;
    const early = twinAt(atEscalation)
      .fields.filter((f) => f.section === 'unknowns')
      .map((f) => f.label);
    const late = full.fields.filter((f) => f.section === 'unknowns').map((f) => f.label);
    expect(early.some((l) => /server-side/i.test(l))).toBe(true);
    expect(late.some((l) => /server-side/i.test(l))).toBe(false);
  });

  it('the full twin records the resolution and validation', () => {
    const text = full.fields
      .filter((f) => f.section === 'resolution')
      .map((f) => f.display)
      .join(' ');
    expect(text).toMatch(/DNS/);
  });
});

describe('timeline view (FR-TL-01..06)', () => {
  const build = (extra: Partial<Parameters<typeof buildTimelineResponse>[0]> = {}) =>
    buildTimelineResponse({
      caseRecord: p.normalized.case,
      events,
      analysis: p.analysis,
      asOf: null,
      ...extra,
    });

  it('serves the whole case with delays, repeats and the hypothesis series', () => {
    const timeline = build();
    expect(() => TimelineResponseSchema.parse(timeline)).not.toThrow();
    expect(timeline.total).toBe(events.length);
    expect(timeline.withheldFutureEventCount).toBe(0);
    expect(timeline.delays.length).toBeGreaterThan(0);
    expect(timeline.delays.some((d) => d.minutes >= 600)).toBe(true);
    expect(timeline.repeats.map((r) => r.eventId)).toContain(eventBySuffix(p, 'e11').id);
    expect(timeline.hypothesisSeries[0]?.key).toBe('hyp.dns-resolution');
    expect(timeline.events.filter((e) => e.forkIds.length > 0)).toHaveLength(
      p.analysis.forks.length,
    );
  });

  it('[FR-TL-06] an as-of timeline never contains later events, counts or series points', () => {
    const timeline = build({ asOf });
    expect(timeline.events.every((e) => e.timestamp <= asOf)).toBe(true);
    expect(timeline.total).toBe(events.filter((e) => e.timestamp <= asOf).length);
    expect(timeline.withheldFutureEventCount).toBe(events.filter((e) => e.timestamp > asOf).length);
    for (const series of timeline.hypothesisSeries)
      expect(series.points.every((point) => point.at <= asOf)).toBe(true);
    expect(timeline.knownAtAsOf.evidenceCount).toBe(
      p.analysis.evidence.filter((e) => e.observedAt <= asOf).length,
    );
    const text = JSON.stringify(timeline);
    for (const marker of futureMarkers) expect(text, marker).not.toContain(marker);
  });

  it('paginates with a stable cursor', () => {
    const first = build({ offset: 0, limit: 10 });
    expect(first.events).toHaveLength(10);
    expect(first.nextCursor).toBe('10');
    const last = build({ offset: 30, limit: 10 });
    expect(last.nextCursor).toBeNull();
    expect(last.events).toHaveLength(events.length - 30);
  });

  it('[FR-TL-03] overlays simulated events, clearly flagged', () => {
    const fork = p.analysis.forks[3];
    if (!fork) throw new Error('expected a fork');
    const { scenarios } = generateCounterfactuals({
      analysis: p.analysis,
      fork,
      strategies: ['balanced'],
      events,
      resolution,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 20,
    });
    const timeline = build({ scenario: scenarios[0] ?? null });
    expect(timeline.simulatedEvents.length).toBeGreaterThan(0);
    expect(timeline.simulatedEvents.every((e) => e.simulated === true)).toBe(true);
    expect(timeline.events.every((e) => e.simulated === false)).toBe(true);
  });
});

describe('investigation graph (FR-GR-01)', () => {
  const baseInput = {
    caseTitle: p.normalized.case.title,
    caseId: p.ctx.caseId,
    events,
    analysis: p.analysis,
    asOf: null,
    now: p.ctx.now,
  };

  it('is a bounded, well-formed graph without simulated nodes unless a scenario is supplied', () => {
    const graph = buildInvestigationGraph(baseInput);
    expect(() => InvestigationGraphSchema.parse(graph)).not.toThrow();
    expect(graph.nodes.length).toBeLessThanOrEqual(GRAPH_NODE_LIMIT);
    expect(graph.nodes.some((n) => n.simulated)).toBe(false);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    for (const lane of graph.lanes) {
      const orders = graph.nodes
        .filter((n) => n.lane === lane.id)
        .map((n) => n.order)
        .sort((a, b) => a - b);
      expect(orders).toEqual(orders.map((_, i) => i));
    }
    expect(graph.nodes.every((n) => n.textAlternative.length > 0)).toBe(true);
  });

  it('adds simulated counterfactual nodes branching from the fork, always flagged', () => {
    const fork = p.analysis.forks[3];
    if (!fork) throw new Error('expected a fork');
    const { scenarios } = generateCounterfactuals({
      analysis: p.analysis,
      fork,
      strategies: ['balanced'],
      events,
      resolution,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
      rolloutCount: 20,
    });
    const graph = buildInvestigationGraph({ ...baseInput, scenario: scenarios[0] ?? null });
    const simulated = graph.nodes.filter(
      (n) => n.lane === 'counterfactual' || n.id.startsWith('outcome:sim'),
    );
    expect(simulated.length).toBeGreaterThan(0);
    expect(simulated.every((n) => n.simulated)).toBe(true);
    expect(graph.edges.some((e) => e.kind === 'branches' && e.simulated)).toBe(true);
    expect(graph.summary).toMatch(/simulated estimates/);
  });

  it('[FR-TL-06] an as-of graph contains no node dated after the boundary', () => {
    const graph = buildInvestigationGraph({ ...baseInput, asOf });
    for (const node of graph.nodes) if (node.timestamp) expect(node.timestamp <= asOf).toBe(true);
    const text = JSON.stringify(graph);
    for (const marker of futureMarkers) expect(text, marker).not.toContain(marker);
  });
});
