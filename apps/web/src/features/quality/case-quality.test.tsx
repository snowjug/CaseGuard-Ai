import { QUALITY_DIMENSIONS, type RouteId } from '@caseguard/schemas';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { caseDetail, timelineEvent, timelineResponse } from '../../../test/case-fixtures';
import { caseSummary, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeApi,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import {
  caseComparison,
  coachingReport,
  dimension,
  metricEstimates,
  metricEstimatesAsOf,
  qualityAsOf,
  qualityAssessment,
  skillMatch,
  warning,
  warningList,
} from '../../../test/u3-fixtures';
import { AS_OF_STALE_MS } from '../../components/case/as-of';
import { createApiClient, type ApiClient } from '../../lib/api/client';
import { ApiError } from '../../lib/api/errors';
import { CaseQualityPage } from './CaseQualityPage';
import { isPlaceholderScore, weightText } from './quality-model';

const AS_OF = '2026-03-09T12:30:00Z';
// The moments the case's events were recorded at: the time cursor lands on one of them.
const FIRST_EVENT = '2026-03-09T09:12:00Z';
const WITH_SECONDS = '2026-03-09T12:30:45Z';
const LAST_EVENT = '2026-03-10T08:55:00Z';
const EVENT_INSTANTS = [FIRST_EVENT, AS_OF, WITH_SECONDS, LAST_EVENT];

const eventsAt = (instants: readonly string[]) =>
  instants.map((timestamp, index) =>
    timelineEvent({ id: `e${index + 1}`, sequence: index, timestamp }),
  );

// A busy machine can take several seconds to settle a chain of requests; assertions stay exact, only the wait is longer.
configure({ asyncUtilTimeout: 5000 });
const AXE_TIMEOUT = 120_000;

const ENGINEER = [
  'case:read',
  'quality:read',
  'warning:dismiss',
  'skill:read',
  'skill:apply',
] as const;
const MANAGER = ['case:read', 'quality:read', 'analytics:read', 'skill:read'] as const;

type Input = {
  query: { asOf?: string; state?: string; caseIds?: string; limit?: number };
  params: Record<string, string>;
  maxRetries?: number;
};

function api(overrides: FakeHandlers = {}, permissions: readonly string[] = ENGINEER) {
  return fakeApi({
    'session.me': () => session('engineer', permissions as Parameters<typeof session>[1]),
    'cases.get': () => caseDetail(),
    'cases.list': () => ({
      items: [
        caseSummary({ id: 'case_1', reference: 'CG-SYN-1001' }),
        caseSummary({ id: 'case_2', reference: 'CG-SYN-1002', title: 'Rotterdam site' }),
      ],
      nextCursor: null,
    }),
    // The whole-record read gives the cursor its event instants (nothing else is used from it); a one-row read at the
    // boundary gives the counts of what was known then.
    'timeline.get': (input) => {
      const asOf = (input as Input).query.asOf ?? null;
      return asOf
        ? timelineResponse({ asOf, withheldFutureEventCount: 12 })
        : timelineResponse({ events: eventsAt(EVENT_INSTANTS), total: EVENT_INSTANTS.length });
    },
    'quality.get': (input) => {
      const asOf = (input as Input).query.asOf;
      return asOf ? qualityAsOf(asOf) : qualityAssessment();
    },
    'metrics.get': (input) => ({
      items: (input as Input).query.asOf ? metricEstimatesAsOf() : metricEstimates(),
    }),
    'warnings.list': () => ({ items: warningList() }),
    'skillMatches.list': () => ({ items: [skillMatch()] }),
    'coaching.get': () => coachingReport(),
    'compare.cases': () => caseComparison(),
    ...overrides,
  });
}

const inputsOf = (fake: FakeApi, routeId: RouteId): Input[] =>
  fake.call.mock.calls.filter(([id]) => id === routeId).map(([, input]) => input as Input);

async function openTab(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole('tab', { name }));
}

describe('[FR-QR-01] Quality review model helpers', () => {
  it('recognises the neutral placeholder the API sends when nothing can be assessed', () => {
    const placeholder = qualityAssessment({
      dimensions: QUALITY_DIMENSIONS.map((key) => dimension(key, { weight: 0 })),
    });
    expect(isPlaceholderScore(placeholder)).toBe(true);
    expect(isPlaceholderScore(qualityAssessment())).toBe(false);
  });

  it('shows weights as percentages', () => {
    expect(weightText(0.25)).toBe('25%');
    expect(weightText(0.2941)).toBe('29.4%');
  });
});

describe('[FR-QR-02] Case Quality Review: quality index', () => {
  it('shows a skeleton, then the index with its range, dimensions, penalties and improvements', async () => {
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Case Quality Review' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    const hero = await screen.findByRole('group', { name: 'Case Quality Index' });
    expect(
      within(hero).getByRole('img', { name: /Case Quality Index: 36 out of 100/ }),
    ).toBeInTheDocument();
    expect(within(hero).getAllByText('Estimated').length).toBeGreaterThan(0);
    expect(within(hero).getByText(/plausible range of 32 to 39/)).toBeInTheDocument();
    expect(within(hero).getByText(/never a verdict about a person/)).toBeInTheDocument();

    const dimensions = screen.getByRole('group', { name: 'Dimensions' });
    expect(within(dimensions).getAllByRole('heading', { level: 3 })).toHaveLength(6);

    const penalties = screen.getByRole('group', { name: 'Applied penalties' });
    expect(
      within(penalties).getByRole('heading', { name: 'Unsupported root-cause claim' }),
    ).toBeInTheDocument();
    expect(
      within(penalties).getByRole('link', { name: 'Resolver change was the cause' }),
    ).toHaveAttribute('href', '/cases/case_1/evidence?sel=clm_1');

    const improvements = screen.getByRole('group', { name: 'Recommended improvements' });
    expect(
      within(improvements).getByRole('heading', {
        name: 'Write causes as hypotheses until evidence supports them',
      }),
    ).toBeInTheDocument();
    expect(within(improvements).getByText('Critical')).toBeInTheDocument();
    expect(
      within(improvements).getByRole('link', { name: 'Open the decision fork behind this' }),
    ).toHaveAttribute('href', '/cases/case_1/counterfactual?sel=fork_1');

    const after = screen.getByRole('group', { name: 'If every improvement were applied' });
    expect(after).toHaveTextContent(/68 out of 100 \(estimated\)/);
    // The panel's own description and the method the API sends both say it.
    expect(
      within(after).getAllByText(/An estimate for planning, not a prediction/).length,
    ).toBeGreaterThan(0);
  });

  it('opens the checks behind a dimension, marking checks that could not be decided', async () => {
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const dimensions = await screen.findByRole('group', { name: 'Dimensions' });
    const first = within(dimensions).getAllByText(/2 checks behind this score/)[0];
    expect(first).toBeDefined();
    expect(within(dimensions).getAllByText('Could not be decided').length).toBeGreaterThan(0);
  });

  it('never shows the neutral placeholder as a score', async () => {
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'quality.get': () =>
          qualityAssessment({
            compositeScore: 50,
            compositeLow: 0,
            compositeHigh: 100,
            dimensions: QUALITY_DIMENSIONS.map((key) => dimension(key, { weight: 0 })),
          }),
      }),
    });
    expect(await screen.findByText('Nothing can be assessed yet')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Case Quality Index:/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'If every improvement were applied' })).toBeNull();
  });

  it('shows an error with Retry when the index cannot be loaded', async () => {
    let attempts = 0;
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'quality.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal error',
              message: 'Boom',
            });
          return qualityAssessment();
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The quality index could not be loaded',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'Case Quality Index' })).toBeInTheDocument();
  });

  it('says so when the case has not been analysed, and asks for nothing', async () => {
    const fake = api({ 'cases.get': () => caseDetail({ analysisState: 'not_analyzed' }) });
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    expect(await screen.findByText('This case has not been analysed yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the case' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    expect(inputsOf(fake, 'quality.get')).toHaveLength(0);
  });

  it('says so when the case does not exist', async () => {
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'cases.get': () => {
          throw new ApiError({
            status: 404,
            code: 'not_found',
            title: 'Not found',
            message: 'Case not found',
          });
        },
      }),
    });
    expect(await screen.findByText('We could not find that case')).toBeInTheDocument();
  });

  it('explains a role without quality access and asks for nothing', async () => {
    const fake = api({}, ['case:read', 'skill:read']);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    expect(
      await screen.findByText('You do not have access to the case quality review'),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not include the "quality:read" permission/)).toBeInTheDocument();
    expect(inputsOf(fake, 'quality.get')).toHaveLength(0);
  });
});

describe('[FR-QR-03] Case Quality Review: the time cursor (decision-time view)', () => {
  it('asks for nothing later than the cursor and says how many later events are withheld', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const hero = await screen.findByRole('group', { name: 'Case Quality Index' });
    expect(within(hero).getByText(/Scored as of 9 Mar 2026, 12:30 UTC/)).toBeInTheDocument();

    const qualityReads = inputsOf(fake, 'quality.get');
    expect(qualityReads.length).toBeGreaterThan(0);
    for (const input of qualityReads) expect(input.query.asOf).toBe(AS_OF);
    // The counts are read at the boundary, one row only; the whole-record read supplies the cursor's event instants and
    // nothing else of the case.
    const timelineReads = inputsOf(fake, 'timeline.get');
    expect(
      timelineReads.some((input) => input.query.asOf === AS_OF && input.query.limit === 1),
    ).toBe(true);
    for (const input of timelineReads) {
      if (input.query.asOf === undefined) expect(input.query.limit).toBe(200);
      else expect(input.query).toMatchObject({ asOf: AS_OF, limit: 1 });
    }
    expect(screen.getAllByText(/Known as of 9 Mar 2026, 12:30 UTC/).length).toBeGreaterThan(0);
    expect(await screen.findByText(/12 later events are withheld/)).toBeInTheDocument();
    expect(screen.getByText(/later events are counted, never shown/)).toBeInTheDocument();
    expect(screen.getByText('Evidence items')).toBeInTheDocument();
  });

  it('states the instant the API cut the evidence at, and says so when no event had been recorded yet', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    const { unmount } = renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    expect(
      await screen.findByText(
        'The case as it stood on 9 Mar 2026, 12:30 UTC, the last event recorded by the moment you chose.',
      ),
    ).toBeInTheDocument();
    unmount();

    // Before the first event there is nothing to land on: the API says nothing had been recorded.
    navigateTo('/cases/case_1/quality?asOf=2026-03-09T08:00:00Z');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'timeline.get': (input) =>
          (input as Input).query.asOf
            ? timelineResponse({ asOf: null, events: [], total: 0, withheldFutureEventCount: 4 })
            : timelineResponse({ events: eventsAt(EVENT_INSTANTS), total: EVENT_INSTANTS.length }),
      }),
    });
    expect(
      await screen.findByText('No event had been recorded by the moment you chose.'),
    ).toBeInTheDocument();
  });

  it('leaves out a dimension that cannot be assessed yet instead of scoring it', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const dimensions = await screen.findByRole('group', { name: 'Dimensions' });
    expect(within(dimensions).getByText('Not yet assessable')).toBeInTheDocument();
    expect(within(dimensions).getByText(/Left out of the composite/)).toBeInTheDocument();
  });

  it('shows the boundary exactly: seconds are kept when the instant has some', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${WITH_SECONDS}`);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const hero = await screen.findByRole('group', { name: 'Case Quality Index' });
    expect(within(hero).getByText(/Scored as of 9 Mar 2026, 12:30:45 UTC/)).toBeInTheDocument();
    expect(screen.getAllByText(/Known as of 9 Mar 2026, 12:30:45 UTC/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Known as of 9 Mar 2026, 12:30 UTC/)).toBeNull();
  });

  it('returns to the whole record when the cursor is cleared', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });
    await userEvent.click(screen.getByRole('button', { name: 'Latest' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(inputsOf(fake, 'quality.get').at(-1)?.query.asOf).toBeUndefined());
    expect(await screen.findByText(/Showing the whole record/)).toBeInTheDocument();
  });

  it('keeps hindsight apart: coaching ignores the cursor and says so', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });
    await openTab('Coaching');
    const frame = await screen.findByRole('group', { name: 'Retrospective review' });
    expect(
      within(frame).getByText(/uses the whole record, including the outcome/),
    ).toBeInTheDocument();
    expect(within(frame).getByText(/does not follow the time cursor/)).toBeInTheDocument();
    expect(inputsOf(fake, 'coaching.get')[0]?.query).toBeUndefined();
  });
});

describe('[FR-QR-10] Case Quality Review: the shared protocol of the case pages for earlier views', () => {
  it('lands the cursor on an event, and asks for the earlier view only once the instants are known', async () => {
    // An arbitrary minute between two events, as a shared address may carry.
    navigateTo('/cases/case_1/quality?asOf=2026-03-09T11:00:00Z');
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });

    const reads = inputsOf(fake, 'quality.get');
    expect(reads.length).toBeGreaterThan(0);
    // Every request names the last event at or before that minute, never the minute itself.
    for (const input of reads) expect(input.query.asOf).toBe(FIRST_EVENT);
    for (const input of inputsOf(fake, 'timeline.get')) {
      expect(input.query.asOf === undefined || input.query.asOf === FIRST_EVENT).toBe(true);
    }
    // Held back until the whole-record read of the event instants had answered.
    const order = fake.call.mock.calls.map(
      ([id, input]) => `${id}:${(input as Input | undefined)?.query?.asOf ?? ''}`,
    );
    expect(order.indexOf(`quality.get:${FIRST_EVENT}`)).toBeGreaterThan(
      order.indexOf('timeline.get:'),
    );
    expect(order).not.toContain('quality.get:2026-03-09T11:00:00Z');
  });

  it('moves the cursor from event to event, and writes the event instant to the address', async () => {
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });
    await userEvent.click(await screen.findByRole('button', { name: 'Previous event' }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('asOf')).toBe(LAST_EVENT),
    );
    await waitFor(() => expect(inputsOf(fake, 'quality.get').at(-1)?.query.asOf).toBe(LAST_EVENT));
  });

  it('asks for an earlier view without hidden retries, and keeps its window fresh', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    const fake = api();
    const { queryClient } = renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });

    const earlier = inputsOf(fake, 'quality.get').find((input) => input.query.asOf === AS_OF);
    expect(earlier?.maxRetries).toBe(0);
    const windowQuery = queryClient
      .getQueryCache()
      .getAll()
      .find(
        (query) =>
          query.queryKey[2] === 'quality.get' &&
          (query.queryKey[4] as { asOf?: string } | null)?.asOf === AS_OF,
      );
    expect(windowQuery?.observers[0]?.options.staleTime).toBe(AS_OF_STALE_MS);
  });

  it('keeps the whole record on the usual terms: retried like any read, fresh for the usual time', async () => {
    const fake = api();
    const { queryClient } = renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Case Quality Index' });
    expect(inputsOf(fake, 'quality.get')[0]?.maxRetries).toBeUndefined();
    const whole = queryClient
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[2] === 'quality.get');
    expect(whole?.observers[0]?.options.staleTime).not.toBe(AS_OF_STALE_MS);
  });

  it('shows a refused earlier view calmly: why, the wait counted down, a Retry and the whole record', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    let attempts = 0;
    const fake = api({
      'quality.get': (input) => {
        if ((input as Input).query.asOf !== undefined) {
          attempts += 1;
          if (attempts === 1) {
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              message:
                'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
              retryAfterMs: 1000,
            });
          }
          return qualityAsOf(AS_OF);
        }
        return qualityAssessment();
      },
    });
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });

    // The shared notice of the case pages, not a failure: nothing here is an alert, and nothing is hidden-retried.
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Computing earlier views is limited to keep the service responsive, so the quality index could not be computed for this moment just now\. Views you already opened stay available\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Too many requests right now')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the whole record' })).toBeInTheDocument();
    expect(attempts).toBe(1);
    expect(inputsOf(fake, 'quality.get').filter((input) => input.query.asOf)[0]?.maxRetries).toBe(
      0,
    );

    // The countdown ends, and a Retry asks again, once.
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 });
    await waitFor(() => expect(retry).toBeEnabled());
    await userEvent.click(retry);
    expect(await screen.findByRole('group', { name: 'Case Quality Index' })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('leaves the refused earlier view for the whole record, which is never limited', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'quality.get': (input) => {
          if ((input as Input).query.asOf !== undefined) {
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              retryAfterMs: 30_000,
            });
          }
          return qualityAssessment();
        },
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(await screen.findByRole('group', { name: 'Case Quality Index' })).toBeInTheDocument();
  });

  // A Retry-After the client would sleep through is the case that matters: without the page's `maxRetries: 0` it would
  // retry (twice, sleeping each time). A longer one the client itself refuses to wait for, and throws at once.
  it.each([
    { retryAfter: 3, countdown: /Retry in [1-3] s/ },
    { retryAfter: 7, countdown: /Retry in [4-7] s/ },
  ])(
    'goes through the real client: one request for the refused window, no hidden retry, a countdown (Retry-After $retryAfter)',
    async ({ retryAfter, countdown }) => {
      navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
      const refusal = (): Response =>
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Too Many Requests',
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            detail:
              'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/problem+json',
              'retry-after': String(retryAfter),
            },
          },
        );
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => refusal());
      const sleep = vi.fn(async () => undefined);
      const real = createApiClient({ fetch: fetchMock as unknown as typeof fetch, sleep });
      const fake = api();
      // The metered window goes through the real client (its retry policy, its Retry-After, its Problem Details);
      // everything else is answered by the fake API.
      type Call = (routeId: RouteId, ...args: unknown[]) => Promise<unknown>;
      const client = {
        call: ((routeId: RouteId, ...args: unknown[]) =>
          routeId === 'quality.get' && (args[0] as Input | undefined)?.query?.asOf
            ? (real.call as unknown as Call)(routeId, ...args)
            : (fake.call as unknown as Call)(routeId, ...args)) as unknown as ApiClient['call'],
      } satisfies ApiClient;
      renderApp(<CaseQualityPage caseId="case_1" />, { api: client });

      expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
      // A GET is retried twice by default, sleeping for the Retry-After each time: the page asks for none of that.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      const retry = screen.getByRole('button', { name: countdown });
      expect(retry).toBeDisabled();
      expect(fetchMock.mock.calls[0]?.[0]).toContain('asOf=');
      // Nothing of the whole record is on screen while the window is refused.
      expect(screen.queryByRole('group', { name: 'Case Quality Index' })).toBeNull();
    },
  );

  it('says that the counts for a refused moment are not available, while the rest of the page answers', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'timeline.get': (input) => {
          if ((input as Input).query.asOf !== undefined) {
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              retryAfterMs: 5000,
            });
          }
          return timelineResponse({
            events: eventsAt(EVENT_INSTANTS),
            total: EVENT_INSTANTS.length,
          });
        },
      }),
    });
    expect(
      await screen.findByText(
        'Counts for this moment are not available right now: earlier views are limited.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('What was known at the moment you chose could not be worked out just now.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Case Quality Index' })).toBeInTheDocument();
  });

  it('still explains a throttled read of the whole record in the plain way, with the wait', async () => {
    navigateTo('/cases/case_1/quality?tab=coaching');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'coaching.get': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            title: 'Too many requests',
            message: 'Too many requests; slow down and retry',
            retryAfterMs: 7000,
          });
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests right now');
    expect(alert).toHaveTextContent('Try again in 7 seconds');
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });
});

describe('[FR-QR-11] Case Quality Review: nothing of another moment while the chosen one loads', () => {
  const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

  // Each tab, the read behind it, what it shows for the whole record, and the skeleton that replaces it.
  const TABS_UNDER_TEST = [
    {
      tab: 'index',
      route: 'quality.get',
      loading: 'Loading the quality index…',
      answer: () => qualityAssessment(),
      content: () => screen.queryByRole('group', { name: 'Case Quality Index' }),
    },
    {
      tab: 'effort',
      route: 'metrics.get',
      loading: 'Loading the metrics…',
      answer: () => ({ items: metricEstimates() }),
      content: () => screen.queryByRole('group', { name: 'Avoidable Support Effort' }),
    },
    {
      tab: 'warnings',
      route: 'warnings.list',
      loading: 'Loading the warnings…',
      answer: () => ({ items: warningList() }),
      content: () => screen.queryByText('Disruptive change made before the cause was established'),
    },
    {
      tab: 'skills',
      route: 'skillMatches.list',
      loading: 'Loading SkillDNA matches…',
      answer: () => ({ items: [skillMatch()] }),
      content: () =>
        screen.queryByRole('heading', {
          name: 'Isolate a pre-authentication failure before pursuing identity policy',
        }),
    },
  ] as const;

  it.each(TABS_UNDER_TEST)(
    'shows the loading state, and none of the whole record, while an earlier moment loads: $tab',
    async ({ tab, route, loading, answer, content }) => {
      navigateTo(`/cases/case_1/quality?tab=${tab}`);
      const handlers: FakeHandlers = {};
      handlers[route] = (input) => ((input as Input).query.asOf ? NEVER() : answer());
      renderApp(<CaseQualityPage caseId="case_1" />, { api: api(handlers) });
      await waitFor(() => expect(content()).not.toBeNull());

      await userEvent.click(await screen.findByRole('button', { name: 'Previous event' }));
      await waitFor(() =>
        expect(new URLSearchParams(window.location.search).get('asOf')).toBe(LAST_EVENT),
      );

      // The answer of the whole record is gone at once, and the panel says it is loading (a busy status).
      await waitFor(() => expect(content()).toBeNull());
      const skeleton = await screen.findByText(loading);
      expect(skeleton.closest('[aria-busy="true"]')).not.toBeNull();
      expect(screen.queryByText(/Showing the whole record/)).toBeNull();
    },
  );

  it('shows nothing of a later moment either, when the cursor steps back', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${WITH_SECONDS}`);
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'quality.get': (input) =>
          (input as Input).query.asOf === AS_OF
            ? NEVER()
            : qualityAsOf((input as Input).query.asOf ?? WITH_SECONDS),
      }),
    });
    expect(await screen.findByText(/Scored as of 9 Mar 2026, 12:30:45 UTC/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Previous event' }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('asOf')).toBe(AS_OF),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Scored as of 9 Mar 2026, 12:30:45 UTC/)).toBeNull(),
    );
    expect(screen.queryByRole('group', { name: 'Case Quality Index' })).toBeNull();
    expect(await screen.findByText('Loading the quality index…')).toBeInTheDocument();
  });

  it('shows no counts of another moment in the cursor panel either', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${WITH_SECONDS}`);
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'timeline.get': (input) => {
          const asOf = (input as Input).query.asOf;
          if (asOf === AS_OF) return NEVER();
          return asOf
            ? timelineResponse({ asOf, withheldFutureEventCount: 12 })
            : timelineResponse({ events: eventsAt(EVENT_INSTANTS), total: EVENT_INSTANTS.length });
        },
      }),
    });
    expect(await screen.findByText(/12 later events are withheld/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Previous event' }));
    await waitFor(() => expect(screen.queryByText(/12 later events are withheld/)).toBeNull());
    expect(await screen.findByText('Counting what was known…')).toBeInTheDocument();
    expect(screen.queryByText('Evidence items')).toBeNull();
  });

  it('keeps the answer of the same moment on screen while it is refreshed, and says it is busy', async () => {
    navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
    let reads = 0;
    const { queryClient, container } = renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'quality.get': (input) => {
          reads += 1;
          return reads === 1 ? qualityAsOf((input as Input).query.asOf ?? AS_OF) : NEVER();
        },
      }),
    });
    await screen.findByRole('group', { name: 'Case Quality Index' });
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[2] === 'quality.get',
    });
    await waitFor(() => expect(reads).toBe(2));
    // Same moment: the figures stay, dimmed and marked busy, instead of flashing away.
    expect(screen.getByRole('group', { name: 'Case Quality Index' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe('[FR-QR-04] Case Quality Review: tabs in the URL', () => {
  it('opens the tab named in the address and writes the tab back when it changes', async () => {
    navigateTo('/cases/case_1/quality?tab=effort');
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    expect(
      await screen.findByRole('group', { name: 'Avoidable Support Effort' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Effort and metrics' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Only what is visible is requested.
    expect(inputsOf(fake, 'quality.get')).toHaveLength(0);
    expect(inputsOf(fake, 'coaching.get')).toHaveLength(0);

    await openTab('Live warnings');
    await waitFor(() => expect(window.location.search).toContain('tab=warnings'));
    expect(await screen.findByRole('group', { name: 'Warnings' })).toBeInTheDocument();
  });
});

describe('[FR-QR-05] Case Quality Review: Avoidable Support Effort', () => {
  it('shows the estimate with its range, contributors, assumptions and method, labelled', async () => {
    navigateTo('/cases/case_1/quality?tab=effort');
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const ase = await screen.findByRole('group', { name: 'Avoidable Support Effort' });
    expect(within(ase).getByText('Estimated')).toBeInTheDocument();
    expect(within(ase).getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(within(ase).getByText('Synthetic')).toBeInTheDocument();
    expect(
      within(ase).getByText(/About 55% of the effort could plausibly have been avoided/),
    ).toBeInTheDocument();
    expect(within(ase).getByText(/range of 44% to 83%/)).toBeInTheDocument();

    const method = screen.getByRole('group', { name: 'How the estimate was calculated' });
    expect(within(method).getByText(/ASE = sum\(weight x avoidable share\)/)).toBeInTheDocument();
    expect(
      within(method).getByText(/Outcome probabilities come from knowledge-pack likelihoods/),
    ).toBeInTheDocument();

    const breakdown = screen.getByRole('group', { name: 'Contributors and components' });
    const contributors = within(breakdown).getByRole('list', { name: 'Main contributors' });
    expect(within(contributors).getByText('Waiting time to diagnosis')).toBeInTheDocument();
    expect(within(breakdown).getByRole('table', { name: 'Effort components' })).toBeInTheDocument();
  });

  it('shows the other estimates as cards with how each was calculated', async () => {
    navigateTo('/cases/case_1/quality?tab=effort');
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const card = await screen.findByRole('group', { name: 'Evidence Integrity' });
    expect(within(card).getByText('23 / 100')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Token Efficiency' })).toBeInTheDocument();
    expect(screen.getAllByText('How this is calculated').length).toBeGreaterThan(0);
  });

  it('says Avoidable Support Effort cannot be estimated inside a time window', async () => {
    navigateTo(`/cases/case_1/quality?tab=effort&asOf=${AS_OF}`);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const ase = await screen.findByRole('group', { name: 'Avoidable Support Effort' });
    expect(within(ase).getByText('Not estimated here')).toBeInTheDocument();
    expect(within(ase).getByText(/not estimated inside a time window/)).toBeInTheDocument();
    expect(within(ase).queryByText(/About .*% of the effort/)).toBeNull();
  });
});

describe('[FR-QR-06] Case Quality Review: live warnings and dismissal', () => {
  it('lists open warnings first, with counts, evidence and the next step', async () => {
    navigateTo('/cases/case_1/quality?tab=warnings');
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const panel = await screen.findByRole('group', { name: 'Warnings' });
    expect(within(panel).getByRole('button', { name: 'Open (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(panel).getByRole('button', { name: 'Resolved (1)' })).toBeInTheDocument();
    expect(
      within(panel).getByText('Disruptive change made before the cause was established'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText('The customer is waiting for a reply')).toBeNull();
    expect(within(panel).getAllByText(/Next step:/).length).toBe(2);
    expect(within(panel).getByRole('link', { name: 'Revoke sign-in sessions' })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline?sel=e09',
    );

    await userEvent.click(within(panel).getByRole('button', { name: 'Resolved (1)' }));
    await waitFor(() => expect(window.location.search).toContain('wstate=resolved'));
    expect(
      await within(panel).findByText('The customer is waiting for a reply'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Resolved 10 Mar 2026, 17:45 UTC/)).toBeInTheDocument();
  });

  it('offers the way forward when nothing is open', async () => {
    navigateTo('/cases/case_1/quality?tab=warnings');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'warnings.list': () => ({
          items: [warning({ state: 'resolved', resolvedAt: AS_OF, resolvedReason: 'Done' })],
        }),
      }),
    });
    expect(await screen.findByText('No open warning')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all 1' }));
    expect(
      await screen.findByText('Disruptive change made before the cause was established'),
    ).toBeInTheDocument();
  });

  it('dismisses a warning only with a reason, and records it with the version the person saw', async () => {
    navigateTo('/cases/case_1/quality?tab=warnings');
    const fake = api({ 'warnings.dismiss': () => warning({ state: 'dismissed' }) });
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const open = await screen.findByRole('button', {
      name: 'Dismiss warning: Disruptive change made before the cause was established',
    });
    await userEvent.click(open);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/cannot be undone from here/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss warning' }));
    expect(within(dialog).getByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(fake.call.mock.calls.some(([id]) => id === 'warnings.dismiss')).toBe(false);

    await userEvent.type(
      within(dialog).getByRole('textbox'),
      'Confirmed with the customer by phone',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss warning' }));
    await waitFor(() =>
      expect(fake.call).toHaveBeenCalledWith(
        'warnings.dismiss',
        expect.objectContaining({
          params: { caseId: 'case_1', warningId: 'wrn_1' },
          body: { reason: 'Confirmed with the customer by phone', expectedVersion: 1 },
        }),
      ),
    );
    expect((await screen.findAllByText('Warning dismissed')).length).toBeGreaterThan(0);
  });

  it('shows the API refusal in the dialog and keeps it open', async () => {
    navigateTo('/cases/case_1/quality?tab=warnings');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({
        'warnings.dismiss': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            title: 'Conflict',
            message: 'This warning can no longer be dismissed',
          });
        },
      }),
    });
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Dismiss warning: Disruptive change made before the cause was established',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Not needed any more');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss warning' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This warning can no longer be dismissed',
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('disables dismissal, with the reason, for a role that may not dismiss', async () => {
    navigateTo('/cases/case_1/quality?tab=warnings');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({}, ['case:read', 'quality:read', 'skill:read']),
    });
    const button = await screen.findByRole('button', {
      name: 'Dismiss warning: Disruptive change made before the cause was established',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not offer dismissal while looking at an earlier moment', async () => {
    navigateTo(`/cases/case_1/quality?tab=warnings&asOf=${AS_OF}`);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const button = await screen.findByRole('button', {
      name: 'Dismiss warning: Disruptive change made before the cause was established',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getAllByText(/A dismissal is recorded at the current time/).length,
    ).toBeGreaterThan(0);
  });

  it('asks the warnings of the same boundary as the rest of the page', async () => {
    navigateTo(`/cases/case_1/quality?tab=warnings&asOf=${AS_OF}`);
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    await screen.findByRole('group', { name: 'Warnings open at this moment' });
    const inputs = inputsOf(fake, 'warnings.list');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.query.asOf).toBe(AS_OF);
      expect(input.query.state).toBe('all');
    }
  });
});

describe('[FR-QR-07] Case Quality Review: SkillDNA matches', () => {
  it('shows how well a skill fits, with the evidence, and applies it only after confirmation', async () => {
    navigateTo('/cases/case_1/quality?tab=skills');
    const fake = api({
      'skillMatches.apply': () =>
        skillMatch({ applied: true, appliedAt: AS_OF, appliedBy: 'user_ava_engineer' }),
    });
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const card = await screen.findByRole('heading', {
      name: 'Isolate a pre-authentication failure before pursuing identity policy',
    });
    const item = card.closest('li') as HTMLElement;
    expect(within(item).getByText(/Match score 75%/)).toBeInTheDocument();
    expect(within(item).getByText(/up to 14 Apr 2026, 07:35:00 UTC/)).toBeInTheDocument();
    expect(within(item).getByText('Estimated match')).toBeInTheDocument();
    expect(within(item).getAllByText('Learned with hindsight').length).toBeGreaterThan(0);

    await userEvent.click(
      within(item).getByRole('button', {
        name: 'Apply to this case: Isolate a pre-authentication failure before pursuing identity policy',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/It does not change the case or run anything/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply skill' }));
    await waitFor(() =>
      expect(fake.call).toHaveBeenCalledWith(
        'skillMatches.apply',
        expect.objectContaining({ params: { caseId: 'case_1', matchId: 'smt_1' } }),
      ),
    );
    expect((await screen.findAllByText('Skill applied')).length).toBeGreaterThan(0);
  });

  it('reads the matches at the cursor and leaves applying for the present', async () => {
    navigateTo(`/cases/case_1/quality?tab=skills&asOf=${AS_OF}`);
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const button = await screen.findByRole('button', {
      name: 'Apply to this case: Isolate a pre-authentication failure before pursuing identity policy',
    });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText(/Skills extracted from this case are left out at an earlier moment/),
    ).toBeInTheDocument();
    for (const input of inputsOf(fake, 'skillMatches.list')) expect(input.query.asOf).toBe(AS_OF);
  });

  it('says plainly when no skill fits', async () => {
    navigateTo('/cases/case_1/quality?tab=skills');
    renderApp(<CaseQualityPage caseId="case_1" />, {
      api: api({ 'skillMatches.list': () => ({ items: [] }) }),
    });
    expect(await screen.findByText('No skill fits this case')).toBeInTheDocument();
  });

  it('shows what the API said when a skill can no longer be applied, and reloads the matches', async () => {
    navigateTo('/cases/case_1/quality?tab=skills');
    const fake = api({
      'skillMatches.apply': () => {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          title: 'Conflict',
          message: 'The skill is no longer available for matching.',
        });
      },
    });
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const button = await screen.findByRole('button', {
      name: 'Apply to this case: Isolate a pre-authentication failure before pursuing identity policy',
    });
    const before = inputsOf(fake, 'skillMatches.list').length;
    await userEvent.click(button);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply skill' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('It cannot be done from the current state.');
    expect(alert).toHaveTextContent('The API said: The skill is no longer available for matching.');
    await waitFor(() => expect(inputsOf(fake, 'skillMatches.list').length).toBeGreaterThan(before));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('[FR-QR-08] Case Quality Review: coaching and comparison', () => {
  it('shows a constructive, retrospective coaching report with its limits', async () => {
    navigateTo('/cases/case_1/quality?tab=coaching');
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
    const frame = await screen.findByRole('group', { name: 'Retrospective review' });
    expect(within(frame).getByText('Hindsight (not used to generate)')).toBeInTheDocument();
    expect(
      within(frame).getByText(/uses the whole record, including the outcome/),
    ).toBeInTheDocument();
    expect(within(frame).getByText(/it is not a rating of a person/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'What went well' })).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Most important missed opportunity' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/must not be used to rank, rate or discipline individual employees/),
    ).toBeInTheDocument();
    const limits = screen.getByRole('group', { name: 'Confidence and limitations' });
    expect(within(limits).getByText(/Confidence: Medium/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Isolate a pre-authentication failure' }),
    ).toHaveAttribute('href', '/skills/skl_1');
  });

  it('compares the case with another one, with the narrative, the stronger estimate and skill reuse', async () => {
    navigateTo('/cases/case_1/quality?tab=compare');
    const fake = api({}, MANAGER);
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    const table = await screen.findByRole('table', { name: 'Comparison of the two cases' });
    expect(within(table).getByText('Case Quality Index')).toBeInTheDocument();
    expect(within(table).getAllByText('CG-SYN-1002').length).toBeGreaterThan(0);
    expect(within(table).getByText('No clear difference')).toBeInTheDocument();
    expect(within(table).getByText('+175% (higher)')).toBeInTheDocument();
    expect(
      screen.getByText(/shows the stronger estimate on 2 of the 3 metrics/),
    ).toBeInTheDocument();
    const reuse = screen.getByRole('group', { name: 'Skill reuse' });
    expect(within(reuse).getByText(/4 of 4 steps/)).toBeInTheDocument();
    expect(screen.getByText(/do not show cause and effect/)).toBeInTheDocument();
    expect(inputsOf(fake, 'compare.cases')[0]?.query.caseIds).toBe('case_1,case_2');
    const frame = screen.getByRole('group', { name: 'Retrospective comparison' });
    expect(within(frame).getByText('Hindsight (not used to generate)')).toBeInTheDocument();
  });

  it('keeps the other case in the address', async () => {
    navigateTo('/cases/case_1/quality?tab=compare');
    renderApp(<CaseQualityPage caseId="case_1" />, { api: api({}, MANAGER) });
    const select = await screen.findByRole('combobox', { name: 'Compare with' });
    await userEvent.selectOptions(select, 'case_2');
    await waitFor(() => expect(window.location.search).toContain('with=case_2'));
  });

  it('explains that comparing cases needs a role with analytics access', async () => {
    navigateTo('/cases/case_1/quality?tab=compare');
    const fake = api();
    renderApp(<CaseQualityPage caseId="case_1" />, { api: fake });
    expect(
      await screen.findByText('You do not have access to the case comparison'),
    ).toBeInTheDocument();
    expect(inputsOf(fake, 'compare.cases')).toHaveLength(0);
  });
});

describe('[FR-QR-09] Case Quality Review accessibility', () => {
  it(
    'has no axe violations on the quality index in light mode',
    async () => {
      const { container } = renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
      await screen.findByRole('group', { name: 'Case Quality Index' });
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );

  it(
    'has no axe violations on the quality index in dark mode inside a time window',
    async () => {
      navigateTo(`/cases/case_1/quality?asOf=${AS_OF}`);
      const { container } = renderApp(<CaseQualityPage caseId="case_1" />, {
        api: api(),
        mode: 'dark',
      });
      await screen.findByText('Not yet assessable');
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );

  it.each(['effort', 'warnings', 'skills', 'coaching'])(
    'has no axe violations on the %s tab',
    async (tab) => {
      navigateTo(`/cases/case_1/quality?tab=${tab}`);
      const { container } = renderApp(<CaseQualityPage caseId="case_1" />, { api: api() });
      await screen.findByRole('tabpanel');
      await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );

  it(
    'has no axe violations on the comparison tab',
    async () => {
      navigateTo('/cases/case_1/quality?tab=compare');
      const { container } = renderApp(<CaseQualityPage caseId="case_1" />, {
        api: api({}, MANAGER),
      });
      await screen.findByRole('table', { name: 'Comparison of the two cases' });
      await expectNoAxeViolations(container);
    },
    AXE_TIMEOUT,
  );
});
