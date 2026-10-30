import { useQueryClient } from '@tanstack/react-query';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { fakeApi, renderApp, type FakeApi, type FakeHandlers } from '../../../test/harness';
import { useAuth } from '../auth/context';
import { ApiError } from './errors';
import { pagedBoundary, useApiPages } from './pages';
import { invalidateRoutes } from './query-keys';

configure({ asyncUtilTimeout: 5000 });

const summaries = ['a', 'b', 'c'].map((id) => caseSummary({ id, reference: `REF-${id}` }));

function Probe() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const pages = useApiPages(
    'cases.list',
    { query: { limit: 2, status: 'open' } },
    { enabled: auth.status === 'ready' },
  );
  const boundary = pagedBoundary(pages);
  return (
    <div>
      <p data-testid="ids">
        {pages.data?.pages.flatMap((page) => page.items.map((item) => item.id)).join(',') ?? ''}
      </p>
      <p data-testid="flags">
        {JSON.stringify({
          hasNext: pages.hasNextPage,
          fetchingNext: pages.isFetchingNextPage,
          queryError: pages.isError,
          boundaryError: boundary.isError,
          boundaryFetching: boundary.isFetching,
        })}
      </p>
      <button type="button" onClick={() => void pages.fetchNextPage()}>
        next
      </button>
      <button
        type="button"
        onClick={() => void invalidateRoutes(queryClient, auth.identityKey, ['cases.list'])}
      >
        invalidate
      </button>
    </div>
  );
}

function api(overrides: FakeHandlers = {}): FakeApi {
  return fakeApi({
    'session.me': () => session('engineer', ['case:read']),
    'cases.list': (input) =>
      (input as { query?: { cursor?: string } }).query?.cursor === 'c2'
        ? { items: [summaries[2]], nextCursor: null }
        : { items: [summaries[0], summaries[1]], nextCursor: 'c2' },
    ...overrides,
  });
}

const flags = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('flags').textContent ?? '{}') as Record<string, unknown>;

const listCalls = (handler: FakeApi): unknown[] =>
  handler.call.mock.calls.filter(([id]) => id === 'cases.list').map((call) => call[1] as unknown);

describe('useApiPages', () => {
  it('asks for the first page without a cursor, then for each next page with the cursor the API returned', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<Probe />, { api: handler });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    expect(flags()).toMatchObject({ hasNext: true });
    expect(listCalls(handler)).toEqual([
      expect.objectContaining({ query: { limit: 2, status: 'open' } }),
    ]);

    await user.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c'));
    expect(flags()).toMatchObject({ hasNext: false });
    expect(listCalls(handler)[1]).toEqual(
      expect.objectContaining({ query: { limit: 2, status: 'open', cursor: 'c2' } }),
    );
  });

  it('keeps the pages on screen, with no page-level error, when the next page fails', async () => {
    const user = userEvent.setup();
    renderApp(<Probe />, {
      api: api({
        'cases.list': (input) => {
          if ((input as { query?: { cursor?: string } }).query?.cursor)
            throw new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
          return { items: [summaries[0], summaries[1]], nextCursor: 'c2' };
        },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    await user.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() => expect(flags()).toMatchObject({ queryError: true }));
    expect(flags()).toMatchObject({ boundaryError: false });
    expect(screen.getByTestId('ids')).toHaveTextContent('a,b');
  });

  it('does not count loading the next page as a refresh of the list', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderApp(<Probe />, {
      api: api({
        'cases.list': async (input) => {
          if ((input as { query?: { cursor?: string } }).query?.cursor === 'c2') {
            await gate;
            return { items: [summaries[2]], nextCursor: null };
          }
          return { items: [summaries[0], summaries[1]], nextCursor: 'c2' };
        },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    await user.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() => expect(flags()).toMatchObject({ fetchingNext: true }));
    expect(flags()).toMatchObject({ boundaryFetching: false });
    release();
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c'));
  });

  it('refetches every loaded page when the route is invalidated', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderApp(<Probe />, { api: handler });
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    await user.click(screen.getByRole('button', { name: 'next' }));
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c'));
    expect(listCalls(handler)).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'invalidate' }));
    await waitFor(() => expect(listCalls(handler)).toHaveLength(4));
    expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c');
  });
});

describe('pagedBoundary', () => {
  const error = new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });
  const refetch = (): void => undefined;

  it('reports a failure only while there is nothing to show', () => {
    expect(
      pagedBoundary({
        isPending: false,
        isError: true,
        error,
        data: undefined,
        isFetching: false,
        isFetchingNextPage: false,
        refetch,
      }),
    ).toMatchObject({ isError: true, error });
    expect(
      pagedBoundary({
        isPending: false,
        isError: true,
        error,
        data: { pages: [] },
        isFetching: false,
        isFetchingNextPage: false,
        refetch,
      }),
    ).toMatchObject({ isError: false, data: { pages: [] } });
  });

  it('treats a next-page request as loading more, not as a refresh', () => {
    const base = {
      isPending: false,
      isError: false,
      error: null,
      data: { pages: [] },
      refetch,
    };
    expect(pagedBoundary({ ...base, isFetching: true, isFetchingNextPage: true }).isFetching).toBe(
      false,
    );
    expect(pagedBoundary({ ...base, isFetching: true, isFetchingNextPage: false }).isFetching).toBe(
      true,
    );
  });
});
