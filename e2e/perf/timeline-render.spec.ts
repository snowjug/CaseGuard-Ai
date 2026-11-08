import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '../support/fixtures';
import { openPage } from '../support/ui';

/**
 * @perf: how long the Timeline page takes to show its first timeline row in a real browser, for Case One (31
 * events), from the start of the navigation. It also records the largest contentful paint when the browser reports one.
 * It measures; it asserts nothing about speed (no SLO is claimed). Run it on demand:
 *
 *   $env:PW_PERF = '1'; pnpm.cmd exec playwright test --project=perf        (PW_PERF_ITERATIONS=10 by default)
 *
 * The numbers belong to the machine and the build that produced them; the file it writes says which.
 */
const ITERATIONS = Math.max(1, Number.parseInt(process.env.PW_PERF_ITERATIONS ?? '10', 10) || 10);
const WARMUP = 2;

const percentile = (sorted: number[], percent: number): number =>
  sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? Number.NaN;

test.describe('@perf Timeline render', () => {
  test.setTimeout(900_000);

  test('time from navigation start to the first timeline row, and the largest contentful paint', async ({
    page,
    demo,
  }, testInfo) => {
    await page.addInitScript(() => {
      const state = { firstRowMs: null as number | null, lcpMs: null as number | null };
      (window as unknown as { __perf: typeof state }).__perf = state;
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) state.lcpMs = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      const watcher = new MutationObserver(() => {
        if (state.firstRowMs === null && document.querySelector('[aria-label^="Events, "] > li')) {
          state.firstRowMs = performance.now();
          watcher.disconnect();
        }
      });
      watcher.observe(document, { childList: true, subtree: true });
    });

    const firstRow: number[] = [];
    const lcp: number[] = [];
    for (let run = 0; run < WARMUP + ITERATIONS; run += 1) {
      await page.goto('about:blank');
      await openPage(page, `/cases/${demo.caseOneId}/timeline`);
      await expect(page.getByRole('list', { name: /^Events, 31 shown/ })).toBeVisible();
      const measured = await page.evaluate(
        () =>
          (window as unknown as { __perf: { firstRowMs: number | null; lcpMs: number | null } })
            .__perf,
      );
      expect(measured.firstRowMs, 'the first timeline row appeared').not.toBeNull();
      if (run >= WARMUP) {
        firstRow.push(measured.firstRowMs!);
        if (measured.lcpMs !== null) lcp.push(measured.lcpMs);
      }
    }

    const summarize = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        n: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? Number.NaN,
      };
    };
    const report = {
      page: 'Timeline, Case One (31 events)',
      mode: 'production build, standalone server, local API, deterministic AI provider',
      browser: testInfo.project.use.channel ?? 'bundled chromium',
      iterations: ITERATIONS,
      warmup: WARMUP,
      date: new Date().toISOString(),
      note: 'Milliseconds from the start of the navigation (performance.now() of the document). Other processes may have been running: numbers are noisy.',
      firstTimelineRow: summarize(firstRow),
      largestContentfulPaint: lcp.length > 0 ? summarize(lcp) : null,
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/perf-timeline-render.json', JSON.stringify(report, null, 2));
    await testInfo.attach('perf-timeline-render.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    console.log(`[perf] ${JSON.stringify(report)}`);
  });
});
