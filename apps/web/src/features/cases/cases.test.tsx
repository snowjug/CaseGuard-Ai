import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo, setNavigationLatency } from '../../../test/next-navigation';
import { installMatchMedia } from '../../../test/media';
import { ApiError } from '../../lib/api/errors';
import { CasesPage } from './CasesPage';
import { sortCodec } from './case-filters';
import { explainDeleteError } from './DeleteCaseButton';

const ENGINEER = ['case:read', 'case:ingest', 'case:analyze'] as const;
const ADMIN = [...ENGINEER, 'case:delete'] as const;

// A busy machine can take longer than the 1 s default to render a page for the first time.
configure({ asyncUtilTimeout: 5000 });

const one = caseSummary({
  id: 'case_1',
  reference: 'CG-SYN-1001',
  title: 'Intermittent Teams sign-in failures for about 140 branch users',
  qualityIndex: 36,
  avoidableEffortPct: 57.3,
  openedAt: '2026-03-09T09:12:00Z',
  leadingHypothesis: { name: 'DNS resolution failure', confidence: 0.93 },
  openWarningCount: 2,
});
const two = caseSummary({
  id: 'case_2',
  reference: 'CG-SYN-1002',
  title: 'Intermittent Teams sign-in failures at the Rotterdam site',
  qualityIndex: 99,
  avoidableEffortPct: 0,
  openedAt: '2026-04-14T08:00:00Z',
  leadingHypothesis: { name: 'Egress proxy node failure', confidence: 0.93 },
  openWarningCount: 0,
  eventCount: 15,
});

function api(overrides: FakeHandlers = {}) {
  return fakeApi({
    'session.me': () => session('engineer', [...ENGINEER]),
    'cases.list': () => ({ items: [two, one], nextCursor: null }),
    ...overrides,
  });
}

describe('[FR-CASES-01] Cases list', () => {
  it('shows a skeleton, then every case with its quality, effort, hypothesis and warnings', async () => {
    renderApp(<CasesPage />, { api: api() });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Loading cases/).length).toBeGreaterThan(0);

    const table = await screen.findByRole('table', { name: 'Cases' });
    const rows = within(table).getAllByRole('row');
    // Header plus two cases, newest opened first (the server's order).
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1] as HTMLElement).getByRole('link', { name: 'CG-SYN-1002' }),
    ).toHaveAttribute('href', '/cases/case_2');
    const first = rows[2] as HTMLElement;
    expect(within(first).getByRole('link', { name: 'CG-SYN-1001' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    expect(within(first).getByText('36')).toBeInTheDocument();
    expect(within(first).getByText('57%')).toBeInTheDocument();
    expect(within(first).getByText('DNS resolution failure')).toBeInTheDocument();
    expect(within(first).getByText(/93% confidence \(estimate\)/)).toBeInTheDocument();
    expect(within(first).getByText('Demo data')).toBeInTheDocument();
    expect(within(first).getByText('Analysed')).toBeInTheDocument();
    // Honest labelling of the estimates.
    expect(screen.getByText(/are estimates from the analysis of each case/)).toBeInTheDocument();
    expect(
      within(table).getByRole('columnheader', { name: /Quality \(est\.\)/ }),
    ).toBeInTheDocument();
  });

  it('never invents a number: a case that is not analysed shows "Not available"', async () => {
    const pending = caseSummary({
      id: 'case_3',
      reference: 'CG-DRAFT-1',
      analysisState: 'not_analyzed',
      qualityIndex: null,
      avoidableEffortPct: null,
      leadingHypothesis: null,
    });
    renderApp(<CasesPage />, {
      api: api({ 'cases.list': () => ({ items: [pending], nextCursor: null }) }),
    });
    const row = (await screen.findAllByRole('row'))[1] as HTMLElement;
    expect(within(row).getAllByText('Not available')).toHaveLength(3);
    expect(within(row).getByText('Not analysed')).toBeInTheDocument();
  });

  it('shows the empty state with "Ingest a case" and "Use a sample" when there are no cases', async () => {
    const { container } = renderApp(<CasesPage />, {
      api: api({ 'cases.list': () => ({ items: [], nextCursor: null }) }),
    });
    expect(await screen.findByRole('heading', { name: 'No cases yet' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'Ingest a case' })[0]).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    const ingest = screen.getAllByRole('link', { name: 'Ingest a case' });
    expect(ingest.some((link) => link.getAttribute('href') === '/cases/new')).toBe(true);
    expect(screen.getByRole('link', { name: 'Use a sample' })).toHaveAttribute(
      'href',
      '/cases/new?source=sample',
    );
    await expectNoAxeViolations(container);
  });

  it('explains who can ingest when the role cannot', async () => {
    renderApp(<CasesPage />, {
      api: api({
        'session.me': () => session('reviewer', ['case:read']),
        'cases.list': () => ({ items: [], nextCursor: null }),
      }),
    });
    expect(
      await screen.findByText(/Someone with the Engineer or Administrator role can ingest one/),
    ).toBeInTheDocument();
    await waitFor(() => {
      const [button] = screen.getAllByRole('link', { name: 'Ingest a case' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
    });
  });

  it('shows an error with Retry and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const flaky = api({
      'cases.list': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 502,
            code: 'upstream_unavailable',
            title: 'API unavailable',
            correlationId: 'corr-9',
          });
        return { items: [one], nextCursor: null };
      },
    });
    const { container } = renderApp(<CasesPage />, { api: flaky });
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText('corr-9')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('link', { name: 'CG-SYN-1001' })).toBeInTheDocument();
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = renderApp(<CasesPage />, { api: api() });
    await screen.findByRole('table', { name: 'Cases' });
    await expectNoAxeViolations(container);
  });
});

describe('[FR-CASES-02] filters, sort and pagination live in the URL', () => {
  it('sends the filters to the API and keeps them in the URL', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    await screen.findByRole('table', { name: 'Cases' });

    await user.selectOptions(screen.getByLabelText('Analysis state'), 'analyzed');
    await user.selectOptions(screen.getByLabelText('Case status'), 'resolved');
    await waitFor(() => expect(window.location.search).toContain('state=analyzed'));
    expect(window.location.search).toContain('status=resolved');
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'cases.list',
        expect.objectContaining({
          query: expect.objectContaining({
            analysisState: 'analyzed',
            status: 'resolved',
            limit: 25,
          }),
        }),
      ),
    );
  });

  it('restores the filters from the address (deep link) and offers to clear them', async () => {
    const user = userEvent.setup();
    navigateTo('/cases?state=failed&q=proxy&workload=teams-authentication');
    const handler = api({ 'cases.list': () => ({ items: [], nextCursor: null }) });
    renderApp(<CasesPage />, { api: handler });
    expect(
      await screen.findByRole('heading', { name: 'No cases match these filters' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Analysis state')).toHaveValue('failed');
    expect(screen.getByRole('searchbox')).toHaveValue('proxy');
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'cases.list',
        expect.objectContaining({
          query: expect.objectContaining({
            analysisState: 'failed',
            q: 'proxy',
            workload: 'teams-authentication',
          }),
        }),
      ),
    );
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('ignores hostile filter values in the address', async () => {
    navigateTo('/cases?state=%3Cscript%3E&status=bogus&sort=evil.asc&data=nope');
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    await screen.findByRole('table', { name: 'Cases' });
    expect(handler.call).toHaveBeenCalledWith(
      'cases.list',
      expect.objectContaining({ query: { limit: 25 } }),
    );
  });

  it('applies the synthetic label filter to the loaded cases', async () => {
    const user = userEvent.setup();
    const real = caseSummary({ id: 'case_4', reference: 'REAL-4', synthetic: false });
    renderApp(<CasesPage />, {
      api: api({ 'cases.list': () => ({ items: [real, one], nextCursor: null }) }),
    });
    await screen.findByRole('link', { name: 'REAL-4' });
    await user.selectOptions(screen.getByLabelText('Data label'), 'synthetic');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'REAL-4' })).toBeNull());
    expect(screen.getByRole('link', { name: 'CG-SYN-1001' })).toBeInTheDocument();
    expect(window.location.search).toContain('data=synthetic');
  });

  it('sorts the loaded cases and keeps the sort in the URL; missing values sort last', async () => {
    const user = userEvent.setup();
    const unscored = caseSummary({ id: 'case_5', reference: 'CG-NOQ', qualityIndex: null });
    renderApp(<CasesPage />, {
      api: api({ 'cases.list': () => ({ items: [two, unscored, one], nextCursor: null }) }),
    });
    await screen.findByRole('table', { name: 'Cases' });
    await user.selectOptions(screen.getByLabelText('Sort by'), 'quality.asc');
    await waitFor(() => expect(window.location.search).toContain('sort=quality.asc'));
    const order = within(screen.getByRole('table', { name: 'Cases' }))
      .getAllByRole('link', { name: /^CG-/ })
      .filter((link) => link.getAttribute('href')?.startsWith('/cases/case'))
      .map((link) => link.textContent);
    expect(order.slice(0, 3)).toEqual(['CG-SYN-1001', 'CG-SYN-1002', 'CG-NOQ']);
  });

  it('still sorts by the number of events, which now sits under the opened date', async () => {
    const user = userEvent.setup();
    const few = caseSummary({ id: 'case_6', reference: 'CG-FEW', eventCount: 3 });
    const many = caseSummary({ id: 'case_7', reference: 'CG-MANY', eventCount: 90 });
    renderApp(<CasesPage />, {
      api: api({ 'cases.list': () => ({ items: [few, many, two], nextCursor: null }) }),
    });
    const table = await screen.findByRole('table', { name: 'Cases' });
    expect(within(table).getByText('90 events')).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Events' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Sort by'), 'events.desc');
    await waitFor(() => expect(window.location.search).toContain('sort=events.desc'));
    const order = within(screen.getByRole('table', { name: 'Cases' }))
      .getAllByRole('link', { name: /^CG-/ })
      .filter((link) => link.getAttribute('href')?.startsWith('/cases/case'))
      .map((link) => link.textContent);
    expect(order).toEqual(['CG-MANY', 'CG-SYN-1002', 'CG-FEW']);
  });

  it('shows cards instead of a table on narrower screens', async () => {
    installMatchMedia((query) => query.includes('max-width: 1279px'));
    renderApp(<CasesPage />, { api: api() });
    const list = await screen.findByRole('list', { name: 'Cases' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByRole('link', { name: 'Open case' })).toHaveLength(2);
    expect(within(list).getAllByText('Quality (estimated)')).toHaveLength(2);
    expect(within(list).getByText(/15 events/)).toBeInTheDocument();
  });

  it('loads the next page with the cursor the API returned', async () => {
    const user = userEvent.setup();
    const handler = api({
      'cases.list': (input) => {
        const query = (input as { query?: { cursor?: string } }).query;
        return query?.cursor === 'cur_2'
          ? { items: [one], nextCursor: null }
          : { items: [two], nextCursor: 'cur_2' };
      },
    });
    renderApp(<CasesPage />, { api: handler });
    await screen.findByRole('link', { name: 'CG-SYN-1002' });
    expect(screen.queryByRole('link', { name: 'CG-SYN-1001' })).toBeNull();
    expect(screen.getByText(/More are available/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more cases' }));
    expect(await screen.findByRole('link', { name: 'CG-SYN-1001' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CG-SYN-1002' })).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'cases.list',
      expect.objectContaining({ query: expect.objectContaining({ cursor: 'cur_2' }) }),
    );
    expect(screen.queryByRole('button', { name: 'Load more cases' })).toBeNull();
  });

  it('keeps the loaded cases and reports the problem when a later page fails', async () => {
    const user = userEvent.setup();
    const handler = api({
      'cases.list': (input) => {
        if ((input as { query?: { cursor?: string } }).query?.cursor)
          throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
        return { items: [two], nextCursor: 'cur_2' };
      },
    });
    renderApp(<CasesPage />, { api: handler });
    await screen.findByRole('link', { name: 'CG-SYN-1002' });
    await user.click(screen.getByRole('button', { name: 'Load more cases' }));
    expect(await screen.findByText('More cases could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CG-SYN-1002' })).toBeInTheDocument();
  });

  it('sort codec round-trips and falls back to newest first', () => {
    expect(sortCodec.parse('quality.asc')).toEqual({ columnId: 'quality', direction: 'ascending' });
    expect(sortCodec.serialize({ columnId: 'quality', direction: 'ascending' })).toBe(
      'quality.asc',
    );
    expect(sortCodec.parse('nope.up')).toEqual({ columnId: 'opened', direction: 'descending' });
    expect(sortCodec.serialize({ columnId: 'opened', direction: 'descending' })).toBeNull();
  });
});

describe('[FR-CASES-02] typing in the search box', () => {
  /** The search text of each list request, in order (undefined: no search). */
  const searchesOf = (handler: ReturnType<typeof api>): (string | undefined)[] =>
    handler.call.mock.calls
      .filter((call) => call[0] === 'cases.list')
      .map((call) => (call[1] as { query?: { limit?: number; q?: string } }).query)
      .filter((query) => query?.limit === 25)
      .map((query) => query?.q);
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps every character typed with no pause, however late the address is reported back', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    const box = await screen.findByRole('searchbox');
    await user.click(box);
    for (const [index, char] of [...'xyz'].entries()) {
      await user.keyboard(char);
      expect(box).toHaveValue('xyz'.slice(0, index + 1));
    }
    await waitFor(() => expect(window.location.search).toBe('?q=xyz'));
    await waitFor(() => expect(searchesOf(handler)).toEqual([undefined, 'xyz']));
    await pause(60);
    expect(box).toHaveValue('xyz');
    expect(window.location.search).toBe('?q=xyz');
  });

  it('empties the box and the address with Clear filters, also before the typing was written', async () => {
    setNavigationLatency(5);
    const user = userEvent.setup({ delay: null });
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    const box = await screen.findByRole('searchbox');
    await user.type(box, 'proxy');
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
    expect(box).toHaveValue('');
    await waitFor(() => expect(window.location.search).toBe(''));
    await pause(400);
    expect(box).toHaveValue('');
    expect(window.location.search).toBe('');
    expect(searchesOf(handler)).toEqual([undefined]);
  });

  it('keeps the search box on screen while a search that found nothing is cleared and the full list is on its way', async () => {
    navigateTo('/cases?q=zzz');
    const user = userEvent.setup({ delay: null });
    const handler = api({
      'cases.list': (input) => {
        const query = (input as { query?: { limit?: number; q?: string } }).query;
        if (query?.limit !== 25) return { items: [two, one], nextCursor: null };
        // The unfiltered list never arrives: the answer of the search that found nothing stays on screen.
        return query.q === undefined
          ? new Promise<never>(() => undefined)
          : { items: [], nextCursor: null };
      },
    });
    renderApp(<CasesPage />, { api: handler });
    expect(
      await screen.findByRole('heading', { name: 'No cases match these filters' }),
    ).toBeInTheDocument();
    const box = screen.getByRole('searchbox');
    await user.clear(box);
    expect(box).toHaveValue('');
    expect(screen.getByRole('searchbox')).toBe(box);
    await waitFor(() => expect(searchesOf(handler)).toEqual(['zzz', undefined]));
    await pause(100);
    expect(screen.getByRole('searchbox')).toBe(box);
    expect(screen.queryByRole('heading', { name: 'No cases yet' })).toBeNull();
    await user.type(box, 'abc');
    expect(box).toHaveValue('abc');
  });

  it('follows the address when it changes for another reason, such as a link or Back', async () => {
    navigateTo('/cases?q=proxy');
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    const box = await screen.findByRole('searchbox');
    expect(box).toHaveValue('proxy');
    act(() => navigateTo('/cases?q=dns'));
    expect(box).toHaveValue('dns');
    await waitFor(() => expect(searchesOf(handler)).toEqual(['proxy', 'dns']));
  });

  it('neither searches nor changes the address for the partial text of an IME composition', async () => {
    const handler = api();
    renderApp(<CasesPage />, { api: handler });
    const box = await screen.findByRole('searchbox');
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: 'ni' } });
    expect(box).toHaveValue('ni');
    await pause(500);
    expect(window.location.search).toBe('');
    expect(searchesOf(handler)).toEqual([undefined]);
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.compositionEnd(box);
    await waitFor(() => expect(searchesOf(handler)).toEqual([undefined, '你好']));
    expect(new URLSearchParams(window.location.search).get('q')).toBe('你好');
  });
});

describe('[FR-CASES-03] deleting a case (administrator)', () => {
  it('disables delete with an explanation for roles without case:delete', async () => {
    renderApp(<CasesPage />, { api: api() });
    const button = await screen.findByRole('button', { name: 'Delete CG-SYN-1001' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
  });

  it('asks for confirmation, deletes through the API and reloads the list', async () => {
    const user = userEvent.setup();
    let items = [two, one];
    const handler = api({
      'session.me': () => session('administrator', [...ADMIN]),
      'cases.list': () => ({ items, nextCursor: null }),
      'cases.delete': () => {
        items = [two];
        return { deleted: true };
      },
    });
    renderApp(<CasesPage />, { api: handler });
    const button = await screen.findByRole('button', { name: 'Delete CG-SYN-1001' });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/permanently deletes/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete case' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'cases.delete',
        expect.objectContaining({ params: { caseId: 'case_1' } }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('link', { name: 'CG-SYN-1001' })).toBeNull());
    expect(screen.getByRole('link', { name: 'CG-SYN-1002' })).toBeInTheDocument();
  });

  it('explains the refusal while a job still runs (reason job_active) inside the dialog and keeps the case', async () => {
    const user = userEvent.setup();
    const handler = api({
      'session.me': () => session('administrator', [...ADMIN]),
      'cases.delete': () => {
        // The explanation comes from the reason token, not from the API's wording.
        throw new ApiError({
          status: 409,
          code: 'conflict',
          reason: 'job_active',
          title: 'Conflict',
          message: 'Refused.',
        });
      },
    });
    renderApp(<CasesPage />, { api: handler });
    const button = await screen.findByRole('button', { name: 'Delete CG-SYN-1001' });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete case' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/still queued or running, so it cannot be deleted yet/);
    expect(alert).toHaveTextContent(/Cancel the job from the case page, or wait/);
    // The dialog is open, so the page behind it is hidden from assistive technology: look at it as it is.
    expect(screen.getByRole('link', { name: 'CG-SYN-1001', hidden: true })).toBeInTheDocument();
  });

  it('shows any other refusal with the API’s own message', async () => {
    const user = userEvent.setup();
    const handler = api({
      'session.me': () => session('administrator', [...ADMIN]),
      'cases.delete': () => {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          title: 'Conflict',
          message: 'A job for this case is still queued or running. Cancel it or wait.',
        });
      },
    });
    renderApp(<CasesPage />, { api: handler });
    const button = await screen.findByRole('button', { name: 'Delete CG-SYN-1001' });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete case' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'A job for this case is still queued or running. Cancel it or wait.',
    );
    expect(alert).not.toHaveTextContent(/cannot be deleted yet/);
  });
});

describe('explainDeleteError', () => {
  it('picks the explanation by the reason token and otherwise says what the API said', () => {
    const refused = (reason?: string): ApiError =>
      new ApiError({ status: 409, code: 'conflict', reason, title: 'Conflict', message: 'No.' });
    expect(explainDeleteError(refused('job_active'))).toMatch(/still queued or running/);
    expect(explainDeleteError(refused('another_reason'))).toBe('No.');
    expect(explainDeleteError(refused())).toBe('No.');
    // The token belongs to the 409: the same token on another status is not a running job.
    expect(
      explainDeleteError(
        new ApiError({
          status: 422,
          code: 'validation_failed',
          reason: 'job_active',
          title: 'T',
          message: 'Bad.',
        }),
      ),
    ).toBe('Bad.');
    expect(explainDeleteError(new Error('Boom'))).toBe('Boom');
  });
});
