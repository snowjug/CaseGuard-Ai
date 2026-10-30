import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  CASE_ID,
  analysisRun,
  caseDetail,
  finishedJob,
  job,
  notAnalysedError,
  timelineResponse,
  twin,
} from '../../../test/case-fixtures';
import { session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { liveRegionOf } from '../../../test/live-region';
import { navigateTo, router } from '../../../test/next-navigation';
import { formatDateTimeUtc } from '@caseguard/ui';
import { ApiError } from '../../lib/api/errors';
import { CaseOverviewPage } from './CaseOverviewPage';

const ENGINEER = ['case:read', 'case:ingest', 'case:analyze'] as const;
const ADMIN = [...ENGINEER, 'case:delete'] as const;
const TITLE = 'Intermittent Teams sign-in failures for about 140 branch users';
// An event instant of `threeEvents()`: the cursor always lands on an event, so an address names one.
const AS_OF = '2026-03-10T08:55:00Z';

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('engineer', [...ENGINEER]),
    'cases.get': () => caseDetail(),
    'analysis.latest': () => ({ run: analysisRun() }),
    'twin.get': () => twin(),
    'timeline.get': () => timelineResponse(),
    ...overrides,
  });
}

const group = async (name: string) => within(await screen.findByRole('group', { name }));

/** The button once the session has loaded: until then permission-gated buttons are present but disabled. */
async function enabledButton(name: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true'),
  );
  return screen.getByRole('button', { name });
}

// A busy machine can take longer than the 1 s default to render a page for the first time.
configure({ asyncUtilTimeout: 5000 });

describe('[FR-CASE-01] Case overview', () => {
  it('shows a skeleton, then the case with its facts, source and screening', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    expect(screen.getAllByText(/Loading the case/).length).toBeGreaterThan(0);

    expect(await screen.findByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
    expect(screen.getAllByText('Analysed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Synthetic').length).toBeGreaterThan(0);

    const facts = await group('Key facts');
    expect(facts.getByText('CG-SYN-1001')).toBeInTheDocument();
    expect(facts.getByText('Microsoft Teams')).toBeInTheDocument();
    expect(facts.getByText('teams-authentication')).toBeInTheDocument();
    expect(facts.getByText('Severity A')).toBeInTheDocument();
    expect(facts.getByText('Contoso Synthetic Ltd')).toBeInTheDocument();
    expect(facts.getByText('Resolved')).toBeInTheDocument();
    expect(facts.getByText('31')).toBeInTheDocument();
    expect(facts.getByRole('list', { name: 'Tags' })).toHaveTextContent('authentication');

    const received = await group('How it was received');
    expect(received.getByText('Built-in sample')).toBeInTheDocument();
    expect(received.getByText('case-one.json')).toBeInTheDocument();
    expect(received.getByText('22,769 bytes')).toBeInTheDocument();
    expect(received.getByText('Nothing needed redaction')).toBeInTheDocument();
    expect(received.getByText('Nothing flagged')).toBeInTheDocument();
    expect(received.getByRole('button', { name: 'Copy received hash' })).toBeInTheDocument();
  });

  it('reports redaction and a prompt-injection flag from the screening', async () => {
    const flagged = caseDetail({
      injectionDetected: true,
      redactionApplied: true,
      redactionReplacements: 3,
      source: {
        ...caseDetail().source,
        redactionApplied: true,
        redactionReplacements: 3,
      },
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api({ 'cases.get': () => flagged }) });
    const received = await group('How it was received');
    expect(received.getByText('3 values replaced')).toBeInTheDocument();
    expect(received.getByText('Flagged')).toBeInTheDocument();
  });

  it('links to every other case page with the totals of the latest analysis', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const pages = await screen.findByRole('list', { name: 'Case pages' });
    const hrefs = within(pages)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/cases/case_1/timeline',
      '/cases/case_1/evidence',
      '/cases/case_1/hypotheses',
      '/cases/case_1/counterfactual',
      '/cases/case_1/quality',
    ]);
    expect(await within(pages).findByText('31 events')).toBeInTheDocument();
    expect(within(pages).getByText('61 claims · 26 evidence items')).toBeInTheDocument();
    expect(within(pages).getByText('9 hypotheses')).toBeInTheDocument();
    expect(within(pages).getByText('9 decision forks')).toBeInTheDocument();
    expect(within(pages).getByText('14 live warnings')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the timeline/ })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline',
    );
  });
});

describe('[FR-CASE-02] digital twin', () => {
  it('shows each field with its confidence estimate, extraction method, review status and source', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Digital twin');
    expect(await panel.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    expect(panel.getByText('Confidence 90% (estimate)')).toBeInTheDocument();
    expect(panel.getByText('Rule')).toBeInTheDocument();
    expect(panel.getByText('Awaiting review')).toBeInTheDocument();
    const source = panel.getByRole('link', { name: 'Event e01' });
    expect(source).toHaveAttribute('href', '/cases/case_1/timeline?sel=e01');
    expect(panel.getByText(/2 fields in 3 sections/)).toBeInTheDocument();
    expect(panel.getByText(/Confidence values are model estimates/)).toBeInTheDocument();
  });

  it('opens a section on demand and lists the participants the twin knows', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Digital twin');
    await user.click(await panel.findByRole('button', { name: /Participants/ }));
    const people = await panel.findByRole('list', { name: 'Participants' });
    expect(within(people).getByText('Customer IT Admin 1')).toBeInTheDocument();
    expect(within(people).getByText('6 events')).toBeInTheDocument();
  });

  it('says plainly when a section has no extracted values', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Digital twin');
    await user.click(await panel.findByRole('button', { name: /Remaining risks/ }));
    expect(await panel.findByText(/No values were extracted for this section/)).toBeInTheDocument();
  });

  it('explains that the digital twin needs the analysis when the API answers 409 not_analysed', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'cases.get': () =>
          caseDetail({ analysisState: 'not_analyzed', lastAnalysisRunId: null, analyzedAt: null }),
        'analysis.latest': () => ({ run: null }),
        'twin.get': () => {
          throw notAnalysedError();
        },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'No digital twin yet' })).toBeInTheDocument();
    expect(screen.getAllByText('Not analysed').length).toBeGreaterThan(0);
  });

  it('does not take the wording for the condition: a 409 without the not_analysed reason is an ordinary error', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'twin.get': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            title: 'Conflict',
            message: 'This case has not been analysed yet. Start an analysis first.',
          });
        },
      }),
    });
    expect(await screen.findByText('The digital twin could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No digital twin yet' })).toBeNull();
  });

  it('shows a retryable error when the twin cannot be loaded', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'twin.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return twin();
        },
      }),
    });
    expect(await screen.findByText('The digital twin could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
  });
});

describe('[FR-CASE-03] the recorded resolution is hindsight', () => {
  it('shows it under a hindsight label, apart from everything the analysis generates', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Recorded resolution');
    expect(panel.getByText('Hindsight (not used to generate)')).toBeInTheDocument();
    expect(
      panel.getByText(/A DNS policy update on one resolver blocked a CDN host\./),
    ).toBeInTheDocument();
    expect(panel.getByText(/DNS security policy on resolver 10\.20\.1\.11/)).toBeInTheDocument();
    expect(panel.getByText(/generated without it/)).toBeInTheDocument();
  });

  it('says so when the case has no recorded resolution', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'cases.get': () =>
          caseDetail({ hasResolution: false, status: 'open', closedAt: null, resolution: null }),
      }),
    });
    const panel = await group('Recorded resolution');
    expect(
      await panel.findByText('No resolution was recorded with this case.'),
    ).toBeInTheDocument();
  });
});

describe('[FR-CASE-04] the time cursor', () => {
  const known = () =>
    timelineResponse({
      asOf: AS_OF,
      withheldFutureEventCount: 12,
      knownAtAsOf: {
        evidenceCount: 11,
        claimCount: 25,
        criticalMissingCount: 2,
        openWarningCount: 4,
      },
    });

  it('asks the twin for what was known then, and hides everything only hindsight knows', async () => {
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({
      'timeline.get': () => known(),
      'twin.get': () => twin({ asOf: AS_OF, withheldFutureEventCount: 12 }),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });

    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'twin.get',
        expect.objectContaining({ query: { asOf: AS_OF } }),
      ),
    );
    expect(handler.call).toHaveBeenCalledWith(
      'timeline.get',
      expect.objectContaining({ query: { limit: 1, asOf: AS_OF } }),
    );

    // Counts the API computed at that instant, and how many later events it withheld (counted, never shown).
    const cursor = await group('What was known');
    expect(await cursor.findByText('Later events withheld')).toBeInTheDocument();
    expect(cursor.getByText('12')).toBeInTheDocument();
    expect(cursor.getByText('Critical evidence still missing')).toBeInTheDocument();

    // Hindsight is not shown.
    const resolution = await group('Recorded resolution');
    expect(resolution.getByText(/hidden while a time cursor is set/)).toBeInTheDocument();
    expect(screen.queryByText(/DNS security policy on resolver/)).toBeNull();
    expect(screen.queryByText('Last event')).toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.queryByText('Resolved')).toBeNull();

    // Facts from the case as it stood.
    const facts = await group('Key facts');
    expect(await facts.findByText('Events known')).toBeInTheDocument();
    expect(await facts.findByText('19')).toBeInTheDocument();

    // Totals of the whole record are not shown either.
    expect(screen.getByText(/Totals for the whole record .* are hidden/)).toBeInTheDocument();
    expect(screen.queryByText('9 decision forks')).toBeNull();
  });

  it('carries the moment into the links to the other pages', async () => {
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => known(), 'twin.get': () => twin({ asOf: AS_OF }) }),
    });
    const pages = await screen.findByRole('list', { name: 'Case pages' });
    const query = `?asOf=${encodeURIComponent(AS_OF)}`;
    for (const link of within(pages).getAllByRole('link'))
      expect(link.getAttribute('href')).toMatch(new RegExp(`${query.replace('?', '\\?')}$`));
    expect(screen.getByRole('link', { name: 'Evidence Ledger at this moment' })).toHaveAttribute(
      'href',
      `/cases/case_1/evidence${query}`,
    );
  });

  it('moves the cursor back to the whole record with a single control', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => known(), 'twin.get': () => twin({ asOf: AS_OF }) }),
    });
    const cursor = await group('What was known');
    await user.click(await cursor.findByRole('button', { name: 'Latest' }));
    await waitFor(() => expect(window.location.search).not.toContain('asOf'));
  });

  it('moves an address that names no event to the last event before it, and asks for that window only', async () => {
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    const handler = api({ 'timeline.get': () => known(), 'twin.get': () => twin({ asOf: AS_OF }) });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'twin.get',
        expect.objectContaining({ query: { asOf: '2026-03-09T09:41:00Z' } }),
      ),
    );
    // The earlier view is requested once, for the event instant: never for the arbitrary one in the address.
    const asked = handler.call.mock.calls
      .filter(([id]) => id === 'twin.get' || id === 'timeline.get')
      .map(([, input]) => (input as { query?: { asOf?: string } }).query?.asOf)
      .filter((value) => value !== undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['2026-03-09T09:41:00Z']));
  });

  it('asks for earlier views without hidden retries, and for the whole record the usual way', async () => {
    const whole = api();
    const { unmount } = renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: whole });
    await screen.findByText('About 140 users cannot sign in to Teams.');
    const wholeCall = whole.call.mock.calls.find(([id]) => id === 'twin.get');
    expect((wholeCall?.[1] as { maxRetries?: number }).maxRetries).toBeUndefined();
    unmount();

    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    const earlier = api({ 'timeline.get': () => known(), 'twin.get': () => twin({ asOf: AS_OF }) });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: earlier });
    await waitFor(() =>
      expect(earlier.call).toHaveBeenCalledWith(
        'twin.get',
        expect.objectContaining({ maxRetries: 0 }),
      ),
    );
  });

  it('states the instant the API cut the evidence at, not the one that was asked for', async () => {
    const cut = '2026-03-09T09:12:00Z';
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent('2026-03-09T09:41:00Z')}`);
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': (input) =>
          (input as { query?: { asOf?: string } }).query?.asOf
            ? timelineResponse({ asOf: cut, withheldFutureEventCount: 2 })
            : timelineResponse(),
        'twin.get': () => twin({ asOf: cut }),
      }),
    });
    const cursor = await group('What was known');
    expect(
      await cursor.findByText(
        `Showing the case as of ${formatDateTimeUtc(cut)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    expect(cursor.getByLabelText(`Known as of ${formatDateTimeUtc(cut)}`)).toBeInTheDocument();
    const panel = await group('Digital twin');
    expect(
      await panel.findByText(
        `The case as structured from what was known up to ${formatDateTimeUtc(cut)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    // The requested instant is never presented as "known as of".
    expect(
      screen.queryByText(
        new RegExp(`${formatDateTimeUtc('2026-03-09T09:41:00Z')}, the last event`),
      ),
    ).toBeNull();
  });

  it('says so when no event had been recorded by the chosen moment', async () => {
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent('2026-03-09T09:41:00Z')}`);
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': (input) =>
          (input as { query?: { asOf?: string } }).query?.asOf
            ? timelineResponse({ asOf: null, events: [], total: 0, withheldFutureEventCount: 3 })
            : timelineResponse(),
        'twin.get': () => twin({ asOf: null, fields: [], participants: [], sectionCounts: {} }),
      }),
    });
    const cursor = await group('What was known');
    expect(
      await cursor.findByText('No event had been recorded by the moment you chose.'),
    ).toBeInTheDocument();
  });

  it('tells where reviewer decisions would show that later decisions are withheld, in an earlier view only', async () => {
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    const { unmount } = renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'timeline.get': () => known(), 'twin.get': () => twin({ asOf: AS_OF }) }),
    });
    const panel = await group('Digital twin');
    expect(
      await panel.findByText(
        'Reviewer decisions recorded later are not shown in this earlier view.',
      ),
    ).toBeInTheDocument();
    unmount();

    navigateTo(`/cases/${CASE_ID}`);
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await screen.findByText('About 140 users cannot sign in to Teams.');
    expect(screen.queryByText(/Reviewer decisions recorded later are not shown/)).toBeNull();
  });

  it('shows the loading state of the twin, and nothing of the whole record, while the chosen moment loads', async () => {
    const earlier = (input: unknown): boolean =>
      Boolean((input as { query?: { asOf?: string } }).query?.asOf);
    const handler = api({
      'timeline.get': (input) =>
        earlier(input) ? new Promise(() => undefined) : timelineResponse(),
      'twin.get': (input) => (earlier(input) ? new Promise(() => undefined) : twin()),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '3000' },
    });
    await waitFor(() => expect(window.location.search).toContain('asOf'));

    // The panel says which moment it is looking up, with a placeholder where the twin was.
    expect(
      await screen.findByText(`Looking up what was known at ${formatDateTimeUtc(AS_OF)}…`),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Loading the digital twin/).length).toBeGreaterThan(0);
    // Nothing of the whole record is left under the name of the chosen moment.
    expect(screen.queryByText('About 140 users cannot sign in to Teams.')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Digital twin' })).toBeNull();
    expect(screen.queryByText('Later events withheld')).toBeNull();
    expect(screen.queryByText(/No event had been recorded/)).toBeNull();
    // The cursor stays where it is, and the case itself is still there.
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
  });

  it('shows the same loading state while the cursor is still reading the events it lands on', async () => {
    const handler = api({
      'timeline.get': (input) => {
        if ((input as { query?: { cursor?: string } }).query?.cursor === 'c2')
          return new Promise(() => undefined);
        return timelineResponse({ nextCursor: 'c2', total: 4 });
      },
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '1500' },
    });
    await waitFor(() => expect(window.location.search).toContain('asOf'));
    // No earlier view can be asked for until the cursor can land on an event: the whole record is not left in its place.
    expect(await screen.findByText(/^Looking up what was known at /)).toBeInTheDocument();
    expect(screen.queryByText('About 140 users cannot sign in to Teams.')).toBeNull();
    expect(screen.getAllByText(/Loading the digital twin/).length).toBeGreaterThan(0);
    expect(
      handler.call.mock.calls.filter(
        ([id, input]) =>
          id === 'twin.get' && Boolean((input as { query?: { asOf?: string } }).query?.asOf),
      ),
    ).toHaveLength(0);
  });

  it('shows a calm notice with the Retry-After countdown when earlier views are limited, then recovers', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    let limited = true;
    const refuse = (): ApiError =>
      new ApiError({
        status: 429,
        code: 'rate_limited',
        reason: 'engine_budget',
        title: 'Too many requests',
        message: 'Too many requests',
        retryAfterMs: 2000,
      });
    const handler = api({
      'timeline.get': (input) => {
        if ((input as { query?: { asOf?: string } }).query?.asOf && limited) throw refuse();
        return known();
      },
      'twin.get': () => {
        if (limited) throw refuse();
        return twin({ asOf: AS_OF });
      },
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    const notice = (await screen.findByText('Earlier views are limited')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(notice).getByText(/Computing earlier views is limited to keep the service responsive/),
    ).toBeInTheDocument();
    const retry = within(notice).getByRole('button', { name: /Retry in \d s/ });
    expect(retry).toBeDisabled();
    // The ticking countdown is outside the live region; one static sentence is announced instead.
    expect(liveRegionOf(retry)).toBeNull();
    expect(
      screen.getByText(/^Earlier views are limited\. Try again in \d seconds?\.$/),
    ).toHaveAttribute('role', 'status');
    expect(within(notice).getByRole('button', { name: 'Show the whole record' })).toBeEnabled();
    // Not a crash or a blank page: the case, its facts and the cursor are all still there.
    expect(screen.getByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      await (
        await group('What was known')
      ).findByText(/Counts for this moment are not available right now/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('What was known at the moment you chose could not be worked out just now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Looking up what was known/)).toBeNull();

    limited = false;
    await waitFor(
      () => expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled(),
      {
        timeout: 6000,
      },
    );
    await user.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });

  it('offers the whole record, which is never limited, from the notice', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/${CASE_ID}?asOf=${encodeURIComponent(AS_OF)}`);
    const refuse = (): ApiError =>
      new ApiError({
        status: 429,
        code: 'rate_limited',
        reason: 'engine_budget',
        title: 'Too many requests',
        retryAfterMs: 30000,
      });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'timeline.get': (input) => {
          if ((input as { query?: { asOf?: string } }).query?.asOf) throw refuse();
          return timelineResponse();
        },
        'twin.get': (input) => {
          if ((input as { query?: { asOf?: string } }).query?.asOf) throw refuse();
          return twin();
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(window.location.search).not.toContain('asOf'));
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });
});

describe('[FR-CASE-05] analysis', () => {
  it('shows the latest run: provider, versions, input hash and what it produced', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Analysis');
    expect(await panel.findByText('Succeeded')).toBeInTheDocument();
    expect(panel.getByText('Deterministic provider')).toBeInTheDocument();
    expect(panel.getByText('deterministic-knowledge-pack')).toBeInTheDocument();
    expect(panel.getByText('kp.teams-authentication 1.0.0')).toBeInTheDocument();
    expect(panel.getByText('quality 1.0.0, action value 1.0.0')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Copy analysis input hash' })).toBeInTheDocument();
    const totals = panel.getByLabelText('What the analysis produced');
    expect(within(totals).getByText('Decision forks').nextElementSibling).toHaveTextContent('9');
    expect(within(totals).getByText('Warnings').nextElementSibling).toHaveTextContent('14');
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0);
  });

  it('re-runs the analysis only after a confirmation, with force', async () => {
    const user = userEvent.setup();
    const handler = api({
      'analysis.start': () => ({ job: job(), runId: null, reused: false }),
      'jobs.get': () => job(),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    const panel = await group('Analysis');
    await panel.findByRole('button', { name: 'Re-run the analysis' });
    await user.click(await enabledButton('Re-run the analysis'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/replaces the stored analysis/)).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('analysis.start', expect.anything());
    await user.click(within(dialog).getByRole('button', { name: 'Re-run' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ params: { caseId: CASE_ID }, body: { force: true } }),
      ),
    );
    // The job's real stages are shown while it runs.
    expect(await screen.findByText('Classify evidence and rank hypotheses')).toBeInTheDocument();
    expect(screen.getByText('Analysis in progress')).toBeInTheDocument();
  });

  it('tells the person when the stored analysis was reused instead of re-run', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'analysis.start': () => ({ job: finishedJob(), runId: 'run_1', reused: true }) }),
    });
    const panel = await group('Analysis');
    await panel.findByRole('button', { name: 'Re-run the analysis' });
    await user.click(await enabledButton('Re-run the analysis'));
    await user.click(
      await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Re-run' }),
    );
    expect(await screen.findByText('The stored analysis was reused')).toBeInTheDocument();
  });

  it('starts the analysis of a case that has none, without force', async () => {
    const user = userEvent.setup();
    const handler = api({
      'cases.get': () =>
        caseDetail({ analysisState: 'not_analyzed', lastAnalysisRunId: null, analyzedAt: null }),
      'analysis.latest': () => ({ run: null }),
      'twin.get': () => {
        throw notAnalysedError();
      },
      'analysis.start': () => ({ job: job(), runId: null, reused: false }),
      'jobs.get': () => job(),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    const panel = await group('Analysis');
    expect(
      await panel.findByText(/This case has not been analysed yet\. The timeline, evidence/),
    ).toBeInTheDocument();
    const start = panel.getByRole('button', { name: 'Start the analysis' });
    await waitFor(() => expect(start).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(start);
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ body: { force: false } }),
      ),
    );
    expect(await screen.findByText('Analysis in progress')).toBeInTheDocument();
  });

  it('follows the live job of a case that is already being analysed', async () => {
    const handler = api({
      'cases.get': () => caseDetail({ analysisState: 'running', analyzedAt: null }),
      'analysis.latest': () => ({ run: null }),
      'twin.get': () => {
        throw notAnalysedError();
      },
      'jobs.list': () => ({ items: [job()], nextCursor: null }),
      'jobs.get': () => job(),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('Analysis in progress')).toBeInTheDocument();
    expect(await screen.findByText('Classify evidence and rank hypotheses')).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'jobs.list',
      expect.objectContaining({
        query: expect.objectContaining({ caseId: CASE_ID, kind: 'case_analysis' }),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Start the analysis' })).toBeNull();
  });

  it('shows the failure of the last run and offers to retry it', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'cases.get': () => caseDetail({ analysisState: 'failed' }),
        'analysis.latest': () => ({
          run: analysisRun({
            status: 'failed',
            error: 'The knowledge pack could not be loaded.',
            completedAt: null,
          }),
        }),
      }),
    });
    const panel = await group('Analysis');
    expect(await panel.findByText('The last analysis failed')).toBeInTheDocument();
    expect(panel.getByText('The knowledge pack could not be loaded.')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Retry the analysis' })).toBeInTheDocument();
  });

  it('explains why a role without case:analyze cannot re-run the analysis', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'session.me': () => session('reviewer', ['case:read']) }),
    });
    const panel = await group('Analysis');
    const rerun = await panel.findByRole('button', { name: 'Re-run the analysis' });
    await waitFor(() => expect(rerun).toHaveAttribute('aria-disabled', 'true'));
  });
});

describe('[FR-CASE-06] deleting from the overview (administrator)', () => {
  it('is disabled for roles without case:delete', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Manage this case');
    const button = await panel.findByRole('button', { name: 'Delete case' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
  });

  it('deletes through the API after confirmation and returns to the list', async () => {
    const user = userEvent.setup();
    const handler = api({
      'session.me': () => session('administrator', [...ADMIN]),
      'cases.delete': () => ({ deleted: true }),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    const panel = await group('Manage this case');
    await panel.findByRole('button', { name: 'Delete case' });
    await user.click(await enabledButton('Delete case'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/permanently deletes/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete case' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'cases.delete',
        expect.objectContaining({ params: { caseId: CASE_ID } }),
      ),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cases'));
  });
});

describe('[FR-CASE-07] loading, errors and missing cases', () => {
  it('says the case cannot be found, with a way back to the list, when the API answers 404', async () => {
    renderApp(<CaseOverviewPage caseId="case_gone" />, {
      api: api({
        'cases.get': () => {
          throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
        },
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'We could not find that case' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse cases' })).toHaveAttribute('href', '/cases');
  });

  it('shows an error with Retry and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'cases.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 502,
              code: 'upstream_unavailable',
              title: 'API unavailable',
              correlationId: 'corr-ov-1',
            });
          return caseDetail();
        },
      }),
    });
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText('corr-ov-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('heading', { level: 1, name: TITLE })).toBeInTheDocument();
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('heading', { level: 1, name: TITLE });
    await screen.findByText('About 140 users cannot sign in to Teams.');
    await expectNoAxeViolations(container);
  });
});
