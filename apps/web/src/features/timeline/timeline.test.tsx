import type { SimulatedTimelineEvent, TimelineEvent } from '@caseguard/schemas';
import { formatDateTimeUtc } from '@caseguard/ui';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CASE_ID,
  caseDetail,
  eventDetail,
  hypothesesResponse,
  job,
  manyEvents,
  notAnalysedError,
  threeEvents,
  timelineResponse,
} from '../../../test/case-fixtures';
import { session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeApi,
  type FakeHandlers,
} from '../../../test/harness';
import { installNearEndObserver } from '../../../test/intersection';
import { liveRegionOf } from '../../../test/live-region';
import { navigateTo } from '../../../test/next-navigation';
import { ApiError } from '../../lib/api/errors';
import {
  TIMELINE_FILTERS,
  activeFilterCount,
  decisionWindow,
  matchesFlags,
  mergeRows,
  timelineQuery,
  type TimelineFilterValues,
} from './timeline-filters';
import { TimelinePage } from './TimelinePage';

const ENGINEER = ['case:read', 'case:ingest', 'case:analyze'] as const;
const AS_OF = '2026-03-09T09:41:00Z';

// A busy machine can take longer than the 1 s default to render a page for the first time.
configure({ asyncUtilTimeout: 30_000 });
vi.setConfig({ testTimeout: 120_000 });

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('engineer', [...ENGINEER]),
    'cases.get': () => caseDetail(),
    'timeline.get': () => timelineResponse(),
    'hypotheses.list': () => hypothesesResponse(),
    'events.get': () => eventDetail(),
    ...overrides,
  });
}

/** The query the page sent with its most recent request for `route`. */
function lastQuery(handler: FakeApi, route = 'timeline.get'): Record<string, unknown> | undefined {
  const calls = handler.call.mock.calls.filter(([id]) => id === route);
  return (calls[calls.length - 1]?.[1] as { query?: Record<string, unknown> } | undefined)?.query;
}

const param = (name: string): string | null =>
  new URLSearchParams(window.location.search).get(name);
const titles = (): (string | null)[] =>
  screen
    .getAllByRole('article')
    .map((article) => within(article).getByRole('heading', { level: 3 }).textContent);

/** Clicks a button once it is neither disabled nor waiting for the session's permissions. */
async function enabledButton(name: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true'),
  );
  return screen.getByRole('button', { name });
}

/** "What was known then" is a collapsed bar: open it to reach the time cursor and the counts of the moment. */
async function openKnownBar(): Promise<HTMLElement> {
  const bar = await screen.findByRole('button', { name: /^What was known then/ });
  if (bar.getAttribute('aria-expanded') !== 'true') await userEvent.setup().click(bar);
  return screen.findByRole('group', { name: 'Time cursor' });
}

/** The opened bar, for the counts and links of the chosen moment. */
const knownBar = (): Promise<HTMLElement> =>
  screen.findByRole('region', { name: /^What was known then/ });

/** Moves the whole page to the moment of the event at `index` (0-based) from its "More actions" menu. */
async function knownAsOfHere(index: number): Promise<void> {
  const user = userEvent.setup();
  const menus = screen.getAllByRole('button', { name: /^More actions for / });
  await user.click(menus[index] as HTMLElement);
  await user.click(await screen.findByRole('menuitem', { name: /^What was known here/ }));
}

/** The "Filters" popover of the page, opened: queries bound to its surface. */
async function openFilters() {
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: /^Filters/ });
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger);
  // The page behind a modal popover is hidden from assistive technology while it is open: its fields are found by label.
  const surface = (await screen.findByLabelText('Zoom from')).closest('[role="dialog"]');
  if (!(surface instanceof HTMLElement)) throw new Error('the filters are not in a dialog');
  return within(surface);
}

/** Closes the "Filters" popover with Escape and waits until it is gone. */
async function closeFilters(): Promise<void> {
  await userEvent.setup().keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByLabelText('Zoom from')).toBeNull());
}

describe('[FR-TIME-01] Timeline', () => {
  it('shows a skeleton, then every event in time order with its delays, repeats and key decisions', async () => {
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    expect(screen.getAllByText(/Loading the events/).length).toBeGreaterThan(0);

    expect(await screen.findByRole('list', { name: 'Events, 3 shown' })).toBeInTheDocument();
    expect(titles()).toEqual([
      'Teams sign-in failing intermittently',
      'Teams sign-in - information needed',
      'Repeat sign-in log query',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Timeline' })).toBeInTheDocument();

    const [first, second, third] = screen.getAllByRole('article') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(first).getByText('Customer email')).toBeInTheDocument();
    expect(within(first).getByText(/Customer IT Admin 1 · Customer admin/)).toBeInTheDocument();
    expect(within(first).getByText('Customer-reported observation')).toBeInTheDocument();

    expect(within(second).getByText('29 min after the previous event')).toBeInTheDocument();
    expect(within(second).getByText('Key decision')).toBeInTheDocument();
    expect(within(second).getByText('Very high customer effort')).toBeInTheDocument();
    expect(within(second).getByText('Action: Request HAR and Fiddler traces')).toBeInTheDocument();
    expect(
      within(second).getByRole('link', { name: 'See key decision 1 in What if' }),
    ).toHaveAttribute('href', '/cases/case_1/counterfactual?sel=fork_1');
    // The effect on the leading possible cause, named from the list of causes and labelled in points.
    expect(
      within(second).getByText('DNS resolution failure for sign-in endpoints down 10.7 points'),
    ).toBeInTheDocument();

    expect(within(third).getByText('Delay: 23 h 14 min')).toBeInTheDocument();
    expect(
      within(third).getByText('The customer waited 23 h 14 min for a reply.'),
    ).toBeInTheDocument();
    expect(within(third).getByText('Repeated diagnostic')).toBeInTheDocument();
    expect(within(third).getByRole('button', { name: 'e03' })).toBeInTheDocument();
  });

  it('draws the confidence chart as estimates', async () => {
    const user = userEvent.setup();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    const chart = await screen.findByRole('group', { name: 'Confidence over time' });
    expect(within(chart).getByText('Estimated')).toBeInTheDocument();
    expect(
      within(chart).getByText('How likely each possible cause looked after each event.'),
    ).toBeInTheDocument();
    expect(within(chart).getAllByRole('img').length).toBeGreaterThan(0);
    // The caveat sits behind the help button of the chart rather than in a banner above it.
    await user.click(within(chart).getByRole('button', { name: 'About Confidence over time' }));
    expect(await screen.findByText(/These are model estimates/)).toBeInTheDocument();
  });

  it('says so when there is nothing to plot', async () => {
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => timelineResponse({ hypothesisSeries: [] }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No confidence values yet' }),
    ).toBeInTheDocument();
  });

  it('renders a short list in full and windows a long one, announcing each row’s position', async () => {
    const short = renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': () =>
          timelineResponse({
            events: manyEvents(40),
            total: 40,
            delays: [],
            repeats: [],
            hypothesisSeries: [],
          }),
      }),
    });
    await screen.findByRole('list', { name: 'Events, 40 shown' });
    expect(screen.getAllByRole('article')).toHaveLength(40);
    short.unmount();

    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': () =>
          timelineResponse({
            events: manyEvents(500),
            total: 500,
            delays: [],
            repeats: [],
            hypothesisSeries: [],
          }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Events, 500 shown' });
    const rendered = screen.getAllByRole('article').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    const first = list.querySelector('li');
    expect(first).toHaveAttribute('aria-posinset', '1');
    expect(first).toHaveAttribute('aria-setsize', '500');
  });

  it('loads the next page with the cursor the API returned', async () => {
    const user = userEvent.setup();
    const events = threeEvents();
    const handler = api({
      'timeline.get': (input) => {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === 'cur_2'
          ? timelineResponse({ events: events.slice(2), nextCursor: null, total: 3 })
          : timelineResponse({ events: events.slice(0, 2), nextCursor: 'cur_2', total: 3 });
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(screen.getByText('2 of 3 events loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more events' }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(handler.call).toHaveBeenCalledWith(
      'timeline.get',
      expect.objectContaining({ query: expect.objectContaining({ cursor: 'cur_2', limit: 200 }) }),
    );
    expect(screen.queryByRole('button', { name: 'Load more events' })).toBeNull();
  });

  it('has no accessibility violations when loaded, with an event open', async () => {
    navigateTo('/cases/case_1/timeline?sel=e03');
    const { container } = renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    const drawer = await screen.findByRole('dialog', { name: 'Event details' });
    await within(drawer).findByText('Text as stored (after redaction)');
    // The drawer is outside the page's own container: it is checked as well.
    await expectNoAxeViolations(drawer);
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no accessibility violations with the "What was known then" bar and the filters open', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await openKnownBar();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await screen.findByLabelText('Zoom from');
    await expectNoAxeViolations(document.body);
  }, 120_000);
});

describe('[FR-TIME-02] filters, zoom and the address', () => {
  it('sends the server-side filters to the API and keeps them in the URL', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(lastQuery(handler)).toEqual({ limit: 200 });

    const filters = await openFilters();
    await user.click(filters.getByLabelText('Customer email'));
    await waitFor(() => expect(param('types')).toBe('customer_email'));
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({ limit: 200, types: 'customer_email' }),
    );
    expect(filters.getByText('Event kind (1)')).toBeInTheDocument();

    await user.selectOptions(filters.getByLabelText('Evidence category'), 'customer_reported');
    await waitFor(() => expect(param('category')).toBe('customer_reported'));
    await user.selectOptions(filters.getByLabelText('Possible cause'), 'hyp_1');
    await waitFor(() => expect(param('hyp')).toBe('hyp_1'));
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({
        limit: 200,
        types: 'customer_email',
        category: 'customer_reported',
        hypothesisId: 'hyp_1',
      }),
    );
    expect(screen.getByText(/3 filters on/)).toBeInTheDocument();
    // Escape closes the popover; the page behind it is hidden from assistive technology while it is open.
    await closeFilters();
    // The button says how many of the filters inside it are on.
    expect(await screen.findByRole('button', { name: 'Filters, 3 on' })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
    // The unfiltered list is already cached, so clearing shows it again without asking the API twice.
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/filters on/)).toBeNull());
  });

  it('restores everything from the address and ignores hostile values', async () => {
    navigateTo(
      '/cases/case_1/timeline?types=bogus,customer_email&roles=%3Cb%3E&category=evil&flags=nope&from=not-a-date&asOf=garbage&hyp=hyp_2',
    );
    const handler = api();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(lastQuery(handler)).toEqual({
      limit: 200,
      types: 'customer_email',
      hypothesisId: 'hyp_2',
    });
    expect(screen.getByRole('button', { name: 'Filters, 2 on' })).toBeInTheDocument();
    const filters = await openFilters();
    expect(filters.getByText('Event kind (1)')).toBeInTheDocument();
    expect(filters.getByLabelText('Customer email')).toBeChecked();
    await waitFor(() => expect(filters.getByLabelText('Possible cause')).toHaveValue('hyp_2'));
  });

  it('filters delays, repeated diagnostics and key decisions on the loaded events, loading the rest of them first', async () => {
    const user = userEvent.setup();
    const events = threeEvents();
    const handler = api({
      'timeline.get': (input) => {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === 'cur_2'
          ? timelineResponse({ events: events.slice(2), nextCursor: null, total: 3 })
          : timelineResponse({ events: events.slice(0, 2), nextCursor: 'cur_2', total: 3 });
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 2 shown' });

    await user.click(screen.getByRole('button', { name: 'Delays' }));
    expect(param('flags')).toBe('delay');
    expect(screen.getByRole('button', { name: 'Delays' })).toHaveAttribute('aria-pressed', 'true');
    // The delay is on the second page: the page fetches it so the filter is exact.
    await screen.findByRole('list', { name: 'Events, 1 shown' });
    expect(titles()).toEqual(['Repeat sign-in log query']);
    expect(screen.getByText(/Showing 1 of 3 events, 1 filter on/)).toBeInTheDocument();
    // The flags are not sent to the API: it has no such filter.
    for (const [route, input] of handler.call.mock.calls) {
      if (route !== 'timeline.get') continue;
      const query = (input as { query?: Record<string, unknown> }).query ?? {};
      expect(Object.keys(query).filter((key) => key !== 'cursor' && key !== 'limit')).toEqual([]);
    }

    await user.click(screen.getByRole('button', { name: 'Delays' }));
    await user.click(screen.getByRole('button', { name: 'Key decisions' }));
    await screen.findByRole('list', { name: 'Events, 1 shown' });
    expect(titles()).toEqual(['Teams sign-in - information needed']);
  });

  it('zooms to the events around a decision and clears the zoom', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await user.click(
      screen.getByRole('button', { name: 'More actions for Teams sign-in - information needed' }),
    );
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Zoom here: only the events around Teams sign-in - information needed',
      }),
    );
    expect(param('from')).toBe('2026-03-09T09:12:00Z');
    expect(param('to')).toBe('2026-03-10T08:55:00Z');
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({
        limit: 200,
        from: '2026-03-09T09:12:00Z',
        to: '2026-03-10T08:55:00Z',
      }),
    );
    // The window is a filter like the others: it counts once, and its bounds are in the popover.
    expect(screen.getByRole('button', { name: 'Filters, 1 on' })).toBeInTheDocument();
    const filters = await openFilters();
    expect(filters.getByLabelText('Zoom from')).toHaveValue('2026-03-09T09:12:00Z');
    expect(filters.getByLabelText('Zoom to')).toHaveValue('2026-03-10T08:55:00Z');
    await closeFilters();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('shortens a long event title in the zoom choices without cutting an emoji in half', async () => {
    const title = `${'a'.repeat(46)}😀 and then a lot more words`;
    const [first, ...rest] = threeEvents() as [TimelineEvent, ...TimelineEvent[]];
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': () => timelineResponse({ events: [{ ...first, title }, ...rest] }),
      }),
    });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    const filters = await openFilters();
    const options = within(filters.getByLabelText('Zoom from'))
      .getAllByRole('option', { hidden: true })
      .map((option) => option.textContent ?? '');
    // The 48-character limit falls inside the emoji: it is left out whole, never cut in half.
    expect(options.some((text) => text.endsWith(` · ${'a'.repeat(46)}…`))).toBe(true);
    expect(options.every((text) => !/[\ud800-\udbff](?![\udc00-\udfff])/.test(text))).toBe(true);
  });

  it('explains when no event matches the filters and offers to clear them', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/timeline?types=customer_email');
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => timelineResponse({ events: [], total: 0 }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No events match these filters' }),
    ).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('says plainly that a case has no events', async () => {
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => timelineResponse({ events: [], total: 0 }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No events at this moment' }),
    ).toBeInTheDocument();
    expect(screen.getByText('This case has no events.')).toBeInTheDocument();
  });

  it('overlays the simulated path of a scenario, labelled Simulated and Estimated', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/timeline?scenario=scn_1');
    const step: SimulatedTimelineEvent = {
      id: 'sim_1',
      scenarioId: 'scn_1',
      stepIndex: 0,
      timestamp: '2026-03-09T09:30:00Z',
      label: 'Ask for a resolver query instead',
      actionKey: 'act.resolve-dns',
      actionKind: 'log_query',
      customerEffort: 'low',
      outcomeLabel: 'Root cause found sooner',
      probability: 0.62,
      simulated: true,
    };
    const handler = api({ 'timeline.get': () => timelineResponse({ simulatedEvents: [step] }) });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 4 shown' });
    expect(lastQuery(handler)).toEqual({ limit: 200, scenarioId: 'scn_1' });
    expect(titles()).toEqual([
      'Teams sign-in failing intermittently',
      'Ask for a resolver query instead',
      'Teams sign-in - information needed',
      'Repeat sign-in log query',
    ]);
    const simulated = screen.getAllByRole('article')[1] as HTMLElement;
    expect(within(simulated).getByText('Simulated')).toBeInTheDocument();
    expect(within(simulated).getByText('Estimated')).toBeInTheDocument();
    expect(
      within(simulated).getByText(
        /Predicted outcome: Root cause found sooner \(estimated probability 62%\)/,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove the overlay' }));
    await waitFor(() => expect(param('scenario')).toBeNull());
  });
});

describe('[FR-TIME-03] the time cursor', () => {
  const asOfResponse = (input: unknown) => {
    const asOf = (input as { query?: { asOf?: string } }).query?.asOf;
    return asOf
      ? timelineResponse({
          asOf,
          events: threeEvents().slice(0, 2),
          total: 2,
          withheldFutureEventCount: 1,
          knownAtAsOf: {
            evidenceCount: 9,
            claimCount: 20,
            criticalMissingCount: 1,
            openWarningCount: 3,
          },
        })
      : timelineResponse();
  };

  it('keeps the time cursor in one collapsed bar, and explains in a tooltip what it does', async () => {
    const user = userEvent.setup();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    const bar = screen.getByRole('button', { name: /^What was known then/ });
    expect(bar).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Showing the whole record, up to the last event.')).toBeInTheDocument();
    // The bar is usually closed when the moment changes, so a screen reader is told through a polite status.
    expect(screen.getByText('Now showing the whole record.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('slider', { name: 'Time cursor' })).toBeNull();

    await user.hover(screen.getByRole('button', { name: 'About what was known then' }));
    expect(
      await screen.findByText(/Replays the case as it stood at an earlier moment/),
    ).toBeInTheDocument();

    await user.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('slider', { name: 'Time cursor' })).toBeInTheDocument();
  });

  it('"What was known here" limits the whole view to what was known at that event', async () => {
    const handler = api({ 'timeline.get': asOfResponse });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    expect(param('asOf')).toBe(AS_OF);
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(await screen.findByText(/^Now showing the case as of /)).toHaveAttribute(
      'role',
      'status',
    );
    expect(lastQuery(handler)).toEqual({ limit: 200, asOf: AS_OF });
    expect(lastQuery(handler, 'hypotheses.list')).toEqual({ asOf: AS_OF });
    await openKnownBar();
    const cursor = within(await knownBar());
    expect(await cursor.findByText('Later events withheld')).toBeInTheDocument();
    expect(cursor.getByText('Critical evidence still missing')).toBeInTheDocument();
    expect(cursor.getByRole('link', { name: 'Evidence at this moment' })).toHaveAttribute(
      'href',
      `/cases/case_1/evidence?asOf=${encodeURIComponent(AS_OF)}`,
    );
    expect(cursor.getByRole('link', { name: 'Possible causes at this moment' })).toHaveAttribute(
      'href',
      `/cases/case_1/hypotheses?asOf=${encodeURIComponent(AS_OF)}`,
    );
    expect(screen.queryByRole('heading', { name: 'Repeat sign-in log query' })).toBeNull();
  });

  it('restores the moment from the address and returns to the whole record', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({ 'timeline.get': asOfResponse });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(lastQuery(handler)).toEqual({ limit: 200, asOf: AS_OF });
    expect(screen.getByText('Earlier view')).toBeInTheDocument();
    const cursor = within(await openKnownBar());
    await user.click(await cursor.findByRole('button', { name: 'Latest' }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(param('asOf')).toBeNull();
  });

  it('goes back to the latest from the bar, without opening it', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api({ 'timeline.get': asOfResponse }) });
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    await user.click(screen.getByRole('button', { name: 'Back to latest' }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(param('asOf')).toBeNull();
    expect(screen.queryByText('Earlier view')).toBeNull();
  });

  it('explains when nothing had been recorded by the chosen moment', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => timelineResponse({ asOf: AS_OF, events: [], total: 0 }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No events at this moment' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing had been recorded by the selected moment/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(param('asOf')).toBeNull());
  });

  it('says that reviewer decisions recorded later are not shown, in an earlier view only', async () => {
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    const { unmount } = renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': asOfResponse }),
    });
    await openKnownBar();
    const cursor = within(await knownBar());
    expect(
      await cursor.findByText(
        'Reviewer decisions recorded later are not shown in this earlier view.',
      ),
    ).toBeInTheDocument();
    unmount();

    navigateTo('/cases/case_1/timeline');
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api({ 'timeline.get': asOfResponse }) });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await openKnownBar();
    expect(screen.queryByText(/Reviewer decisions recorded later are not shown/)).toBeNull();
  });
});

describe('[FR-TIME-06] earlier views are metered: snapped, debounced, cancelled and calmly refused', () => {
  const asOfOf = (input: unknown): string | undefined =>
    (input as { query?: { asOf?: string } }).query?.asOf;
  const asOfResponse = (input: unknown) => {
    const asOf = asOfOf(input);
    return asOf
      ? timelineResponse({
          asOf,
          events: threeEvents().slice(0, 2),
          total: 2,
          withheldFutureEventCount: 1,
        })
      : timelineResponse();
  };
  const refuse = (retryAfterMs = 2000): ApiError =>
    new ApiError({
      status: 429,
      code: 'rate_limited',
      reason: 'engine_budget',
      title: 'Too many requests',
      message: 'Too many requests',
      retryAfterMs,
    });
  const askedFor = (handler: FakeApi): (string | undefined)[] =>
    handler.call.mock.calls
      .filter(([id]) => id === 'timeline.get')
      .map(([, input]) => asOfOf(input))
      .filter((value) => value !== undefined);

  it('lands the cursor on an event and sends one request when the drag stops', async () => {
    const handler = api({ 'timeline.get': asOfResponse });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await openKnownBar();
    const slider = await screen.findByRole('slider', { name: 'Time cursor' });
    // Three quick moves, as in a drag: nothing is sent until it stops, and then only the last place, moved to the last
    // event at or before it (the answer between two events is the same).
    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.change(slider, { target: { value: '1500' } });
    fireEvent.change(slider, { target: { value: '3000' } });
    await waitFor(() => expect(param('asOf')).toBe('2026-03-10T08:55:00Z'));
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(askedFor(handler)).toEqual(['2026-03-10T08:55:00Z']);
  });

  it('steps from event to event with the cursor buttons, forward as well as back', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({ 'timeline.get': asOfResponse });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    const cursor = within(await openKnownBar());
    await user.click(await cursor.findByRole('button', { name: 'Next event' }));
    await waitFor(() => expect(param('asOf')).toBe('2026-03-10T08:55:00Z'));
    await user.click(cursor.getByRole('button', { name: 'Previous event' }));
    await waitFor(() => expect(param('asOf')).toBe(AS_OF));
    // Going back to a window that was already opened costs no new request: it is kept.
    expect(askedFor(handler).filter((value) => value === AS_OF)).toHaveLength(1);
  });

  it('cancels the request of a view that was replaced before it finished', async () => {
    const user = userEvent.setup();
    const signals: (AbortSignal | undefined)[] = [];
    const handler = api({
      'timeline.get': (input) => {
        if (asOfOf(input) === AS_OF) {
          signals.push((input as { signal?: AbortSignal }).signal);
          return new Promise(() => undefined);
        }
        return asOfResponse(input);
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    // The events give way to a loading state meanwhile; the cursor stays, and moving it replaces the request.
    await user.click(
      within(await openKnownBar()).getByRole('button', {
        name: 'Next event',
      }),
    );
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await screen.findByRole('list', { name: 'Events, 2 shown' });
  });

  it('asks for an earlier view without hidden retries, so a refusal is shown as it arrives', async () => {
    const handler = api({ 'timeline.get': asOfResponse });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    const earlier = handler.call.mock.calls.find(
      ([id, input]) => id === 'timeline.get' && asOfOf(input) === AS_OF,
    );
    expect((earlier?.[1] as { maxRetries?: number }).maxRetries).toBe(0);
    const whole = handler.call.mock.calls.find(
      ([id, input]) => id === 'timeline.get' && !asOfOf(input),
    );
    expect((whole?.[1] as { maxRetries?: number }).maxRetries).toBeUndefined();
  });

  it('shows its loading state, and nothing of the whole record, while the chosen moment loads', async () => {
    const handler = api({
      'timeline.get': (input) =>
        asOfOf(input) ? new Promise(() => undefined) : timelineResponse(),
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(screen.getByRole('group', { name: 'Confidence over time' })).toBeInTheDocument();
    await knownAsOfHere(1);
    await waitFor(() => expect(param('asOf')).toBe(AS_OF));

    // It says which moment is being looked up, and shows placeholders.
    expect(
      await screen.findByText(`Looking up what was known at ${formatDateTimeUtc(AS_OF)}…`),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Loading the events/).length).toBeGreaterThan(0);
    // Nothing of the whole record is left: no events, chart or counts, and no claim that nothing had been recorded.
    expect(screen.queryByRole('list', { name: /^Events, \d+ shown$/ })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^More actions for / })).toHaveLength(0);
    expect(screen.queryByText('Repeat sign-in log query')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Confidence over time' })).toBeNull();
    expect(screen.queryByText(/No event had been recorded/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No events at this moment' })).toBeNull();
    // The cursor stays where it is (a keyboard user is in the middle of it), without the counts of another moment, and
    // the busy region says so.
    await openKnownBar();
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.queryByText('Later events withheld')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows its loading state too while the cursor is still reading the events it lands on', async () => {
    const handler = api({
      'timeline.get': (input) => {
        if ((input as { query?: { cursor?: string } }).query?.cursor === 'c2')
          return new Promise(() => undefined);
        return timelineResponse({ nextCursor: 'c2', total: 4 });
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    // The rest of the case's events never arrives, so no earlier view can be asked for yet: the whole record that was
    // on screen is not left there under the cursor, dimmed or not.
    expect(
      await screen.findByText(`Looking up what was known at ${formatDateTimeUtc(AS_OF)}…`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /^Events, \d+ shown$/ })).toBeNull();
    expect(screen.getAllByText(/Loading the events/).length).toBeGreaterThan(0);
    expect(askedFor(handler)).toEqual([]);
  });

  it('shows a calm notice with the Retry-After countdown, keeps the cursor, and recovers when the budget refills', async () => {
    const user = userEvent.setup();
    let limited = true;
    const handler = api({
      'timeline.get': (input) => {
        if (!asOfOf(input)) return timelineResponse();
        if (limited) throw refuse();
        return asOfResponse(input);
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    const notice = (await screen.findByText('Earlier views are limited')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(notice).getByText(/the timeline could not be computed for this moment just now/),
    ).toBeInTheDocument();
    const retry = within(notice).getByRole('button', { name: /Retry in \d s/ });
    expect(retry).toBeDisabled();
    // The countdown ticks every second: it is not inside a live region, which would be read out each time. One static
    // sentence is announced instead.
    expect(liveRegionOf(retry)).toBeNull();
    expect(
      screen.getByText(/^Earlier views are limited\. Try again in \d seconds?\.$/),
    ).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).toBeNull();
    // The page is intact: the cursor is there, and so is the way back to the whole record.
    await openKnownBar();
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to latest' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Timeline' })).toBeInTheDocument();

    limited = false;
    await waitFor(
      () => expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled(),
      {
        timeout: 6000,
      },
    );
    expect(screen.getByText('You can retry now.')).toHaveAttribute('role', 'status');
    await user.click(within(notice).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });

  it('returns to the whole record from the notice, which is never limited', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({
      'timeline.get': (input) => {
        if (asOfOf(input)) throw refuse(30000);
        return timelineResponse();
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await user.click(await screen.findByRole('button', { name: 'Show the whole record' }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(param('asOf')).toBeNull();
  });

  it('keeps showing windows that were already opened while new ones are refused', async () => {
    const user = userEvent.setup();
    let limited = false;
    const handler = api({
      'timeline.get': (input) => {
        if (asOfOf(input) && limited) throw refuse();
        return asOfResponse(input);
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    // The budget is now empty. Back to the whole record, and to the window that was already open: no request, no notice.
    limited = true;
    const cursor = within(await openKnownBar());
    await user.click(cursor.getByRole('button', { name: 'Latest' }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    await knownAsOfHere(1);
    await screen.findByRole('list', { name: 'Events, 2 shown' });
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
    expect(askedFor(handler)).toEqual([AS_OF]);
  });

  it('shows the instant the API cut the evidence at, on the chart and in the bar, not the one asked for', async () => {
    const cut = '2026-03-09T09:12:00Z';
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': (input) =>
          asOfOf(input)
            ? timelineResponse({
                asOf: cut,
                events: threeEvents().slice(0, 1),
                total: 1,
                withheldFutureEventCount: 2,
              })
            : timelineResponse(),
      }),
    });
    const chart = await screen.findByRole('group', { name: 'Confidence over time' });
    expect(
      within(chart).getByText(
        `How likely each possible cause looked, up to ${formatDateTimeUtc(cut)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        `Showing the case as of ${formatDateTimeUtc(cut)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    await openKnownBar();
    const cursor = within(await knownBar());
    expect(
      await cursor.findByLabelText(`Known as of ${formatDateTimeUtc(cut)}`),
    ).toBeInTheDocument();
    expect(cursor.getByText('2')).toBeInTheDocument();
  });

  it('says in the chart help that an earlier view’s ranges are not comparable with the whole record’s', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    const { unmount } = renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': asOfResponse }),
    });
    const chart = within(await screen.findByRole('group', { name: 'Confidence over time' }));
    await user.click(chart.getByRole('button', { name: 'About Confidence over time' }));
    expect(
      await screen.findByText(
        /cannot be compared number for number with the range of the whole record/,
      ),
    ).toBeInTheDocument();
    unmount();

    navigateTo('/cases/case_1/timeline');
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api({ 'timeline.get': asOfResponse }) });
    const whole = within(await screen.findByRole('group', { name: 'Confidence over time' }));
    await user.click(whole.getByRole('button', { name: 'About Confidence over time' }));
    expect(await screen.findByText(/The shaded band is the leading cause/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be compared number for number/)).toBeNull();
  });

  it('reports a refused lookup of the possible causes next to the chart without taking the page down', async () => {
    navigateTo(`/cases/case_1/timeline?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': asOfResponse,
        'hypotheses.list': () => {
          throw refuse();
        },
      }),
    });
    const chart = within(await screen.findByRole('group', { name: 'Confidence over time' }));
    expect(await chart.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(
      chart.getByText(
        /the likely ranges and the names of the possible causes could not be computed for this moment just now/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Events, 2 shown' })).toBeInTheDocument();
  });

  it('reports a refused event lookup inside the event drawer', async () => {
    navigateTo(`/cases/case_1/timeline?sel=e03&asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': asOfResponse,
        'events.get': () => {
          throw refuse();
        },
      }),
    });
    const panel = within(await screen.findByRole('dialog', { name: 'Event details' }));
    expect(await panel.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(
      panel.getByText(/this event could not be computed for this moment just now/),
    ).toBeInTheDocument();
  });
});

describe('[FR-TIME-07] a page that failed is not requested again in a loop', () => {
  /** Three events in two pages; the second page fails until `recover()`. */
  function failingSecondPage() {
    const events = threeEvents();
    let failing = true;
    let secondPage = 0;
    const handler = api({
      'timeline.get': (input) => {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        if (cursor !== 'cur_2')
          return timelineResponse({ events: events.slice(0, 2), nextCursor: 'cur_2', total: 3 });
        secondPage += 1;
        if (failing)
          throw new ApiError({
            status: 503,
            code: 'unavailable',
            title: 'Unavailable',
            message: 'The service is unavailable.',
          });
        return timelineResponse({ events: events.slice(2), nextCursor: null, total: 3 });
      },
    });
    return {
      handler,
      requests: () => secondPage,
      recover: () => {
        failing = false;
      },
    };
  }
  const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => vi.unstubAllGlobals());

  it('while a flag is on, asks for the page that failed once, and again only for each press of Retry', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/timeline?flags=delay');
    const { handler, requests, recover } = failingSecondPage();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('The timeline could not be loaded')).toBeInTheDocument();
    // The filter used to ask again for ever: every failure made it ask again.
    await settle();
    expect(requests()).toBe(1);

    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(requests()).toBe(2));
    await settle();
    expect(requests()).toBe(2);

    recover();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await screen.findByRole('list', { name: 'Events, 1 shown' });
    expect(requests()).toBe(3);
    await settle(200);
    expect(requests()).toBe(3);
  });

  it('while the end of the list is in view, asks for the page that failed once, and again only for each press of Retry', async () => {
    const user = userEvent.setup();
    const observer = installNearEndObserver();
    const { handler, requests, recover } = failingSecondPage();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('The timeline could not be loaded')).toBeInTheDocument();
    // A rebuilt observer reports at once, which used to repeat the request that had just failed.
    await settle();
    expect(requests()).toBe(1);
    expect(observer.created()).toBe(1);

    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(requests()).toBe(2));
    await settle();
    expect(requests()).toBe(2);

    recover();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    expect(requests()).toBe(3);
    expect(observer.created()).toBe(1);
  });
});

describe('[FR-TIME-04] the selected event', () => {
  it('shows its full text, claims and conversation in a drawer and follows links between events', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    // Nothing is open until an event is chosen: there is no standing side panel.
    expect(screen.queryByRole('dialog', { name: 'Event details' })).toBeNull();

    await user.click(
      screen.getByRole('button', { name: /^Details of Teams sign-in - information needed/ }),
    );
    expect(param('sel')).toBe('e03');
    const panel = within(await screen.findByRole('dialog', { name: 'Event details' }));
    expect(
      await panel.findByText(
        /Please send a HAR capture and a Fiddler trace from three affected users/,
      ),
    ).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'events.get',
      expect.objectContaining({ params: { caseId: CASE_ID, eventId: 'e03' }, query: {} }),
    );
    const claims = panel.getByRole('list', { name: 'Derived claims' });
    expect(within(claims).getByText('Customer must send a HAR capture.')).toBeInTheDocument();
    expect(within(claims).getByRole('link', { name: 'Open in Evidence' })).toHaveAttribute(
      'href',
      '/cases/case_1/evidence?sel=clm_e03',
    );
    expect(panel.getByText('No evidence signals were observed in this event.')).toBeInTheDocument();
    expect(panel.getByText('Nothing redacted')).toBeInTheDocument();
    expect(panel.getByText('#2 in time order')).toBeInTheDocument();

    await user.click(panel.getByRole('button', { name: /Re: Teams sign-in - information needed/ }));
    expect(param('sel')).toBe('e04');
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'events.get',
        expect.objectContaining({ params: { caseId: CASE_ID, eventId: 'e04' } }),
      ),
    );

    await user.click(panel.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(param('sel')).toBeNull());
  });

  it('opens the event named in the address, and can move the whole page to its moment', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/timeline?sel=e03');
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: api() });
    const panel = within(await screen.findByRole('dialog', { name: 'Event details' }));
    expect(await panel.findByText('Text as stored (after redaction)')).toBeInTheDocument();
    await user.click(await panel.findByRole('button', { name: 'Show what was known here' }));
    expect(param('asOf')).toBe(AS_OF);
  });

  it('passes the time cursor on when reading the event, and says when it is not in view', async () => {
    navigateTo(`/cases/case_1/timeline?sel=e99&asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({
      'events.get': () => {
        throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
      },
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    const panel = within(await screen.findByRole('dialog', { name: 'Event details' }));
    expect(
      await panel.findByRole('heading', { name: 'This event is not in the current view' }),
    ).toBeInTheDocument();
    expect(
      panel.getByText(/It may be after the selected moment, so it is withheld/),
    ).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'events.get',
      expect.objectContaining({
        params: { caseId: CASE_ID, eventId: 'e99' },
        query: { asOf: AS_OF },
      }),
    );
  });
});

describe('[FR-TIME-05] a case that is not analysed, loading and errors', () => {
  it('explains that the timeline needs the analysis and lets an engineer start it', async () => {
    const user = userEvent.setup();
    const handler = api({
      'cases.get': () =>
        caseDetail({ analysisState: 'not_analyzed', lastAnalysisRunId: null, analyzedAt: null }),
      'timeline.get': () => {
        throw notAnalysedError();
      },
      'analysis.start': () => ({ job: job(), runId: null, reused: false }),
      'jobs.get': () => job(),
    });
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    expect(
      await screen.findByRole('heading', { name: 'This case has not been analysed yet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the case overview' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    await user.click(await enabledButton('Start the analysis'));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ params: { caseId: CASE_ID }, body: {} }),
      ),
    );
    expect(await screen.findByText('Analysing the case')).toBeInTheDocument();
  });

  it('does not let a role without case:analyze start it', async () => {
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'session.me': () => session('reviewer', ['case:read']),
        'timeline.get': () => {
          throw notAnalysedError();
        },
      }),
    });
    const start = await screen.findByRole('button', { name: 'Start the analysis' });
    await waitFor(() => expect(start).toHaveAttribute('aria-disabled', 'true'));
  });

  it('shows an error with Retry and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderApp(<TimelinePage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal server error',
              correlationId: 'corr-tl-1',
            });
          return timelineResponse();
        },
      }),
    });
    expect(await screen.findByText('The timeline could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('corr-tl-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('list', { name: 'Events, 3 shown' })).toBeInTheDocument();
  });

  it('says the case cannot be found, with a way back, and never waits for it, when it does not exist', async () => {
    const missing = (): never => {
      throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
    };
    renderApp(<TimelinePage caseId="case_gone" />, {
      api: api({ 'cases.get': missing, 'timeline.get': missing }),
    });
    expect(
      await screen.findByRole('heading', { name: 'We could not find that case' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse cases' })).toHaveAttribute('href', '/cases');
    expect(screen.queryByText(/Loading what was known/)).toBeNull();
    expect(screen.queryByText('The timeline could not be loaded')).toBeNull();
    // Nothing is left busy: a screen reader would otherwise announce a page that is loading for ever.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('refreshes on demand', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<TimelinePage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Events, 3 shown' });
    const before = handler.call.mock.calls.filter(([id]) => id === 'timeline.get').length;
    await user.click(await enabledButton('Refresh'));
    await waitFor(() =>
      expect(
        handler.call.mock.calls.filter(([id]) => id === 'timeline.get').length,
      ).toBeGreaterThan(before),
    );
  });
});

describe('timeline filter helpers', () => {
  const none: TimelineFilterValues = {
    types: [],
    roles: [],
    category: 'all',
    hyp: null,
    flags: [],
    from: null,
    to: null,
    scenario: null,
  };

  it('sends only the filters the server applies, and the time boundary', () => {
    expect(timelineQuery(none, null)).toEqual({ limit: 200 });
    expect(
      timelineQuery(
        {
          ...none,
          types: ['customer_email', 'engineer_email'],
          roles: ['support_engineer'],
          category: 'ai_inference',
          hyp: 'hyp_1',
          flags: ['delay'],
          from: '2026-03-09T09:12:00Z',
          to: '2026-03-10T08:55:00Z',
          scenario: 'scn_1',
        },
        AS_OF,
      ),
    ).toEqual({
      limit: 200,
      asOf: AS_OF,
      types: 'customer_email,engineer_email',
      roles: 'support_engineer',
      category: 'ai_inference',
      hypothesisId: 'hyp_1',
      from: '2026-03-09T09:12:00Z',
      to: '2026-03-10T08:55:00Z',
      scenarioId: 'scn_1',
    });
  });

  it('counts the narrowing filters, treating the zoom window as one', () => {
    expect(activeFilterCount(none)).toBe(0);
    expect(
      activeFilterCount({ ...none, from: '2026-03-09T09:12:00Z', to: '2026-03-10T08:55:00Z' }),
    ).toBe(1);
    expect(
      activeFilterCount({ ...none, types: ['customer_email'], flags: ['delay', 'fork'], hyp: 'h' }),
    ).toBe(3);
  });

  it('keeps events that carry every selected flag', () => {
    const [plain, fork, delay] = threeEvents() as [TimelineEvent, TimelineEvent, TimelineEvent];
    expect(matchesFlags(plain, [])).toBe(true);
    expect(matchesFlags(plain, ['delay'])).toBe(false);
    expect(matchesFlags(fork, ['fork'])).toBe(true);
    expect(matchesFlags(delay, ['delay', 'repeat'])).toBe(true);
    expect(matchesFlags(delay, ['delay', 'fork'])).toBe(false);
  });

  it('interleaves simulated steps by time, recorded events first at the same instant', () => {
    const events = threeEvents();
    const step = (id: string, timestamp: string): SimulatedTimelineEvent => ({
      id,
      scenarioId: 'scn_1',
      stepIndex: 0,
      timestamp,
      label: id,
      actionKey: 'act.x',
      actionKind: 'log_query',
      customerEffort: 'none',
      outcomeLabel: 'x',
      probability: 0.5,
      simulated: true,
    });
    const rows = mergeRows(events, [
      step('s_tie', '2026-03-09T09:41:00Z'),
      step('s_early', '2026-03-09T09:20:00Z'),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['e01', 's_early', 'e03', 's_tie', 'e05']);
  });

  it('spans the neighbours of an event for "Zoom here"', () => {
    const events = threeEvents();
    expect(decisionWindow(events, 1)).toEqual({
      from: events[0]?.timestamp,
      to: events[2]?.timestamp,
    });
    expect(decisionWindow(events, 0)).toEqual({
      from: events[0]?.timestamp,
      to: events[1]?.timestamp,
    });
    expect(decisionWindow(events, 9)).toBeNull();
  });

  it('accepts only known values in the URL lists', () => {
    expect(TIMELINE_FILTERS.types.parse('customer_email,<script>,customer_email')).toEqual([
      'customer_email',
      'customer_email',
    ]);
    expect(TIMELINE_FILTERS.types.serialize(['customer_email', 'customer_email'])).toBe(
      'customer_email',
    );
    expect(TIMELINE_FILTERS.roles.parse('nobody,support_engineer')).toEqual(['support_engineer']);
    expect(TIMELINE_FILTERS.flags.parse('delay,wat')).toEqual(['delay']);
    expect(TIMELINE_FILTERS.category.parse('evil')).toBe('all');
  });
});
