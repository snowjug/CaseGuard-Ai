import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/errors';
import { notAnalysedError, timelineEvent, timelineResponse } from '../../../test/case-fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { liveRegionOf, watchChanges } from '../../../test/live-region';
import { navigateTo } from '../../../test/next-navigation';
import {
  AS_OF_STALE_MS,
  AsOfLimited,
  ENGINE_BUDGET_REASON,
  LaterDecisionsNote,
  asOfCall,
  asOfFresh,
  isRateLimited,
  snapToEvent,
  useAsOfCursor,
} from './as-of';

configure({ asyncUtilTimeout: 5000 });

const INSTANTS = ['2026-03-09T09:12:00Z', '2026-03-09T09:41:00Z', '2026-03-10T08:55:00Z'];

describe('snapToEvent', () => {
  it('lands on the last event at or before the instant', () => {
    expect(snapToEvent('2026-03-09T10:00:00Z', INSTANTS)).toBe('2026-03-09T09:41:00Z');
    expect(snapToEvent('2026-03-10T08:54:59Z', INSTANTS)).toBe('2026-03-09T09:41:00Z');
    expect(snapToEvent('2026-03-12T00:00:00Z', INSTANTS)).toBe('2026-03-10T08:55:00Z');
  });

  it('keeps an instant that is an event, whatever its notation', () => {
    expect(snapToEvent('2026-03-09T09:41:00Z', INSTANTS)).toBe('2026-03-09T09:41:00Z');
    // A cursor writes milliseconds; the event's own notation is what is sent to the API.
    expect(snapToEvent('2026-03-09T09:41:00.000Z', INSTANTS)).toBe('2026-03-09T09:41:00Z');
  });

  it('leaves an instant before the first event as it is: there is nothing to land on', () => {
    expect(snapToEvent('2026-03-09T09:00:00Z', INSTANTS)).toBe('2026-03-09T09:00:00Z');
  });

  it('leaves anything unreadable, and any instant when no events are known, as it is', () => {
    expect(snapToEvent('not-a-date', INSTANTS)).toBe('not-a-date');
    expect(snapToEvent('2026-03-09T10:00:00Z', [])).toBe('2026-03-09T10:00:00Z');
  });

  it('works on a long list', () => {
    const many = Array.from({ length: 5000 }, (_, index) =>
      new Date(Date.parse('2026-01-01T00:00:00Z') + index * 3_600_000).toISOString(),
    );
    expect(snapToEvent('2026-01-02T05:30:00Z', many)).toBe('2026-01-02T05:00:00.000Z');
    expect(snapToEvent('2026-01-01T00:00:00Z', many)).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('request helpers', () => {
  it('asks for earlier views without hidden retries and keeps their windows fresh', () => {
    expect(asOfCall('2026-03-09T09:41:00Z')).toEqual({ maxRetries: 0 });
    expect(asOfFresh('2026-03-09T09:41:00Z')).toEqual({
      staleTime: AS_OF_STALE_MS,
      gcTime: AS_OF_STALE_MS,
    });
    expect(asOfCall(null)).toEqual({});
    expect(asOfFresh(null)).toEqual({});
  });

  it('recognises the refusal of a metered view by its status and its engine_budget reason', () => {
    const refusal = (reason?: string): ApiError =>
      new ApiError({ status: 429, code: 'rate_limited', reason, title: 'Too many' });
    expect(isRateLimited(refusal('engine_budget'))).toBe(true);
    expect(ENGINE_BUDGET_REASON).toBe('engine_budget');
    // The API's general rate limit names no reason: it gets the same calm countdown and Retry.
    expect(isRateLimited(refusal())).toBe(true);
    // Another reason is some other condition: the page's ordinary error state explains it.
    expect(isRateLimited(refusal('something_else'))).toBe(false);
    // The reason belongs to a 429 only.
    expect(
      isRateLimited(
        new ApiError({ status: 409, code: 'conflict', reason: 'engine_budget', title: 'Conflict' }),
      ),
    ).toBe(false);
    expect(isRateLimited(new ApiError({ status: 500, code: 'internal', title: 'Oops' }))).toBe(
      false,
    );
    expect(isRateLimited(new Error('429'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

function Probe() {
  const cursor = useAsOfCursor('case_1');
  return (
    <div>
      <p data-testid="state">
        {JSON.stringify({
          asOf: cursor.asOf,
          ready: cursor.ready,
          instants: cursor.instants?.length ?? null,
          failed: cursor.instantsFailed,
        })}
      </p>
      <button type="button" onClick={() => cursor.setAsOf('2026-03-10T00:00:00Z')}>
        set
      </button>
      <button type="button" onClick={() => cursor.setAsOf(null)}>
        clear
      </button>
      <button type="button" onClick={cursor.retryInstants}>
        retry
      </button>
    </div>
  );
}

const state = (): {
  asOf: string | null;
  ready: boolean;
  instants: number | null;
  failed: boolean;
} =>
  JSON.parse(screen.getByTestId('state').textContent ?? '{}') as {
    asOf: string | null;
    ready: boolean;
    instants: number | null;
    failed: boolean;
  };

const events = (instants: readonly string[]) =>
  instants.map((timestamp, index) =>
    timelineEvent({ id: `e${index}`, sequence: index, timestamp }),
  );

describe('useAsOfCursor', () => {
  it('is ready at once for the whole record, and reads the event instants of the case', async () => {
    const api = fakeApi({
      'timeline.get': () => timelineResponse({ events: events(INSTANTS), total: 3 }),
    });
    renderApp(<Probe />, { api });
    expect(state()).toMatchObject({ asOf: null, ready: true });
    await waitFor(() => expect(state().instants).toBe(3));
  });

  it('waits for the instants before an address with an arbitrary instant may be requested, then lands on an event', async () => {
    navigateTo(`/cases/case_1?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    const api = fakeApi({
      'timeline.get': () => timelineResponse({ events: events(INSTANTS), total: 3 }),
    });
    renderApp(<Probe />, { api });
    expect(state()).toMatchObject({ ready: false });
    await waitFor(() => expect(state()).toMatchObject({ ready: true, instants: 3 }));
    expect(state().asOf).toBe('2026-03-09T09:41:00Z');
    // The address is left as it was shared; only what is requested is snapped.
    expect(window.location.search).toContain(encodeURIComponent('2026-03-10T00:00:00Z'));
  });

  it('writes the event instant to the address when the cursor moves, and clears it with null', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'timeline.get': () => timelineResponse({ events: events(INSTANTS), total: 3 }),
    });
    renderApp(<Probe />, { api });
    await waitFor(() => expect(state().instants).toBe(3));
    await user.click(screen.getByRole('button', { name: 'set' }));
    expect(new URLSearchParams(window.location.search).get('asOf')).toBe('2026-03-09T09:41:00Z');
    expect(state().asOf).toBe('2026-03-09T09:41:00Z');
    await user.click(screen.getByRole('button', { name: 'clear' }));
    expect(new URLSearchParams(window.location.search).get('asOf')).toBeNull();
  });

  it('does not wait forever when the instants cannot be read (a case that is not analysed)', async () => {
    navigateTo(`/cases/case_1?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    const api = fakeApi({
      'timeline.get': () => {
        throw notAnalysedError();
      },
    });
    renderApp(<Probe />, { api });
    await waitFor(() => expect(state().ready).toBe(true));
    expect(state()).toMatchObject({ asOf: '2026-03-10T00:00:00Z', instants: null });
  });

  it('reads every page of the timeline, in time order and without duplicates, before it snaps', async () => {
    navigateTo(`/cases/case_1?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    const handler = vi.fn((input: unknown) => {
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === 'c2'
        ? timelineResponse({
            events: events([INSTANTS[2] as string, INSTANTS[1] as string]),
            nextCursor: null,
            total: 3,
          })
        : timelineResponse({
            events: events([INSTANTS[0] as string, INSTANTS[1] as string]),
            nextCursor: 'c2',
            total: 3,
          });
    });
    const api = fakeApi({ 'timeline.get': handler });
    renderApp(<Probe />, { api });
    await waitFor(() => expect(state()).toMatchObject({ ready: true, instants: 3 }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(state().asOf).toBe('2026-03-09T09:41:00Z');
  });

  it('reads only the first page while the whole record is shown, and the rest once an earlier moment is asked for', async () => {
    const user = userEvent.setup();
    const handler = vi.fn((input: unknown) => {
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === 'c2'
        ? timelineResponse({ events: events([INSTANTS[2] as string]), nextCursor: null, total: 3 })
        : timelineResponse({
            events: events([INSTANTS[0] as string, INSTANTS[1] as string]),
            nextCursor: 'c2',
            total: 3,
          });
    });
    renderApp(<Probe />, { api: fakeApi({ 'timeline.get': handler }) });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ asOf: null, ready: true, instants: null });

    await user.click(screen.getByRole('button', { name: 'set' }));
    await waitFor(() => expect(state()).toMatchObject({ ready: true, instants: 3 }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(state().asOf).toBe('2026-03-09T09:41:00Z');
  });

  it('stops reading the timeline at a page that failed, and asks again only when told to', async () => {
    const user = userEvent.setup();
    navigateTo(`/cases/case_1?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    let failing = true;
    const handler = vi.fn((input: unknown) => {
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      if (cursor === 'c2') {
        if (failing) throw new ApiError({ status: 503, code: 'unavailable', title: 'Unavailable' });
        return timelineResponse({
          events: events([INSTANTS[2] as string]),
          nextCursor: null,
          total: 3,
        });
      }
      return timelineResponse({
        events: events([INSTANTS[0] as string, INSTANTS[1] as string]),
        nextCursor: 'c2',
        total: 3,
      });
    });
    renderApp(<Probe />, { api: fakeApi({ 'timeline.get': handler }) });
    const failedPages = (): number =>
      handler.mock.calls.filter(
        ([input]) => (input as { query?: { cursor?: string } }).query?.cursor === 'c2',
      ).length;
    await waitFor(() => expect(failedPages()).toBe(1));
    // Not waiting for the instants forever, and saying so.
    await waitFor(() =>
      expect(state()).toMatchObject({ ready: true, failed: true, instants: null }),
    );
    // Nothing asks again by itself, however long it waits: the walk used to repeat the failed page for ever.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(failedPages()).toBe(1);

    failing = false;
    await user.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(state()).toMatchObject({ instants: 3, failed: false }));
    expect(failedPages()).toBe(2);
    expect(state().asOf).toBe('2026-03-09T09:41:00Z');
  });

  it('does not offer a retry for a case that is not analysed: asking again cannot help', async () => {
    navigateTo(`/cases/case_1?asOf=${encodeURIComponent('2026-03-10T00:00:00Z')}`);
    renderApp(<Probe />, {
      api: fakeApi({
        'timeline.get': () => {
          throw notAnalysedError();
        },
      }),
    });
    await waitFor(() => expect(state().ready).toBe(true));
    expect(state().failed).toBe(false);
  });
});

describe('AsOfLimited', () => {
  const limited = (retryAfterMs?: number): ApiError =>
    new ApiError({
      status: 429,
      code: 'rate_limited',
      reason: 'engine_budget',
      title: 'Too many requests',
      message: 'Too many requests',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });

  it('explains the limit calmly and counts the server’s Retry-After down in the button, outside the live region', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderApp(<AsOfLimited error={limited(2000)} subject="the timeline" onRetry={onRetry} />);
    const notice = screen.getByRole('note');
    expect(notice).toHaveTextContent('Earlier views are limited');
    expect(notice).toHaveTextContent(
      'Computing earlier views is limited to keep the service responsive, so the timeline could not be computed for this moment just now. Views you already opened stay available.',
    );
    // One static sentence is the live region; the notice and the ticking button are not part of it.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Earlier views are limited. Try again in 2 seconds.');
    expect(liveRegionOf(notice)).toBeNull();
    const retry = screen.getByRole('button', { name: /Retry in \d s/ });
    expect(retry).toBeDisabled();
    expect(liveRegionOf(retry)).toBeNull();

    // Each tick changes the button, but nothing inside the live region until the wait is over: one announcement.
    const watch = watchChanges(status);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(), {
      timeout: 5000,
    });
    expect(status).toHaveTextContent('You can retry now.');
    expect(watch.count()).toBe(1);
    watch.stop();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('can be retried at once when the server named no delay, and shows progress while retrying', () => {
    renderApp(<AsOfLimited error={limited()} subject="the timeline" onRetry={vi.fn()} retrying />);
    const retry = screen.getByRole('button', { name: 'Retrying…' });
    expect(retry).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Earlier views are limited. You can retry now.',
    );
  });

  it('offers the whole record only when the page can show it', async () => {
    const user = userEvent.setup();
    const onWholeRecord = vi.fn();
    const { unmount } = renderApp(
      <AsOfLimited
        error={limited()}
        subject="the timeline"
        onRetry={vi.fn()}
        onWholeRecord={onWholeRecord}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show the whole record' }));
    expect(onWholeRecord).toHaveBeenCalledTimes(1);
    unmount();
    renderApp(<AsOfLimited error={limited()} subject="the timeline" onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Show the whole record' })).toBeNull();
  });

  it('has no accessibility violations, in either size', async () => {
    const { container } = renderApp(
      <>
        <AsOfLimited
          error={limited(3000)}
          subject="the timeline"
          onRetry={vi.fn()}
          onWholeRecord={vi.fn()}
        />
        <AsOfLimited error={limited()} subject="this event" compact onRetry={vi.fn()} />
        <LaterDecisionsNote />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('LaterDecisionsNote', () => {
  it('says that decisions recorded later are not shown in an earlier view', () => {
    renderApp(<LaterDecisionsNote />);
    expect(
      screen.getByText('Reviewer decisions recorded later are not shown in this earlier view.'),
    ).toBeInTheDocument();
  });
});
