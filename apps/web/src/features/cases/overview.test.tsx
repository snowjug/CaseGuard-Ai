import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
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

/** A folded section opens with the button of its heading; its content is only mounted from then on. */
async function openSection(user: UserEvent, name: RegExp) {
  await user.click(await screen.findByRole('button', { name }));
  return within(await screen.findByRole('region', { name }));
}

/** Opens the case's management menu and returns the item once the session has loaded: until then gated items are disabled. */
async function enabledItem(user: UserEvent, name: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Manage case' }));
  await waitFor(() =>
    expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true'),
  );
  return screen.getByRole('menuitem', { name });
}

// A busy machine can take longer than the 1 s default to render a page for the first time.
configure({ asyncUtilTimeout: 12_000 });

describe('[FR-CASE-01] Case details', () => {
  it('shows a skeleton, then the key facts first, with the case structure and its sources behind them', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    expect(screen.getAllByText(/Loading the case/).length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    // One h1, the screen's own name: the case header above every case page already says which case this is.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Case details' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();

    const facts = await group('Key facts');
    expect(facts.getByText('Demo data')).toBeInTheDocument();
    expect(facts.getByText('CG-SYN-1001')).toBeInTheDocument();
    expect(facts.getByText('Microsoft Teams')).toBeInTheDocument();
    expect(facts.getByText('teams-authentication')).toBeInTheDocument();
    expect(facts.getByText('Severity A')).toBeInTheDocument();
    expect(facts.getByText('Contoso Synthetic Ltd')).toBeInTheDocument();
    expect(facts.getByText('Resolved')).toBeInTheDocument();
    // The count ticks up to its value when it appears.
    expect(await facts.findByText('31')).toBeInTheDocument();
    expect(facts.getByRole('list', { name: 'Tags' })).toHaveTextContent('authentication');
    expect(facts.getByRole('button', { name: 'Copy case reference' })).toBeInTheDocument();
    expect(facts.getByRole('button', { name: 'Copy case ID' })).toBeInTheDocument();
    // Dates are written in words, with the exact UTC time on hover and for a screen reader.
    expect(facts.getByTitle(formatDateTimeUtc(caseDetail().openedAt))).toBeInTheDocument();
    // The case closed at its last event: both facts carry the same exact time.
    expect(facts.getAllByTitle(formatDateTimeUtc(caseDetail().closedAt))).toHaveLength(2);
    expect(facts.getByText('Last event')).toBeInTheDocument();

    // The page reads as facts first, then the structure, then the sections folded away.
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf('Key facts')).toBeLessThan(headings.indexOf('Case structure'));
    expect(headings).toContain('More about this case');
  });

  it('keeps how the case was received behind a heading, with the screening result visible before it is opened', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('group', { name: 'Key facts' });
    const trigger = await screen.findByRole('button', { name: /How it was received/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Built-in sample');
    expect(screen.queryByText('22,769 bytes')).toBeNull();

    const received = await openSection(user, /How it was received/);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(received.getByText('Built-in sample')).toBeInTheDocument();
    expect(received.getByText('case-one.json')).toBeInTheDocument();
    expect(received.getByText('22,769 bytes')).toBeInTheDocument();
    expect(received.getByText('Nothing needed redaction')).toBeInTheDocument();
    expect(received.getByText('Nothing flagged')).toBeInTheDocument();
    expect(received.getByRole('button', { name: 'Copy received hash' })).toBeInTheDocument();
  });

  it('reports redaction and a prompt-injection flag from the screening', async () => {
    const user = userEvent.setup();
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
    // The two results that need attention show on the closed heading already.
    const trigger = await screen.findByRole('button', { name: /How it was received/ });
    expect(trigger).toHaveTextContent('3 values replaced');
    expect(trigger).toHaveTextContent('Flagged');
    const received = await openSection(user, /How it was received/);
    expect(received.getByText('3 values replaced')).toBeInTheDocument();
    expect(received.getByText('Flagged')).toBeInTheDocument();
  });

  it('shows the case in numbers, each a link to the page that shows it', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const pages = await screen.findByRole('list', { name: 'Case pages' });
    const links = within(pages).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/cases/case_1/timeline',
      '/cases/case_1/evidence',
      '/cases/case_1/hypotheses',
      '/cases/case_1/counterfactual',
      '/cases/case_1/quality',
    ]);
    const [timeline, evidence, causes, whatIf, score] = links as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    // The counts tick up to their value when they appear, so each is read once it has arrived.
    await waitFor(() => expect(timeline).toHaveTextContent(/Timeline\s*31 events/));
    await waitFor(() =>
      expect(evidence).toHaveTextContent(/Evidence\s*61 claims\s*26 evidence items/),
    );
    await waitFor(() => expect(causes).toHaveTextContent(/Possible causes\s*9 possible causes/));
    await waitFor(() => expect(whatIf).toHaveTextContent(/What if\s*9 key decisions/));
    await waitFor(() => expect(score).toHaveTextContent(/Score\s*14 open warnings/));
  });

  it('makes opening the review the one primary action, with the timeline one click away', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const review = await screen.findByRole('link', { name: /Open review/ });
    expect(review).toHaveAttribute('href', '/cases/case_1/review');
    expect(screen.getAllByRole('link', { name: /Open review/ })).toHaveLength(1);
    expect(await screen.findAllByRole('link', { name: /Timeline/ })).toHaveLength(1);
  });
});

describe('[FR-CASE-02] case structure', () => {
  it('shows each field with its confidence estimate, extraction method, review status and source', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Case structure');
    expect(await panel.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    expect(panel.getByText('Confidence 90% (estimate)')).toBeInTheDocument();
    expect(panel.getByText('Rule')).toBeInTheDocument();
    expect(panel.getByText('Awaiting review')).toBeInTheDocument();
    const source = panel.getByRole('link', { name: 'Event e01' });
    expect(source).toHaveAttribute('href', '/cases/case_1/timeline?sel=e01');
    expect(panel.getByText(/2 fields in 3 sections/)).toBeInTheDocument();
    expect(panel.getByText(/Confidence values are model estimates/)).toBeInTheDocument();
  });

  it('opens the problem and its impact first and folds the other sections away, with their counts', async () => {
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Case structure');
    await panel.findByText('About 140 users cannot sign in to Teams.');
    expect(panel.getByRole('button', { name: /Problem statement/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const participants = panel.getByRole('button', { name: /Participants/ });
    expect(participants).toHaveAttribute('aria-expanded', 'false');
    expect(participants).toHaveTextContent('1');
  });

  it('opens a section on demand and lists the participants the structure knows', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Case structure');
    await user.click(await panel.findByRole('button', { name: /Participants/ }));
    const people = await panel.findByRole('list', { name: 'Participants' });
    expect(within(people).getByText('Customer IT Admin 1')).toBeInTheDocument();
    expect(within(people).getByText('6 events')).toBeInTheDocument();
  });

  it('says plainly when a section has no extracted values', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const panel = await group('Case structure');
    await user.click(await panel.findByRole('button', { name: /Remaining risks/ }));
    expect(await panel.findByText(/No values were extracted for this section/)).toBeInTheDocument();
  });

  it('explains that the case structure needs the review when the API answers 409 not_analysed', async () => {
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
    expect(
      await screen.findByRole('heading', { name: 'No case structure yet' }),
    ).toBeInTheDocument();
    // The section about the review opens by itself when there is nothing to show yet.
    expect(await screen.findByText(/This case has not been analysed yet/)).toBeInTheDocument();
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
    expect(await screen.findByText('The case structure could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No case structure yet' })).toBeNull();
  });

  it('shows a retryable error when the case structure cannot be loaded', async () => {
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
    expect(await screen.findByText('The case structure could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
  });
});

describe('[FR-CASE-03] the recorded resolution is hindsight', () => {
  it('shows it under a hindsight label, apart from everything the review generates', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    // The label and the promise are on the closed heading: it was only known later, and nothing is generated from it.
    const trigger = await screen.findByRole('button', { name: /Recorded resolution/ });
    expect(trigger).toHaveTextContent('Known only later');
    expect(trigger).toHaveTextContent('Never used to generate anything');
    expect(screen.queryByText(/A DNS policy update on one resolver/)).toBeNull();

    const panel = await openSection(user, /Recorded resolution/);
    expect(
      panel.getByText(/A DNS policy update on one resolver blocked a CDN host\./),
    ).toBeInTheDocument();
    expect(panel.getByText(/DNS security policy on resolver 10\.20\.1\.11/)).toBeInTheDocument();
    expect(panel.getByText(/generated without it/)).toBeInTheDocument();
  });

  it('says so when the case has no recorded resolution', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({
        'cases.get': () =>
          caseDetail({ hasResolution: false, status: 'open', closedAt: null, resolution: null }),
      }),
    });
    const panel = await openSection(user, /Recorded resolution/);
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

  it('asks the case structure for what was known then, and hides everything only hindsight knows', async () => {
    const user = userEvent.setup();
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

    // The folded bar opens by itself when the address names a moment: counts the API computed at that instant, and how
    // many later events it withheld (counted, never shown).
    const cursor = await group('What was known');
    expect(await cursor.findByText('Later events withheld')).toBeInTheDocument();
    expect(cursor.getByText('12')).toBeInTheDocument();
    expect(cursor.getByText('Critical evidence still missing')).toBeInTheDocument();

    // Hindsight is not shown, and the heading says why.
    const heading = await screen.findByRole('button', { name: /Recorded resolution/ });
    expect(heading).toHaveTextContent('Hidden while an earlier moment is shown');
    const resolution = await openSection(user, /Recorded resolution/);
    expect(resolution.getByText(/hidden while an earlier moment is shown/)).toBeInTheDocument();
    expect(screen.queryByText(/DNS security policy on resolver/)).toBeNull();
    expect(screen.queryByText('Last event')).toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.queryByText('Resolved')).toBeNull();

    // Facts from the case as it stood.
    const facts = await group('Key facts');
    expect(await facts.findByText('Events known')).toBeInTheDocument();
    expect(await facts.findByText('19')).toBeInTheDocument();

    // Totals of the whole record are not shown either: not in the case in numbers, and the review says so.
    expect(screen.queryByText(/key decisions/)).toBeNull();
    expect(screen.queryByText('9 decision forks')).toBeNull();
    const run = await openSection(user, /How the review was made/);
    expect(run.getByText(/Totals for the whole record .* are hidden/)).toBeInTheDocument();
    expect(run.queryByLabelText('What the review produced')).toBeNull();
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
    expect(screen.getByRole('link', { name: /Evidence.* at this moment/ })).toHaveAttribute(
      'href',
      `/cases/case_1/evidence${query}`,
    );
  });

  it('keeps the time cursor folded away for the whole record, and opens it with its heading', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    const bar = await screen.findByRole('button', { name: /What was known then/ });
    expect(bar).toHaveAttribute('aria-expanded', 'false');
    expect(bar).toHaveTextContent('Showing the whole record, up to the last event.');
    expect(screen.queryByRole('slider', { name: 'Time cursor' })).toBeNull();
    await user.click(bar);
    expect(await screen.findByRole('slider', { name: 'Time cursor' })).toBeInTheDocument();
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
    // The closed bar says the same, in one line.
    expect(screen.getByRole('button', { name: /What was known then/ })).toHaveTextContent(
      `Showing the case as of ${formatDateTimeUtc(cut)}.`,
    );
    const panel = await group('Case structure');
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
    const panel = await group('Case structure');
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

  it('shows the loading state of the case structure, and nothing of the whole record, while the chosen moment loads', async () => {
    const user = userEvent.setup();
    const earlier = (input: unknown): boolean =>
      Boolean((input as { query?: { asOf?: string } }).query?.asOf);
    const handler = api({
      'timeline.get': (input) =>
        earlier(input) ? new Promise(() => undefined) : timelineResponse(),
      'twin.get': (input) => (earlier(input) ? new Promise(() => undefined) : twin()),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /What was known then/ }));
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '3000' },
    });
    await waitFor(() => expect(window.location.search).toContain('asOf'));

    // The panel says which moment it is looking up, with a placeholder where the case structure was.
    expect(
      await screen.findByText(`Looking up what was known at ${formatDateTimeUtc(AS_OF)}…`),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Loading the case structure/).length).toBeGreaterThan(0);
    // Nothing of the whole record is left under the name of the chosen moment.
    expect(screen.queryByText('About 140 users cannot sign in to Teams.')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Case structure' })).toBeNull();
    expect(screen.queryByText('Later events withheld')).toBeNull();
    expect(screen.queryByText(/No event had been recorded/)).toBeNull();
    // The cursor stays where it is, and the case itself is still there.
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Key facts' })).toBeInTheDocument();
  });

  it('shows the same loading state while the cursor is still reading the events it lands on', async () => {
    const user = userEvent.setup();
    const handler = api({
      'timeline.get': (input) => {
        if ((input as { query?: { cursor?: string } }).query?.cursor === 'c2')
          return new Promise(() => undefined);
        return timelineResponse({ nextCursor: 'c2', total: 4 });
      },
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('About 140 users cannot sign in to Teams.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /What was known then/ }));
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '1500' },
    });
    await waitFor(() => expect(window.location.search).toContain('asOf'));
    // No earlier view can be asked for until the cursor can land on an event: the whole record is not left in its place.
    expect(await screen.findByText(/^Looking up what was known at /)).toBeInTheDocument();
    expect(screen.queryByText('About 140 users cannot sign in to Teams.')).toBeNull();
    expect(screen.getAllByText(/Loading the case structure/).length).toBeGreaterThan(0);
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
    expect(screen.getByRole('heading', { level: 1, name: 'Case details' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Key facts' })).toBeInTheDocument();
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

describe('[FR-CASE-05] the review', () => {
  it('shows the latest run: provider, versions, input hash and what it produced', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    // Closed, the heading already says how it ended, with what, and that it is simulated.
    const trigger = await screen.findByRole('button', { name: /How the review was made/ });
    expect(trigger).toHaveTextContent('Succeeded · Deterministic provider');
    expect(trigger).toHaveTextContent('Simulated');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    const panel = await openSection(user, /How the review was made/);
    expect(await panel.findByText('Succeeded')).toBeInTheDocument();
    expect(panel.getByText('Deterministic provider')).toBeInTheDocument();
    expect(panel.getByText('deterministic-knowledge-pack')).toBeInTheDocument();
    expect(panel.getByText('kp.teams-authentication 1.0.0')).toBeInTheDocument();
    expect(panel.getByText('quality 1.0.0, action value 1.0.0')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Copy review input hash' })).toBeInTheDocument();
    const totals = panel.getByLabelText('What the review produced');
    expect(within(totals).getByText('Key decisions').nextElementSibling).toHaveTextContent('9');
    expect(within(totals).getByText('Warnings').nextElementSibling).toHaveTextContent('14');
  });

  it('re-runs the review only after a confirmation, with force', async () => {
    const user = userEvent.setup();
    const handler = api({
      'analysis.start': () => ({ job: job(), runId: null, reused: false }),
      'jobs.get': () => job(),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledItem(user, 'Re-run the review'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Re-run the review?' });
    expect(within(dialog).getByText(/replaces the stored review/)).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('analysis.start', expect.anything());
    await user.click(within(dialog).getByRole('button', { name: 'Re-run' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ params: { caseId: CASE_ID }, body: { force: true } }),
      ),
    );
    // The job's real stages are shown while it runs, at the top of the page where it cannot be missed.
    expect(await screen.findByText('Classify evidence and rank hypotheses')).toBeInTheDocument();
    expect(screen.getByText('Review in progress')).toBeInTheDocument();
  });

  it('tells the person when the stored review was reused instead of re-run', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'analysis.start': () => ({ job: finishedJob(), runId: 'run_1', reused: true }) }),
    });
    await user.click(await enabledItem(user, 'Re-run the review'));
    await user.click(
      await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Re-run' }),
    );
    expect(await screen.findByText('The stored review was reused')).toBeInTheDocument();
  });

  it('runs the review of a case that has none, without force', async () => {
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
    // With nothing to show yet, the section about the review opens by itself and says why.
    expect(
      await screen.findByText(/This case has not been analysed yet\. The timeline, evidence/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run the review' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Run the review' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ body: { force: false } }),
      ),
    );
    expect(await screen.findByText('Review in progress')).toBeInTheDocument();
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
    expect(await screen.findByText('Review in progress')).toBeInTheDocument();
    expect(await screen.findByText('Classify evidence and rank hypotheses')).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'jobs.list',
      expect.objectContaining({
        query: expect.objectContaining({ caseId: CASE_ID, kind: 'case_analysis' }),
      }),
    );
    // Nothing else may be started while a review runs.
    expect(screen.queryByRole('button', { name: 'Run the review' })).toBeNull();
    expect(
      await screen.findByText(/The review is running\. The case structure appears here/),
    ).toBeInTheDocument();
  });

  it('shows the failure of the last run and offers to retry it', async () => {
    const user = userEvent.setup();
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
    // The section opens by itself when the last review did not succeed.
    expect(await screen.findByText('The last review failed')).toBeInTheDocument();
    expect(screen.getByText('The knowledge pack could not be loaded.')).toBeInTheDocument();
    expect(await enabledItem(user, 'Retry the review')).toBeInTheDocument();
  });

  it('explains why a role without case:analyze cannot run the review again', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, {
      api: api({ 'session.me': () => session('reviewer', ['case:read']) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Manage case' }));
    const rerun = await screen.findByRole('menuitem', { name: 'Re-run the review' });
    await waitFor(() => expect(rerun).toHaveAttribute('aria-disabled', 'true'));
    await user.hover(rerun);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "case:analyze" permission/,
    );
    // A disabled item does nothing: no dialog opens.
    await user.click(rerun);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('[FR-CASE-06] managing the case (administrator)', () => {
  it('keeps refresh, the review and delete in one menu, away from the facts', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await user.click(await screen.findByRole('button', { name: 'Manage case' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Refresh', 'Re-run the review', 'Delete case']);
    expect(screen.queryByRole('button', { name: 'Delete case' })).toBeNull();
  });

  it('refreshes the case, its review and its structure again', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('group', { name: 'Key facts' });
    const reads = (route: string) => handler.call.mock.calls.filter(([id]) => id === route).length;
    const before = { detail: reads('cases.get'), twin: reads('twin.get') };
    await user.click(await screen.findByRole('button', { name: 'Manage case' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Refresh' }));
    await waitFor(() => expect(reads('cases.get')).toBeGreaterThan(before.detail));
    await waitFor(() => expect(reads('twin.get')).toBeGreaterThan(before.twin));
  });

  it('is disabled, with the reason, for roles without case:delete', async () => {
    const user = userEvent.setup();
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await user.click(await screen.findByRole('button', { name: 'Manage case' }));
    const remove = await screen.findByRole('menuitem', { name: 'Delete case' });
    await waitFor(() => expect(remove).toHaveAttribute('aria-disabled', 'true'));
    await user.hover(remove);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "case:delete" permission/,
    );
  });

  it('deletes through the API after confirmation and returns to the list', async () => {
    const user = userEvent.setup();
    const handler = api({
      'session.me': () => session('administrator', [...ADMIN]),
      'cases.delete': () => ({ deleted: true }),
    });
    renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledItem(user, 'Delete case'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/permanently deletes/)).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('cases.delete', expect.anything());
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
    // The page's own heading and its one action are there even while the case cannot be read.
    expect(screen.getByRole('heading', { level: 1, name: 'Case details' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('group', { name: 'Key facts' })).toBeInTheDocument();
  });

  it('has no accessibility violations when loaded, or with the management menu open', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<CaseOverviewPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('group', { name: 'Key facts' });
    await screen.findByText('About 140 users cannot sign in to Teams.');
    await expectNoAxeViolations(container);
    await user.click(await screen.findByRole('button', { name: 'Manage case' }));
    await screen.findByRole('menu');
    await expectNoAxeViolations(document.body);
  });
});
