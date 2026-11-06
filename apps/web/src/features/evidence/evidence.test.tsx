import { formatDateTimeUtc } from '@caseguard/ui';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CASE_ID,
  caseDetail,
  claim,
  evidenceItem,
  hypothesesResponse,
  job,
  ledger,
  missingEvidence,
  notAnalysedError,
  recordFindings,
  recordFindingsWithFindings,
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
import { navigateTo, setNavigationLatency } from '../../../test/next-navigation';
import { ApiError } from '../../lib/api/errors';
import { EvidenceLedgerPage } from './EvidenceLedgerPage';
import {
  activeLedgerFilters,
  claimAsKnown,
  isCorrected,
  ledgerQuery,
  LEDGER_FILTERS,
  type LedgerFilterValues,
} from './ledger-filters';
import { sortMissing } from './MissingEvidencePanel';

const REVIEWER = ['case:read', 'evidence:review'] as const;
const ENGINEER = ['case:read', 'case:ingest', 'case:analyze'] as const;
const AS_OF = '2026-03-09T10:00:00Z';

// A busy machine can take longer than the 1 s default to render a page for the first time.
configure({ asyncUtilTimeout: 30_000 });
vi.setConfig({ testTimeout: 120_000 });

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('reviewer', [...REVIEWER]),
    'cases.get': () => caseDetail(),
    'evidence.list': () => ledger(),
    'hypotheses.list': () => hypothesesResponse(),
    'recordFindings.get': () => recordFindings(),
    'timeline.get': () => timelineResponse(),
    ...overrides,
  });
}

const param = (name: string): string | null =>
  new URLSearchParams(window.location.search).get(name);

/** The query the page sent with its most recent request for `route`. */
function lastQuery(handler: FakeApi, route = 'evidence.list'): Record<string, unknown> | undefined {
  const calls = handler.call.mock.calls.filter(([id]) => id === route);
  return (calls[calls.length - 1]?.[1] as { query?: Record<string, unknown> } | undefined)?.query;
}

const callsTo = (handler: FakeApi, route: string): number =>
  handler.call.mock.calls.filter(([id]) => id === route).length;

/** The button once the session has loaded: until then permission-gated buttons are present but disabled. */
async function enabledButton(name: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true'),
  );
  return screen.getByRole('button', { name });
}

const claimTexts = (): (string | null)[] =>
  screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'));

/** "What was known then" is a collapsed bar: open it to reach the time cursor and the counts of the moment. */
async function openKnownBar(): Promise<HTMLElement> {
  const bar = await screen.findByRole('button', { name: /^What was known then/ });
  if (bar.getAttribute('aria-expanded') !== 'true') await userEvent.setup().click(bar);
  return screen.findByRole('group', { name: 'Time cursor' });
}

/** A collapsed section of the coverage card ("What is still missing", "What the record itself shows"), opened. */
async function openSection(name: RegExp): Promise<void> {
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name });
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger);
}

/** The details drawer of a claim. */
const claimDrawer = (): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: 'Claim details' });

describe('[FR-LEDGER-01] Evidence', () => {
  it('shows a skeleton, then every claim with its category, source, flags and review state', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    expect(screen.getAllByText(/Loading the claims/).length).toBeGreaterThan(0);

    expect(await screen.findByRole('list', { name: 'Claims, 2 shown' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Evidence' })).toBeInTheDocument();
    expect(claimTexts()).toEqual([
      'Engineer assumption: Root cause is the Conditional Access policy that forces interactive MFA.',
      'Customer-reported observation: The customer reported that failures are intermittent.',
    ]);
    const [assumption] = screen.getAllByRole('article') as [HTMLElement];
    expect(within(assumption).getByText('Engineer assumption')).toBeInTheDocument();
    expect(within(assumption).getByText('Assumption stated as fact')).toBeInTheDocument();
    // Nothing has been decided on it yet: the row stays quiet about review, and the drawer says where it stands.
    expect(within(assumption).queryByText('Awaiting review')).toBeNull();
    expect(within(assumption).getByText('Support engineer')).toBeInTheDocument();
    expect(within(assumption).getByRole('link', { name: 'Event e03' })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline?sel=e03',
    );
    expect(screen.getByText('Showing 2 claims.')).toBeInTheDocument();
  });

  it('keeps the confidence, the method and the related causes of a claim in its drawer', async () => {
    const user = userEvent.setup();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await user.click(
      screen.getByRole('button', {
        name: /^Details of this claim: Root cause is the Conditional Access/,
      }),
    );
    const panel = within(await claimDrawer());
    expect(panel.getByText('Awaiting review')).toBeInTheDocument();
    expect(
      panel.getByText(
        /Confidence 80% \(a model estimate, not statistical truth\) · Rule · version 1/,
      ),
    ).toBeInTheDocument();
    // The claim's hypothesis is stored by knowledge-pack key; the page names it from the hypothesis list.
    await waitFor(() =>
      expect(panel.getByRole('list', { name: 'Related causes' })).toHaveTextContent(
        'DNS resolution failure for sign-in endpoints',
      ),
    );
  });

  it('counts the eight categories and lets one be chosen as a filter', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    const tiles = await screen.findByRole('list', { name: 'Filter by evidence category' });
    expect(within(tiles).getAllByRole('button')).toHaveLength(9);
    expect(within(tiles).getByRole('button', { name: /^All categories\s*2$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(tiles).getByRole('button', { name: /^Engineer assumption\s*1$/ }),
    ).toBeInTheDocument();
    expect(within(tiles).getByRole('button', { name: /^Confirmed fact\s*0$/ })).toBeInTheDocument();

    const customer = (): HTMLElement =>
      within(tiles).getByRole('button', { name: /^Customer-reported observation\s*1$/ });
    await user.click(customer());
    expect(param('category')).toBe('customer_reported');
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({ limit: 100, category: 'customer_reported' }),
    );
    expect(customer()).toHaveAttribute('aria-pressed', 'true');
    // Choosing it again clears the filter.
    await user.click(customer());
    await waitFor(() => expect(param('category')).toBeNull());
  });

  it('filters from a segment of the coverage bar as well as from its key', async () => {
    const user = userEvent.setup();
    const handler = api();
    const { container } = renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Filter by evidence category' });
    // The bar is the picture of the key: its segments are for the pointer, the key is for the keyboard.
    const segment = container.querySelector<HTMLElement>(
      'button[data-category="customer_reported"]',
    );
    expect(segment).not.toBeNull();
    await user.click(segment as HTMLElement);
    expect(param('category')).toBe('customer_reported');
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({ limit: 100, category: 'customer_reported' }),
    );
    // Only the categories that have claims are drawn.
    expect(container.querySelectorAll('button[data-category]')).toHaveLength(2);
    await user.click(segment as HTMLElement);
    await waitFor(() => expect(param('category')).toBeNull());
  });

  it('says how much evidence is still missing, and opens the list from there', async () => {
    const user = userEvent.setup();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    const figure = await screen.findByRole('button', { name: '1 still missing, 1 critical' });
    const section = await screen.findByRole('button', { name: /^What is still missing/ });
    expect(section).toHaveAttribute('aria-expanded', 'false');
    await user.click(figure);
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('list', { name: 'Evidence requirements' })).toBeInTheDocument();
  });

  it('says nothing is missing when every requirement was collected', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': () =>
          ledger({
            missing: [
              missingEvidence({ resolvedAt: '2026-03-10T00:00:00Z', resolvedByEventId: 'e05' }),
            ],
          }),
      }),
    });
    expect(
      await screen.findByRole('button', { name: 'Nothing still missing' }),
    ).toBeInTheDocument();
    expect(screen.getByText('0 requirements still open of 1.')).toBeInTheDocument();
  });

  it('lists the evidence the investigation needed, still-open requirements first', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    expect(await screen.findByText('1 requirement still open of 1.')).toBeInTheDocument();
    await openSection(/^What is still missing/);
    const list = await screen.findByRole('list', { name: 'Evidence requirements' });
    expect(within(list).getByText('Network path check from an affected site')).toBeInTheDocument();
    expect(within(list).getByText('Still needed')).toBeInTheDocument();
    expect(within(list).getByText('Critical')).toBeInTheDocument();
    expect(
      within(list).getByText('Suggested ask: Please run Resolve-DnsName from an affected device.'),
    ).toBeInTheDocument();
  });

  it('loads the next page with the cursor the API returned', async () => {
    const user = userEvent.setup();
    const [first, second] = ledger().items as [ReturnType<typeof claim>, ReturnType<typeof claim>];
    const handler = api({
      'evidence.list': (input) => {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        return cursor === 'cur_2'
          ? ledger({ items: [second], nextCursor: null })
          : ledger({ items: [first], nextCursor: 'cur_2' });
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 1 shown' });
    expect(screen.getByText(/Showing 1 claim so far; more load as you scroll/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more claims' }));
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(handler.call).toHaveBeenCalledWith(
      'evidence.list',
      expect.objectContaining({ query: expect.objectContaining({ cursor: 'cur_2', limit: 100 }) }),
    );
    expect(screen.queryByRole('button', { name: 'Load more claims' })).toBeNull();
  });

  it('shortens the accessible names of a claim without cutting an emoji in half', async () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])/;
    const handler = api({
      'evidence.list': () =>
        ledger({
          items: [
            claim({ id: 'clm_a', text: `${'x'.repeat(79)}😀 and a long tail of words after it` }),
            claim({ id: 'clm_b', text: `${'y'.repeat(59)}😀 and a long tail of words after it` }),
          ],
        }),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    const [first, second] = screen.getAllByRole('article') as [HTMLElement, HTMLElement];
    // The cut falls inside the emoji (units 79 and 80, and 59 and 60): the whole emoji is left out, never half of it.
    expect(first).toHaveAttribute('aria-label', `Engineer assumption: ${'x'.repeat(79)}`);
    const details = within(second).getByRole('button', {
      name: `Details of this claim: ${'y'.repeat(59)}`,
    });
    expect(lone.test(first.getAttribute('aria-label') ?? '')).toBe(false);
    expect(lone.test(details.getAttribute('aria-label') ?? '')).toBe(false);
  });

  it('has no accessibility violations when loaded, with a claim open', async () => {
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const { container } = renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    const drawer = await claimDrawer();
    await within(drawer).findByText('Original AI classification (never overwritten)');
    // The drawer is outside the page's own container: it is checked as well.
    await expectNoAxeViolations(drawer);
    await expectNoAxeViolations(container);
  }, 120_000);

  it('has no accessibility violations with the coverage card, its sections and the filters open', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await openSection(/^What is still missing/);
    await openKnownBar();
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    await screen.findByLabelText('Review state');
    await expectNoAxeViolations(container);
    await expectNoAxeViolations(document.body);
  }, 120_000);
});

describe('[FR-LEDGER-02] filters live in the URL', () => {
  /** The filters that do not fit in the row sit in a popover: open it to reach them. */
  async function openFilters(): Promise<void> {
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Filters/ }));
    await screen.findByLabelText('Review state');
  }

  it('sends every filter to the API and keeps it in the URL', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(lastQuery(handler)).toEqual({ limit: 100 });

    await openFilters();
    await user.selectOptions(screen.getByLabelText('Review state'), 'pending');
    await waitFor(() => expect(param('review')).toBe('pending'));
    const hypothesis = screen.getByLabelText('Related cause');
    await within(hypothesis).findByRole('option', {
      name: 'DNS resolution failure for sign-in endpoints',
    });
    await user.selectOptions(hypothesis, 'hyp_1');
    await waitFor(() => expect(param('hyp')).toBe('hyp_1'));
    // Escape closes the popover; the page behind it is hidden from assistive technology while it is open.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Review state')).toBeNull());
    // The button says how many of the filters inside it are on.
    expect(await screen.findByRole('button', { name: 'Filters, 2 on' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search claims' }), 'proxy');
    await waitFor(() => expect(param('q')).toBe('proxy'));
    // The search is sent once typing pauses, not on every key.
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({
        limit: 100,
        reviewState: 'pending',
        hypothesisId: 'hyp_1',
        q: 'proxy',
      }),
    );
    expect(screen.getByText(/3 filters on/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
    // The unfiltered list is already cached, so clearing shows it again without asking the API twice.
    await waitFor(() => expect(screen.queryByText(/filters on/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    await openFilters();
    expect(screen.getByLabelText('Review state')).toHaveValue('all');
  });

  it('restores filters from the address and bounds or ignores hostile values', async () => {
    navigateTo(`/cases/case_1/evidence?category=evil&review=bogus&q=${'x'.repeat(300)}`);
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await waitFor(() => expect(lastQuery(handler)).toEqual({ limit: 100, q: 'x'.repeat(200) }));
    await openFilters();
    expect(screen.getByLabelText('Review state')).toHaveValue('all');
  });

  it('explains when no claim matches and offers to clear the filters', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?review=rejected');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': () => ledger({ items: [] }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No claims match these filters' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No claims to show.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('says plainly when the analysis found no claims', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': () => ledger({ items: [], missing: [] }) }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No claims at this moment' }),
    ).toBeInTheDocument();
    expect(screen.getByText('The analysis found no claims in this case.')).toBeInTheDocument();
    expect(screen.getByText('No evidence requirements apply yet.')).toBeInTheDocument();
    await openSection(/^What is still missing/);
    expect(screen.getByText('Nothing is required at this point in the case.')).toBeInTheDocument();
  });
});

describe('[FR-LEDGER-02] typing in the search box', () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const searchBox = (): HTMLElement => screen.getByRole('searchbox', { name: 'Search claims' });

  it('keeps every character typed with no pause, however late the address is reported back', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    const box = searchBox();
    await user.click(box);
    for (const [index, char] of [...'xyz'].entries()) {
      await user.keyboard(char);
      expect(box).toHaveValue('xyz'.slice(0, index + 1));
    }
    await waitFor(() => expect(param('q')).toBe('xyz'));
    await waitFor(() => expect(lastQuery(handler)).toEqual({ limit: 100, q: 'xyz' }));
    await pause(60);
    expect(box).toHaveValue('xyz');
    expect(param('q')).toBe('xyz');
  });

  it('empties the box with Clear filters, also before the typing was written', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await user.type(searchBox(), 'proxy');
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    expect(searchBox()).toHaveValue('');
    await waitFor(() => expect(window.location.search).toBe(''));
    await pause(400);
    expect(searchBox()).toHaveValue('');
    expect(lastQuery(handler)).toEqual({ limit: 100 });
  });

  it('follows the address when it changes for another reason, such as a link or Back', async () => {
    navigateTo('/cases/case_1/evidence?q=proxy');
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(searchBox()).toHaveValue('proxy');
    act(() => navigateTo('/cases/case_1/evidence?q=dns'));
    expect(searchBox()).toHaveValue('dns');
    await waitFor(() => expect(lastQuery(handler)).toEqual({ limit: 100, q: 'dns' }));
  });

  it('neither searches nor changes the address for the partial text of an IME composition', async () => {
    const handler = api();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    const box = searchBox();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'ni' } });
    expect(box).toHaveValue('ni');
    await pause(500);
    expect(window.location.search).toBe('');
    expect(lastQuery(handler)).toEqual({ limit: 100 });
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.compositionEnd(box);
    await waitFor(() => expect(lastQuery(handler)).toEqual({ limit: 100, q: '你好' }));
    expect(param('q')).toBe('你好');
  });
});

describe('[FR-LEDGER-03] a claim in full', () => {
  it('shows its text, the original AI classification, why, its source and the evidence for and against it', async () => {
    const user = userEvent.setup();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    // Nothing is open until a claim is chosen: the detail is a drawer, not a panel that is always there.
    expect(screen.queryByRole('dialog', { name: 'Claim details' })).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: /^Details of this claim: Root cause is the Conditional Access/,
      }),
    );
    expect(param('sel')).toBe('clm_1');
    const drawer = await claimDrawer();
    const panel = within(drawer);

    const history = panel.getByRole('list', { name: 'Classification history' });
    expect(
      within(history).getByText('Original AI classification (never overwritten)'),
    ).toBeInTheDocument();
    expect(within(history).getByText('Engineer assumption')).toBeInTheDocument();
    expect(within(history).getByText(/Proposed by: rule/)).toBeInTheDocument();
    expect(within(history).getByText('statement.engineer_assumption')).toBeInTheDocument();
    expect(within(history).queryByText('Reviewer decision')).toBeNull();

    expect(
      panel.getByText('Stated as established, but the evidence for it is weak.'),
    ).toBeInTheDocument();
    expect(panel.getByText(/version 1/)).toBeInTheDocument();
    expect(
      within(panel.getByRole('group', { name: 'Quality flags' })).getByText(
        'Assumption stated as fact',
      ),
    ).toBeInTheDocument();

    // The source is one click away: the row already names the event.
    await user.click(panel.getByRole('button', { name: /^Source/ }));
    expect(panel.getByRole('link', { name: 'Open event e03 in the timeline' })).toHaveAttribute(
      'href',
      '/cases/case_1/timeline?sel=e03',
    );
    expect(panel.getByRole('button', { name: 'Copy claim ID' })).toBeInTheDocument();

    expect(panel.getByRole('heading', { name: 'Supporting evidence (1)' })).toBeInTheDocument();
    const supporting = panel.getByRole('list', { name: 'Supporting evidence' });
    expect(within(supporting).getByText('Failures are intermittent')).toBeInTheDocument();
    expect(within(supporting).getByText(/Present · moderate strength/)).toBeInTheDocument();
    expect(panel.getByRole('heading', { name: 'Contradicting evidence (1)' })).toBeInTheDocument();
    const contradicting = panel.getByRole('list', { name: 'Contradicting evidence' });
    expect(
      within(contradicting).getByText('Excluding users from the MFA policy did not help'),
    ).toBeInTheDocument();
    expect(within(contradicting).getByText(/Absent · moderate strength/)).toBeInTheDocument();
    expect(panel.getByText('2 evidence items linked to this claim.')).toBeInTheDocument();
    await waitFor(() =>
      expect(panel.getByRole('list', { name: 'Related causes' })).toHaveTextContent(
        'DNS resolution failure for sign-in endpoints',
      ),
    );

    await user.click(panel.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(param('sel')).toBeNull());
  });

  it('keeps the AI classification beside a reviewer’s correction and its reason', async () => {
    const user = userEvent.setup();
    const corrected = claim({
      category: 'diagnostic_evidence',
      aiCategory: 'engineer_assumption',
      reviewedCategory: 'diagnostic_evidence',
      reviewState: 'corrected',
      reviewReason: 'The sign-in logs show the policy blocked the request.',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: '2026-04-01T10:00:00Z',
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': () => ledger({ items: [corrected] }) }),
    });
    const row = (await screen.findAllByRole('article'))[0] as HTMLElement;
    expect(row).toHaveAttribute('aria-label', expect.stringMatching(/^Diagnostic evidence: /));
    expect(
      within(row).getByText('Originally classified by the AI as Engineer assumption'),
    ).toBeInTheDocument();
    expect(within(row).getByText('Corrected by a reviewer')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: /^Details of this claim/ }));
    const panel = within(await claimDrawer());
    const history = panel.getByRole('list', { name: 'Classification history' });
    expect(
      within(history).getByText('Original AI classification (never overwritten)'),
    ).toBeInTheDocument();
    expect(within(history).getByText('Reviewer correction')).toBeInTheDocument();
    expect(within(history).getByText(/By user_riley_reviewer on /)).toBeInTheDocument();
    expect(
      within(history).getByText('The sign-in logs show the policy blocked the request.'),
    ).toBeInTheDocument();
  });

  it('finds a claim from a shared link on a later page', async () => {
    navigateTo('/cases/case_1/evidence?sel=clm_2');
    const [first, second] = ledger().items as [ReturnType<typeof claim>, ReturnType<typeof claim>];
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': (input) =>
          (input as { query?: { cursor?: string } }).query?.cursor === 'cur_2'
            ? ledger({ items: [second], nextCursor: null })
            : ledger({ items: [first], nextCursor: 'cur_2' }),
      }),
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Claim details' })).getByText(
          'The customer reported that failures are intermittent.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('heading', { name: 'Looking for that claim…' })).toBeNull();
  });

  it('says when the selected claim is not in this view, and clears the selection', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_zzz');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    expect(
      await screen.findByRole('heading', { name: 'That claim is not in this view' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear the selection' }));
    await waitFor(() => expect(param('sel')).toBeNull());
  });

  it('opens the claim from a shared link in a drawer, with its details', async () => {
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    const drawer = await claimDrawer();
    expect(
      await within(drawer).findByText('Original AI classification (never overwritten)'),
    ).toBeInTheDocument();
  });
});

describe('[FR-LEDGER-04] reviewing a claim', () => {
  /** An API that stores decisions, like the real one: later reads of the ledger return the reviewed claim. */
  function reviewing(overrides: FakeHandlers = {}) {
    let items = ledger().items;
    const handler = api({
      'evidence.list': () => ledger({ items }),
      'claims.review': (input) => {
        const { params, body } = input as {
          params: { claimId: string };
          body: { category: ReturnType<typeof claim>['category']; reason: string };
        };
        const current = items.find((item) => item.id === params.claimId) as ReturnType<
          typeof claim
        >;
        const updated = claim({
          ...current,
          category: body.category,
          reviewedCategory: body.category,
          reviewState: body.category === current.aiCategory ? 'confirmed' : 'corrected',
          reviewReason: body.reason,
          reviewedBy: 'user_riley_reviewer',
          reviewedAt: '2026-04-01T10:00:00Z',
          version: current.version + 1,
        });
        items = items.map((item) => (item.id === updated.id ? updated : item));
        return updated;
      },
      ...overrides,
    });
    return handler;
  }

  it('requires a reason, then records a confirmation with the version that was reviewed', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const handler = reviewing();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledButton('Confirm classification'));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /The original AI classification \(Engineer assumption\) stays on record/,
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Record the confirmation' }));
    expect(await within(dialog).findByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('claims.review', expect.anything());

    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for your decision/ }),
      'Checked the sign-in logs',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the confirmation' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'claims.review',
        expect.objectContaining({
          params: { caseId: CASE_ID, claimId: 'clm_1' },
          body: {
            category: 'engineer_assumption',
            reason: 'Checked the sign-in logs',
            expectedVersion: 1,
          },
        }),
      ),
    );
    expect(await screen.findByText('Classification confirmed')).toBeInTheDocument();
    await waitFor(() => {
      const panel = within(screen.getByRole('dialog', { name: 'Claim details' }));
      const history = panel.getByRole('list', { name: 'Classification history' });
      expect(within(history).getByText('Reviewer decision')).toBeInTheDocument();
      expect(within(history).getByText('Checked the sign-in logs')).toBeInTheDocument();
    });
    // The drawer is a modal: the list behind it is out of the accessibility tree, so look past that.
    const row = screen.getAllByRole('article', { hidden: true })[0] as HTMLElement;
    expect(within(row).getByText('Confirmed by a reviewer')).toBeInTheDocument();
  });

  it('corrects the classification, keeping the original AI proposal visible in the list and the panel', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const handler = reviewing();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await enabledButton('Confirm classification');
    await user.selectOptions(screen.getByLabelText('Classification'), 'diagnostic_evidence');
    await user.click(await enabledButton('Correct classification'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Change the classification from Engineer assumption to Diagnostic evidence.',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for your decision/ }),
      'The logs show the policy blocked it',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the correction' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'claims.review',
        expect.objectContaining({
          body: {
            category: 'diagnostic_evidence',
            reason: 'The logs show the policy blocked it',
            expectedVersion: 1,
          },
        }),
      ),
    );
    expect(await screen.findByText('Classification corrected')).toBeInTheDocument();
    const row = (await screen.findAllByRole('article', { hidden: true }))[0] as HTMLElement;
    await waitFor(() =>
      expect(screen.getAllByRole('article', { hidden: true })[0]).toHaveAttribute(
        'aria-label',
        expect.stringMatching(/^Diagnostic evidence: /),
      ),
    );
    expect(
      within(row).getByText('Originally classified by the AI as Engineer assumption'),
    ).toBeInTheDocument();
    await waitFor(() => {
      const panel = within(screen.getByRole('dialog', { name: 'Claim details' }));
      const history = panel.getByRole('list', { name: 'Classification history' });
      expect(
        within(history).getByText('Original AI classification (never overwritten)'),
      ).toBeInTheDocument();
      expect(within(history).getByText('Reviewer correction')).toBeInTheDocument();
    });
    // The category counts follow the decision.
    await waitFor(() =>
      expect(
        handler.call.mock.calls.filter(([id]) => id === 'evidence.list').length,
      ).toBeGreaterThan(1),
    );
  });

  it('reports a concurrent change as a conflict and reloads the ledger instead of overwriting it', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const handler = api({
      'claims.review': () => {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          title: 'Conflict',
          message: 'Version mismatch.',
        });
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledButton('Confirm classification'));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for your decision/ }),
      'Looks right to me',
    );
    const before = callsTo(handler, 'evidence.list');
    await user.click(within(dialog).getByRole('button', { name: 'Record the confirmation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /Someone else changed this claim while you were reviewing it/,
    );
    await waitFor(() => expect(callsTo(handler, 'evidence.list')).toBeGreaterThan(before));
  });

  it('shows the API refusal inside the dialog and keeps the claim as it was', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const handler = api({
      'claims.review': () => {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          title: 'Validation failed',
          message: 'The reason is too short.',
        });
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledButton('Confirm classification'));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for your decision/ }),
      'Fine by me',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the confirmation' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    // The modal dialog hides the page behind it from assistive technology, so look past that.
    expect(screen.getAllByRole('article', { hidden: true })[0]).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^Engineer assumption: /),
    );
  });

  it('does not let a role without evidence:review decide', async () => {
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'session.me': () => session('engineer', [...ENGINEER]) }),
    });
    const button = await screen.findByRole('button', { name: 'Confirm classification' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
  });
});

describe('[FR-LEDGER-05] the time cursor', () => {
  // An instant between two events: the cursor lands on the last event before it.
  const SNAPPED = '2026-03-09T09:41:00Z';
  const decided = (reviewedAt: string) =>
    claim({
      category: 'diagnostic_evidence',
      aiCategory: 'engineer_assumption',
      reviewedCategory: 'diagnostic_evidence',
      reviewState: 'corrected',
      reviewReason: 'Decided after the selected moment.',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt,
    });
  const later = () => decided('2026-04-01T10:00:00Z');
  const asOfOf = (input: unknown): string | undefined =>
    (input as { query?: { asOf?: string } }).query?.asOf;
  const refuse = (retryAfterMs = 2000): ApiError =>
    new ApiError({
      status: 429,
      code: 'rate_limited',
      reason: 'engine_budget',
      title: 'Too many requests',
      message: 'Too many requests',
      retryAfterMs,
    });

  it('asks for the ledger as it stood, and never shows a decision made after that moment', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({
      'evidence.list': () =>
        ledger({ asOf: SNAPPED, items: [later()], missing: [missingEvidence()] }),
      'timeline.get': () =>
        timelineResponse({
          asOf: SNAPPED,
          withheldFutureEventCount: 7,
          knownAtAsOf: {
            evidenceCount: 5,
            claimCount: 9,
            criticalMissingCount: 1,
            openWarningCount: 2,
          },
        }),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 1 shown' });
    // The address names an instant between two events: the window asked for is the last event before it.
    expect(lastQuery(handler)).toEqual({ limit: 100, asOf: SNAPPED });
    expect(lastQuery(handler, 'hypotheses.list')).toEqual({ asOf: SNAPPED });
    expect(lastQuery(handler, 'timeline.get')).toEqual({ limit: 1, asOf: SNAPPED });

    // Even if a response carried a later decision, the page shows the claim as it was known: AI classification, no review.
    const row = screen.getAllByRole('article')[0] as HTMLElement;
    expect(row).toHaveAttribute('aria-label', expect.stringMatching(/^Engineer assumption: /));
    expect(within(row).queryByText('Corrected by a reviewer')).toBeNull();

    // The bar says which moment is shown, and its counts are one click away.
    expect(
      await screen.findByText(
        `Showing the case as of ${formatDateTimeUtc(SNAPPED)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    await openKnownBar();
    const cursor = within(
      await screen.findByLabelText(`Known as of ${formatDateTimeUtc(SNAPPED)}`),
    );
    expect(cursor.getByText('Later events withheld')).toBeInTheDocument();
    expect(cursor.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('1 requirement still open of 1 at this moment.')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: /^Details of this claim/ }));
    const panel = within(await claimDrawer());
    const history = panel.getByRole('list', { name: 'Classification history' });
    expect(within(history).queryByText('Reviewer correction')).toBeNull();
    expect(screen.queryByText('Decided after the selected moment.')).toBeNull();
    expect(
      panel.getByText(
        /A decision you record now applies to the whole record\. Earlier views, like this one/,
      ),
    ).toBeInTheDocument();
  });

  it('says where decisions normally appear that later ones are withheld, in an earlier view only', async () => {
    navigateTo(`/cases/case_1/evidence?sel=clm_1&asOf=${encodeURIComponent(SNAPPED)}`);
    const { unmount } = renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': () => ledger({ asOf: SNAPPED }) }),
    });
    await screen.findByRole('list', { name: 'Claims, 2 shown', hidden: true });
    // Once above the list of claims, and once in the classification history of the open claim.
    expect(
      await screen.findAllByText(
        'Reviewer decisions recorded later are not shown in this earlier view.',
      ),
    ).toHaveLength(2);
    const history = within(await claimDrawer());
    expect(
      history.getByText('Reviewer decisions recorded later are not shown in this earlier view.'),
    ).toBeInTheDocument();
    unmount();

    navigateTo('/cases/case_1/evidence?sel=clm_1');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    await screen.findByRole('list', { name: 'Claims, 2 shown', hidden: true });
    expect(screen.queryByText(/Reviewer decisions recorded later are not shown/)).toBeNull();
  });

  it('keeps a decision that was made by the chosen moment', async () => {
    navigateTo('/cases/case_1/evidence?asOf=2026-03-10T08:55:00Z');
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': () => ledger({ items: [decided('2026-03-10T08:00:00Z')] }) }),
    });
    const row = (await screen.findAllByRole('article'))[0] as HTMLElement;
    expect(row).toHaveAttribute('aria-label', expect.stringMatching(/^Diagnostic evidence: /));
    expect(within(row).getByText('Corrected by a reviewer')).toBeInTheDocument();
  });

  it('returns to the whole record from the empty state', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': (input) =>
          asOfOf(input) ? ledger({ asOf: SNAPPED, items: [], missing: [] }) : ledger(),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'No claims at this moment' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing had been classified by the selected moment/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(param('asOf')).toBeNull());
  });

  it('goes back to the latest from the bar, without opening it', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(AS_OF)}`);
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'evidence.list': (input) => ledger({ asOf: asOfOf(input) ?? null }) }),
    });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(screen.getByText('Earlier view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to latest' }));
    await waitFor(() => expect(param('asOf')).toBeNull());
    await waitFor(() => expect(screen.queryByText('Earlier view')).toBeNull());
  });

  it('lands the cursor on an event and sends one request when the drag stops', async () => {
    const handler = api({
      'evidence.list': (input) => ledger({ asOf: asOfOf(input) ?? null }),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await openKnownBar();
    const slider = await screen.findByRole('slider', { name: 'Time cursor' });
    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.change(slider, { target: { value: '1500' } });
    fireEvent.change(slider, { target: { value: '3000' } });
    await waitFor(() => expect(param('asOf')).toBe('2026-03-10T08:55:00Z'));
    await waitFor(() =>
      expect(lastQuery(handler)).toEqual({ limit: 100, asOf: '2026-03-10T08:55:00Z' }),
    );
    const asked = handler.call.mock.calls
      .filter(([id]) => id === 'evidence.list')
      .map(([, input]) => asOfOf(input))
      .filter((value) => value !== undefined);
    expect(asked).toEqual(['2026-03-10T08:55:00Z']);
  });

  it('shows the instant the API cut the evidence at, not the one asked for', async () => {
    const cut = '2026-03-09T09:12:00Z';
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(SNAPPED)}`);
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': (input) => (asOfOf(input) ? ledger({ asOf: cut }) : ledger()),
        'timeline.get': (input) =>
          asOfOf(input)
            ? timelineResponse({ asOf: cut, withheldFutureEventCount: 4 })
            : timelineResponse(),
      }),
    });
    expect(
      await screen.findByText(
        `Showing the case as of ${formatDateTimeUtc(cut)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    await openKnownBar();
    expect(
      await screen.findByLabelText(`Known as of ${formatDateTimeUtc(cut)}`),
    ).toBeInTheDocument();
  });

  it('shows its loading state, and nothing of the whole record, while the chosen moment loads', async () => {
    const handler = api({
      'evidence.list': (input) => (asOfOf(input) ? new Promise(() => undefined) : ledger()),
      'timeline.get': (input) =>
        asOfOf(input) ? new Promise(() => undefined) : timelineResponse(),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(screen.getByRole('list', { name: 'Filter by evidence category' })).toBeInTheDocument();
    await openKnownBar();
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '3000' },
    });
    await waitFor(() => expect(param('asOf')).toBe('2026-03-10T08:55:00Z'));

    expect(
      await screen.findByText(
        `Looking up what was known at ${formatDateTimeUtc('2026-03-10T08:55:00Z')}…`,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Loading the claims/).length).toBeGreaterThan(0);
    // Nothing of the whole record is left: no claims, categories or counts, and no claim that nothing had been recorded.
    expect(screen.queryByRole('list', { name: /^Claims, \d+ shown$/ })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Filter by evidence category' })).toBeNull();
    expect(screen.queryByText(/Showing \d+ claims?/)).toBeNull();
    expect(screen.queryByText('Later events withheld')).toBeNull();
    expect(screen.queryByText(/No event had been recorded/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No claims at this moment' })).toBeNull();
    expect(screen.queryByText(/Reviewer decisions recorded later are not shown/)).toBeNull();
    // The cursor stays where it is (a keyboard user is in the middle of it), and the busy region says so.
    expect(screen.getByRole('group', { name: 'Time cursor' })).toBeInTheDocument();
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
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    await openKnownBar();
    fireEvent.change(await screen.findByRole('slider', { name: 'Time cursor' }), {
      target: { value: '1500' },
    });
    await waitFor(() => expect(param('asOf')).not.toBeNull());
    // The rest of the case's events never arrives, so no earlier view can be asked for yet: the whole record that was on
    // screen is not left there under the cursor, dimmed or not.
    expect(await screen.findByText(/^Looking up what was known at /)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /^Claims, \d+ shown$/ })).toBeNull();
    expect(screen.getAllByText(/Loading the claims/).length).toBeGreaterThan(0);
    expect(callsTo(handler, 'evidence.list')).toBe(1);
  });

  it('does not say that the open claim is missing while the moment that would show it loads', async () => {
    navigateTo('/cases/case_1/evidence?sel=clm_1');
    const handler = api({
      'evidence.list': (input) => (asOfOf(input) ? new Promise(() => undefined) : ledger()),
      'timeline.get': (input) =>
        asOfOf(input) ? new Promise(() => undefined) : timelineResponse(),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    const drawer = await claimDrawer();
    await within(drawer).findByText('Original AI classification (never overwritten)');
    // The address changes to an earlier moment (a link, Back): the claim is looked up again for that moment.
    act(() => navigateTo('/cases/case_1/evidence?sel=clm_1&asOf=2026-03-10T08:55:00Z'));
    expect(await screen.findByText('Loading the claim…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'That claim is not in this view' })).toBeNull();
    expect(
      within(screen.getByRole('dialog', { name: 'Claim details' })).queryByText(
        'Original AI classification (never overwritten)',
      ),
    ).toBeNull();
    expect(param('sel')).toBe('clm_1');
  });

  it('keeps an earlier window as it was when a decision is recorded there, and says it is not shown', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?sel=clm_1&asOf=${encodeURIComponent(SNAPPED)}`);
    let version = 1;
    // The window as the API serves it: the classification and the explanation of that moment.
    const earlier = () =>
      claim({ version, explanation: 'As it was understood then.', confidence: 0.55 });
    // The stored claim of the whole record after the decision: it differs in fields an earlier window never takes from it.
    const stored = () =>
      claim({
        version,
        category: 'diagnostic_evidence',
        aiCategory: 'diagnostic_evidence',
        reviewedCategory: 'diagnostic_evidence',
        reviewState: 'corrected',
        reviewReason: 'Because the logs prove it.',
        reviewedBy: 'user_riley_reviewer',
        reviewedAt: '2026-04-01T10:00:00Z',
        explanation: 'The whole record explains it differently.',
        confidence: 0.93,
      });
    const handler = api({
      'evidence.list': (input) =>
        asOfOf(input)
          ? ledger({ asOf: SNAPPED, items: [earlier()] })
          : ledger({ items: [stored()] }),
      'timeline.get': (input) => timelineResponse({ asOf: asOfOf(input) ? SNAPPED : null }),
      'claims.review': () => {
        version += 1;
        return stored();
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    await user.click(await enabledButton('Confirm classification'));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for your decision/ }),
      'Checked the sign-in logs',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record the confirmation' }));
    expect(await screen.findByText('Decision recorded')).toBeInTheDocument();

    // The window is asked again (the claim has a new version) and shows what it showed before, not the stored claim.
    const panel = within(await claimDrawer());
    expect(await panel.findByText('Your decision was recorded')).toBeInTheDocument();
    expect(panel.getByText(/never shows a decision recorded after its moment/)).toBeInTheDocument();
    await waitFor(() => expect(panel.getByText('As it was understood then.')).toBeInTheDocument());
    expect(panel.queryByText('The whole record explains it differently.')).toBeNull();
    expect(panel.queryByText('Because the logs prove it.')).toBeNull();
    const history = within(panel.getByRole('list', { name: 'Classification history' }));
    expect(history.queryByText(/^Reviewer (correction|decision)$/)).toBeNull();
    expect(history.getByText('Original AI classification (never overwritten)')).toBeInTheDocument();
    expect(screen.getAllByRole('article', { hidden: true })[0]).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^Engineer assumption: /),
    );

    // The decision applies to the whole record, one click away.
    await user.click(panel.getByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(param('asOf')).toBeNull());
    expect(await screen.findByText('Because the logs prove it.')).toBeInTheDocument();
    expect(screen.getAllByRole('article', { hidden: true })[0]).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^Diagnostic evidence: /),
    );
  });

  it('shows a calm notice with the Retry-After countdown when the earlier ledger is limited, then recovers', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(SNAPPED)}`);
    let limited = true;
    const handler = api({
      'evidence.list': (input) => {
        if (!asOfOf(input)) return ledger();
        if (limited) throw refuse();
        return ledger({ asOf: SNAPPED });
      },
      'timeline.get': (input) => {
        if (asOfOf(input) && limited) throw refuse();
        return timelineResponse({ asOf: SNAPPED });
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    const notice = (await screen.findByText('Earlier views are limited')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(notice).getByText(/the evidence could not be computed for this moment just now/),
    ).toBeInTheDocument();
    const retry = within(notice).getByRole('button', { name: /Retry in \d s/ });
    expect(retry).toBeDisabled();
    // The ticking countdown is outside the live region; one static sentence is announced instead.
    expect(liveRegionOf(retry)).toBeNull();
    expect(
      screen.getByText(/^Earlier views are limited\. Try again in \d seconds?\.$/),
    ).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Evidence' })).toBeInTheDocument();
    await openKnownBar();
    expect(handler.call).toHaveBeenCalledWith(
      'evidence.list',
      expect.objectContaining({ maxRetries: 0 }),
    );

    limited = false;
    await waitFor(
      () => expect(within(notice).getByRole('button', { name: 'Retry' })).toBeEnabled(),
      {
        timeout: 6000,
      },
    );
    await user.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Claims, 2 shown' })).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  });

  it('offers the whole record from the notice, and says so when only the counts are limited', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(SNAPPED)}`);
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': (input) => ledger({ asOf: asOfOf(input) ? SNAPPED : null }),
        'timeline.get': (input) => {
          if (asOfOf(input)) throw refuse(30000);
          return timelineResponse();
        },
      }),
    });
    // The ledger itself loaded; only the counts of the moment are refused.
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    const notice = (await screen.findByText('Earlier views are limited')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(notice).getByText(/what was known could not be computed for this moment just now/),
    ).toBeInTheDocument();
    await openKnownBar();
    expect(
      await screen.findByText(/Counts for this moment are not available right now/),
    ).toBeInTheDocument();
    await user.click(within(notice).getByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(param('asOf')).toBeNull());
  });

  it('reports a refused hypothesis lookup in the page without taking the ledger down', async () => {
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(SNAPPED)}`);
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': (input) => ledger({ asOf: asOfOf(input) ? SNAPPED : null }),
        'timeline.get': () => timelineResponse({ asOf: SNAPPED }),
        'hypotheses.list': (input) => {
          if (asOfOf(input)) throw refuse();
          return hypothesesResponse();
        },
      }),
    });
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    const notice = (await screen.findByText('Earlier views are limited')).closest(
      '[role="note"]',
    ) as HTMLElement;
    expect(
      within(notice).getByText(
        /the names of the possible causes could not be computed for this moment just now/,
      ),
    ).toBeInTheDocument();
  });
});

describe('[FR-LEDGER-06] a case that is not analysed, loading and errors', () => {
  it('explains that the ledger needs the analysis and lets an engineer start it', async () => {
    const user = userEvent.setup();
    const handler = api({
      'session.me': () => session('engineer', [...ENGINEER]),
      'cases.get': () =>
        caseDetail({ analysisState: 'not_analyzed', lastAnalysisRunId: null, analyzedAt: null }),
      'evidence.list': () => {
        throw notAnalysedError();
      },
      'analysis.start': () => ({ job: job(), runId: null, reused: false }),
      'jobs.get': () => job(),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    expect(
      await screen.findByRole('heading', { name: 'This case has not been analysed yet' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The evidence is ready as soon as it has run/)).toBeInTheDocument();
    await user.click(await enabledButton('Start the analysis'));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'analysis.start',
        expect.objectContaining({ params: { caseId: CASE_ID }, body: {} }),
      ),
    );
    expect(await screen.findByText('Analysing the case')).toBeInTheDocument();
  });

  it('does not take the wording of the 409 for the condition: without the not_analysed reason the ledger shows an ordinary error', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': () => {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            title: 'Conflict',
            message: 'This case has not been analysed yet. Start an analysis first.',
          });
        },
      }),
    });
    expect(await screen.findByText('The evidence could not be loaded')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'This case has not been analysed yet' }),
    ).toBeNull();
  });

  it('shows an error with Retry and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal',
              title: 'Internal server error',
              correlationId: 'corr-ev-1',
            });
          return ledger();
        },
      }),
    });
    expect(await screen.findByText('The evidence could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('corr-ev-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('list', { name: 'Claims, 2 shown' })).toBeInTheDocument();
  });

  it('says the case cannot be found, with a way back, and never waits for it, when it does not exist', async () => {
    const missing = (): never => {
      throw new ApiError({ status: 404, code: 'not_found', title: 'Not found' });
    };
    renderApp(<EvidenceLedgerPage caseId="case_gone" />, {
      api: api({ 'cases.get': missing, 'evidence.list': missing }),
    });
    expect(
      await screen.findByRole('heading', { name: 'We could not find that case' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse cases' })).toHaveAttribute('href', '/cases');
    expect(screen.queryByText(/Loading what was known/)).toBeNull();
    expect(screen.queryByText('The evidence could not be loaded')).toBeNull();
    // Nothing is left busy: a screen reader would otherwise announce a page that is loading for ever.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe('[FR-LEDGER-07] a page that failed is not requested again in a loop', () => {
  /** Two claims in two pages; the second page fails until `recover()`. */
  function failingSecondPage() {
    const [first, second] = ledger().items as [ReturnType<typeof claim>, ReturnType<typeof claim>];
    let failing = true;
    let secondPage = 0;
    const handler = api({
      'evidence.list': (input) => {
        const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
        if (cursor !== 'cur_2') return ledger({ items: [first], nextCursor: 'cur_2' });
        secondPage += 1;
        if (failing)
          throw new ApiError({
            status: 503,
            code: 'unavailable',
            title: 'Unavailable',
            message: 'The service is unavailable.',
          });
        return ledger({ items: [second], nextCursor: null });
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

  it('looking for a claim from a shared link, asks for the page that failed once, and again only for each press of Retry', async () => {
    const user = userEvent.setup();
    navigateTo('/cases/case_1/evidence?sel=clm_2');
    const { handler, requests, recover } = failingSecondPage();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('The evidence could not be loaded')).toBeInTheDocument();
    // The search for the claim used to ask again for ever: every failure made it ask again.
    await settle();
    expect(requests()).toBe(1);
    // It no longer says it is looking.
    expect(screen.queryByRole('heading', { name: 'Looking for that claim…' })).toBeNull();
    // The drawer is a modal, so it carries its own Retry: the one on the page is behind it.
    const retry = async (): Promise<void> =>
      user.click(within(await claimDrawer()).getByRole('button', { name: /Retry/ }));
    expect(
      within(await claimDrawer()).getByText(
        /may be on a page of the ledger that could not be loaded/,
      ),
    ).toBeInTheDocument();

    await retry();
    await waitFor(() => expect(requests()).toBe(2));
    await settle();
    expect(requests()).toBe(2);

    recover();
    await retry();
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Claim details' })).getByText(
          'The customer reported that failures are intermittent.',
        ),
      ).toBeInTheDocument(),
    );
    expect(requests()).toBe(3);
    await settle(200);
    expect(requests()).toBe(3);
  });

  it('while the end of the list is in view, asks for the page that failed once, and again only for each press of Retry', async () => {
    const user = userEvent.setup();
    const observer = installNearEndObserver();
    const { handler, requests, recover } = failingSecondPage();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByText('The evidence could not be loaded')).toBeInTheDocument();
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
    await screen.findByRole('list', { name: 'Claims, 2 shown' });
    expect(requests()).toBe(3);
    expect(observer.created()).toBe(1);
  });
});

describe('ledger filter helpers', () => {
  const none: LedgerFilterValues = { category: 'all', review: 'all', hyp: null, q: '' };

  it('builds the query: filters, the debounced search and the time boundary', () => {
    expect(ledgerQuery(none, '', null)).toEqual({ limit: 100 });
    expect(
      ledgerQuery(
        {
          category: 'ai_inference',
          review: 'corrected',
          hyp: 'hyp_1',
          q: 'ignored: the debounced value is sent',
        },
        'proxy',
        AS_OF,
      ),
    ).toEqual({
      limit: 100,
      asOf: AS_OF,
      category: 'ai_inference',
      reviewState: 'corrected',
      hypothesisId: 'hyp_1',
      q: 'proxy',
    });
  });

  it('counts the filters in use, ignoring a blank search', () => {
    expect(activeLedgerFilters(none)).toBe(0);
    expect(activeLedgerFilters({ ...none, q: '   ' })).toBe(0);
    expect(
      activeLedgerFilters({ category: 'confirmed_fact', review: 'pending', hyp: 'h', q: 'x' }),
    ).toBe(4);
  });

  it('accepts only known categories and review states in the URL, and bounds the search', () => {
    expect(LEDGER_FILTERS.category.parse('confirmed_fact')).toBe('confirmed_fact');
    expect(LEDGER_FILTERS.category.parse('evil')).toBe('all');
    expect(LEDGER_FILTERS.review.parse('rejected')).toBe('rejected');
    expect(LEDGER_FILTERS.review.parse('bogus')).toBe('all');
    expect(LEDGER_FILTERS.q.parse('y'.repeat(500))).toHaveLength(200);
  });

  it('shows a claim as it was known: a decision after the boundary is not carried back', () => {
    const decided = claim({
      category: 'diagnostic_evidence',
      aiCategory: 'engineer_assumption',
      reviewedCategory: 'diagnostic_evidence',
      reviewState: 'corrected',
      reviewReason: 'Because.',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: '2026-04-01T10:00:00Z',
    });
    expect(claimAsKnown(decided, null)).toBe(decided);
    expect(claimAsKnown(decided, '2026-04-02T00:00:00Z')).toBe(decided);
    const before = claimAsKnown(decided, '2026-03-31T00:00:00Z');
    expect(before).toMatchObject({
      category: 'engineer_assumption',
      reviewedCategory: null,
      reviewState: 'pending',
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    const pending = claim();
    expect(claimAsKnown(pending, '2026-03-31T00:00:00Z')).toBe(pending);
  });

  it('calls a claim corrected only when the reviewer changed its category', () => {
    expect(
      isCorrected({
        category: 'diagnostic_evidence',
        aiCategory: 'engineer_assumption',
        reviewState: 'corrected',
      }),
    ).toBe(true);
    expect(
      isCorrected({
        category: 'engineer_assumption',
        aiCategory: 'engineer_assumption',
        reviewState: 'confirmed',
      }),
    ).toBe(false);
    expect(
      isCorrected({
        category: 'engineer_assumption',
        aiCategory: 'engineer_assumption',
        reviewState: 'corrected',
      }),
    ).toBe(false);
  });

  it('lists open requirements first, most critical first, then by when they became relevant', () => {
    const items = [
      missingEvidence({
        id: 'm_done',
        resolvedAt: '2026-03-10T00:00:00Z',
        criticality: 'critical',
      }),
      missingEvidence({ id: 'm_helpful', criticality: 'helpful' }),
      missingEvidence({
        id: 'm_late',
        criticality: 'critical',
        firstRelevantAt: '2026-03-11T00:00:00Z',
      }),
      missingEvidence({
        id: 'm_early',
        criticality: 'critical',
        firstRelevantAt: '2026-03-09T00:00:00Z',
      }),
      missingEvidence({ id: 'm_important', criticality: 'important' }),
    ];
    expect(sortMissing(items).map((item) => item.id)).toEqual([
      'm_early',
      'm_late',
      'm_important',
      'm_helpful',
      'm_done',
    ]);
  });

  it('builds fixtures that satisfy the schema', () => {
    expect(evidenceItem().id).toBe('evd_1');
  });
});

describe('[FR-LEDGER-07] what the record itself shows', () => {
  it('says so when nothing disagrees and nothing was set aside', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: api() });
    const section = await screen.findByRole('heading', {
      level: 3,
      name: /^What the record itself shows/,
    });
    expect(section).toBeInTheDocument();
    expect(
      screen.getByText('Read without a model from the events of the whole record.'),
    ).toBeInTheDocument();
    // It is one collapsed row of the coverage card: its content is one click away.
    await openSection(/^What the record itself shows/);
    expect(screen.getByText(/No two statements contradict each other/)).toBeInTheDocument();
  });

  it('lists the statements that disagree with both sides quoted, and the words it read and did not count', async () => {
    const user = userEvent.setup();
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'recordFindings.get': () => recordFindingsWithFindings() }),
    });
    await openSection(/^What the record itself shows/);
    await user.click(await screen.findByRole('button', { name: /Statements that disagree \(1\)/ }));
    const conflicts = await screen.findByRole('list', { name: 'Statements that disagree' });
    expect(within(conflicts).getByText('Changed over time')).toBeInTheDocument();
    const sides = within(conflicts).getByRole('list', {
      name: 'The two statements about Number of affected users',
    });
    expect(within(sides).getByText('“60 users”')).toBeInTheDocument();
    expect(within(sides).getByText('“300 users”')).toBeInTheDocument();
    expect(
      within(conflicts).getByText('The record favours the second statement.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Patterns across events \(1\)/ }));
    const patterns = await screen.findByRole('list', { name: 'Patterns across events' });
    expect(within(patterns).getByText('A request nobody answered')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Read but not counted \(2\)/ }));
    const setAside = await screen.findByRole('list', { name: 'Sentences read but not counted' });
    expect(within(setAside).getByText('Denies it')).toBeInTheDocument();
    expect(within(setAside).getByText('A guess')).toBeInTheDocument();
    expect(within(setAside).getByText('“This is not just one user.”')).toBeInTheDocument();
    expect(within(setAside).getByText(/the words that decided it: “not”/)).toBeInTheDocument();
  });

  it('says how many were set aside in all when the list was cut', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'recordFindings.get': () => recordFindingsWithFindings({ setAsideTotal: 640 }) }),
    });
    await openSection(/^What the record itself shows/);
    expect(
      await screen.findByRole('button', { name: /Read but not counted \(2 of 640\)/ }),
    ).toBeInTheDocument();
  });

  it('asks about the selected moment only, and says so', async () => {
    navigateTo(`/cases/case_1/evidence?asOf=${encodeURIComponent(AS_OF)}`);
    const handler = api({
      'recordFindings.get': () => recordFindings({ asOf: AS_OF }),
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    expect(
      await screen.findByText('Read without a model from the events up to the selected moment.'),
    ).toBeInTheDocument();
    // Like every earlier view, it asks about the last event at or before the instant that was chosen.
    expect(lastQuery(handler, 'recordFindings.get')).toEqual({ asOf: '2026-03-09T09:41:00Z' });
  });

  it('keeps the ledger usable when it cannot be read, and offers another try', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const handler = api({
      'recordFindings.get': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 500,
            code: 'internal',
            title: 'Server error',
            message: 'The server failed.',
          });
        return recordFindingsWithFindings();
      },
    });
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, { api: handler });
    expect(await screen.findByRole('list', { name: 'Claims, 2 shown' })).toBeInTheDocument();
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await openSection(/^What the record itself shows/);
    expect(
      await screen.findByRole('button', { name: /Statements that disagree \(1\)/ }),
    ).toBeInTheDocument();
  });

  it('is not shown for a case that was never analysed, where the page says so itself', async () => {
    renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({
        'evidence.list': () => {
          throw notAnalysedError();
        },
        'recordFindings.get': () => {
          throw notAnalysedError();
        },
      }),
    });
    await screen.findByText(/not been analysed|Analyse/i);
    expect(
      screen.queryByRole('heading', { name: /What the record itself shows/ }),
    ).not.toBeInTheDocument();
  });

  it('has no accessibility violations with its three lists open', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(<EvidenceLedgerPage caseId={CASE_ID} />, {
      api: api({ 'recordFindings.get': () => recordFindingsWithFindings() }),
    });
    await openSection(/^What the record itself shows/);
    for (const name of [
      /Statements that disagree \(1\)/,
      /Patterns across events \(1\)/,
      /Read but not counted \(2\)/,
    ]) {
      await user.click(await screen.findByRole('button', { name }));
    }
    await screen.findByRole('list', { name: 'Sentences read but not counted' });
    await expectNoAxeViolations(container);
  }, 180_000);
});
