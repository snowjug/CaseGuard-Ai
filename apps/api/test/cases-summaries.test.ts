import { describe, expect, it, vi } from 'vitest';
import type { CaseAnalysisSummary, CaseListItem } from '../src/db';
import type { RequestContext } from '../src/http/request-context';
import { summarizeCases } from '../src/services/cases';

const item = (id: string): CaseListItem => ({
  id,
  reference: `CG-${id}`,
  title: 'Teams sign-in fails',
  product: 'Microsoft Teams',
  workload: 'teams-authentication',
  severity: 'A',
  status: 'open',
  customerAlias: 'Customer',
  openedAt: '2026-01-05T09:00:00.000Z',
  closedAt: null,
  synthetic: true,
  eventCount: 3,
  analysisState: 'not_analyzed',
  analyzedAt: null,
  hasResolution: false,
  injectionDetected: false,
});

const figures = (caseId: string): CaseAnalysisSummary => ({
  caseId,
  qualityIndex: 72,
  avoidableEffortPct: 31,
  leadingHypothesis: { name: 'DNS misconfiguration', confidence: 0.6 },
  openWarningCount: 2,
});

/** A request context whose analysis repository is a spy: only `summarize` exists, so any other read fails. */
function contextWith(summarize: (ids: readonly string[]) => Promise<CaseAnalysisSummary[]>) {
  const spy = vi.fn(summarize);
  const ctx = { repos: { analysis: { summarize: spy } } } as unknown as RequestContext;
  return { ctx, spy };
}

describe('summarizeCases (list page figures)', () => {
  it('reads the figures of the whole page with one call and keeps the page order', async () => {
    const { ctx, spy } = contextWith((ids) => Promise.resolve([...ids].reverse().map(figures)));
    const page = await summarizeCases(ctx, [item('a'), item('b'), item('c')]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(page.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    for (const entry of page) {
      expect(entry).toMatchObject({
        qualityIndex: 72,
        avoidableEffortPct: 31,
        leadingHypothesis: { name: 'DNS misconfiguration', confidence: 0.6 },
        openWarningCount: 2,
      });
    }
  });

  it('shows no figures for a case the read model omitted (erased or not analysed)', async () => {
    const { ctx } = contextWith(() => Promise.resolve([figures('a'), figures('c')]));
    const page = await summarizeCases(ctx, [item('a'), item('b'), item('c')]);
    expect(page.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(page[1]).toMatchObject({
      id: 'b',
      qualityIndex: null,
      avoidableEffortPct: null,
      leadingHypothesis: null,
      openWarningCount: 0,
    });
    expect(page[0]?.qualityIndex).toBe(72);
    expect(page[2]?.openWarningCount).toBe(2);
  });

  it('does not touch the repository for an empty page', async () => {
    const { ctx, spy } = contextWith(() => Promise.reject(new Error('must not be called')));
    expect(await summarizeCases(ctx, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never adds fields of its own: the result is the list item plus the four figures', async () => {
    const { ctx } = contextWith(() => Promise.resolve([]));
    const [only] = await summarizeCases(ctx, [item('a')]);
    expect(Object.keys(only ?? {}).sort()).toEqual(
      [
        ...Object.keys(item('a')),
        'qualityIndex',
        'avoidableEffortPct',
        'leadingHypothesis',
        'openWarningCount',
      ].sort(),
    );
  });
});
