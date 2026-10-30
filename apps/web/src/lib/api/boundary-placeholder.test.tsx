import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { session } from '../../../test/fixtures';
import { fakeApi, renderApp } from '../../../test/harness';
import { useAuth } from '../auth/context';
import { keepWithinBoundary, sameBoundary } from './boundary-placeholder';
import { useApiQuery } from './hooks';
import { queryKeys } from './query-keys';

configure({ asyncUtilTimeout: 5000 });

const key = (caseId: string, query?: Record<string, unknown>) =>
  queryKeys.request('persona_engineer', 'hypotheses.list', { params: { caseId }, query });

describe('sameBoundary', () => {
  it('is true for the same case and the same moment, whatever else the request filters', () => {
    expect(sameBoundary(key('case_1'), { params: { caseId: 'case_1' } })).toBe(true);
    expect(
      sameBoundary(key('case_1', { asOf: '2026-03-09T10:00:00Z', limit: 10 }), {
        params: { caseId: 'case_1' },
        query: { asOf: '2026-03-09T10:00:00Z', limit: 50, cursor: 'c2' },
      }),
    ).toBe(true);
  });

  it('is false across a moment: the whole record, an earlier window, a later window, a fork', () => {
    const window = key('case_1', { asOf: '2026-03-09T10:00:00Z' });
    expect(sameBoundary(window, { params: { caseId: 'case_1' } })).toBe(false);
    expect(
      sameBoundary(key('case_1'), {
        params: { caseId: 'case_1' },
        query: { asOf: '2026-03-09T10:00:00Z' },
      }),
    ).toBe(false);
    expect(
      sameBoundary(window, {
        params: { caseId: 'case_1' },
        query: { asOf: '2026-03-09T11:00:00Z' },
      }),
    ).toBe(false);
    expect(
      sameBoundary(key('case_1', { forkId: 'fork_1' }), {
        params: { caseId: 'case_1' },
        query: { forkId: 'fork_2' },
      }),
    ).toBe(false);
  });

  it('is false for another case, and reads the key of an infinite query the same way', () => {
    expect(sameBoundary(key('case_1'), { params: { caseId: 'case_2' } })).toBe(false);
    expect(
      sameBoundary([...key('case_1', { asOf: '2026-03-09T10:00:00Z' }), 'pages'], {
        params: { caseId: 'case_1' },
        query: { asOf: '2026-03-09T10:00:00Z' },
      }),
    ).toBe(true);
  });
});

describe('keepWithinBoundary', () => {
  const placeholder = keepWithinBoundary<string>({
    params: { caseId: 'case_1' },
    query: { asOf: '2026-03-09T10:00:00Z' },
  });

  it('keeps the previous answer only for the same moment', () => {
    const same = { queryKey: key('case_1', { asOf: '2026-03-09T10:00:00Z', limit: 5 }) };
    const other = { queryKey: key('case_1') };
    expect(placeholder('previous', same)).toBe('previous');
    expect(placeholder('previous', other)).toBeUndefined();
    expect(placeholder('previous', undefined)).toBeUndefined();
  });
});

function Probe() {
  const auth = useAuth();
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(10);
  const request = {
    params: { caseId: 'case_1' },
    query: { ...(asOf ? { asOf } : {}), limit },
  };
  const result = useApiQuery('hypotheses.list', request, {
    enabled: auth.status === 'ready',
    placeholderData: keepWithinBoundary(request),
  });
  return (
    <div>
      <p data-testid="data">{JSON.stringify(result.data ?? null)}</p>
      <p data-testid="flags">
        {JSON.stringify({ pending: result.isPending, placeholder: result.isPlaceholderData })}
      </p>
      <button type="button" onClick={() => setAsOf('2026-03-09T10:00:00Z')}>
        early
      </button>
      <button type="button" onClick={() => setAsOf('2026-03-09T11:00:00Z')}>
        later
      </button>
      <button type="button" onClick={() => setAsOf(undefined)}>
        whole
      </button>
      <button type="button" onClick={() => setLimit(20)}>
        more rows
      </button>
    </div>
  );
}

const flags = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('flags').textContent ?? '{}') as Record<string, unknown>;

const answerFor = (input: unknown): string => {
  const query = (input as { query?: { asOf?: string; limit?: number } }).query;
  return `${query?.asOf ?? 'whole record'} / ${query?.limit}`;
};

describe('a read of a case at a moment', () => {
  it('shows no answer of another moment while the chosen one loads, and keeps its own answer when only a filter changes', async () => {
    const user = userEvent.setup();
    // Only the whole record and the first window answer; every other request hangs until the test ends.
    const api = fakeApi({
      'session.me': () => session('engineer', ['case:read']),
      'hypotheses.list': (input) => {
        const query = (input as { query?: { asOf?: string; limit?: number } }).query;
        if (query?.asOf === '2026-03-09T11:00:00Z' || query?.limit === 20) {
          return new Promise(() => undefined);
        }
        return { answer: answerFor(input) };
      },
    });
    renderApp(<Probe />, { api });

    await waitFor(() => expect(screen.getByTestId('data')).toHaveTextContent('whole record / 10'));

    // The whole record -> an earlier window that answers: its own answer, never the whole record under it.
    await user.click(screen.getByRole('button', { name: 'early' }));
    await waitFor(() =>
      expect(screen.getByTestId('data')).toHaveTextContent('2026-03-09T10:00:00Z / 10'),
    );

    // An earlier window -> a later one that is still loading: nothing of the earlier window stays on screen.
    await user.click(screen.getByRole('button', { name: 'later' }));
    await waitFor(() => expect(flags()).toMatchObject({ pending: true, placeholder: false }));
    expect(screen.getByTestId('data')).toHaveTextContent('null');

    // Back to the earlier window (cached) and then a filter change on the SAME window: its answer stays meanwhile.
    await user.click(screen.getByRole('button', { name: 'early' }));
    await waitFor(() =>
      expect(screen.getByTestId('data')).toHaveTextContent('2026-03-09T10:00:00Z / 10'),
    );
    await user.click(screen.getByRole('button', { name: 'more rows' }));
    await waitFor(() => expect(flags()).toMatchObject({ pending: false, placeholder: true }));
    expect(screen.getByTestId('data')).toHaveTextContent('2026-03-09T10:00:00Z / 10');
  });
});
