import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import { auditEvent, auditPage, reviewDecision } from '../../../test/u4-fixtures';
import { governanceApi as api, stubNearEndObserver } from '../../../test/u4-support';
import { ApiError } from '../../lib/api/errors';
import { GovernancePage } from './GovernancePage';

vi.setConfig({ testTimeout: 120_000 });

afterEach(() => vi.unstubAllGlobals());

const cursorOf = (input: unknown): string | undefined =>
  (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;

const failure = () =>
  new ApiError({ status: 500, code: 'internal', title: 'Internal server error' });

/** Long enough for a request that is repeated by itself to show up many times (each round takes a few ticks). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('[FR-GOV-31] a page that fails to load is not requested again by itself', () => {
  it('audit log: one failed request for the next page, and Retry makes exactly one more', async () => {
    const user = userEvent.setup();
    const scrolling = stubNearEndObserver();
    navigateTo('/governance?tab=audit');
    let failing = true;
    const fake = api({
      'governance.audit': (input) => {
        if (cursorOf(input) !== 'next-1')
          return auditPage([auditEvent({ sequence: 2 }), auditEvent({ sequence: 1 })], 'next-1');
        if (failing) throw failure();
        return auditPage([auditEvent({ sequence: 9, action: 'case.ingested' })]);
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    const nextPageCalls = () =>
      fake.call.mock.calls.filter(
        (call) => call[0] === 'governance.audit' && cursorOf(call[1]) === 'next-1',
      ).length;

    // The end of the list is in view, so the next page is asked for by itself, once.
    expect(await screen.findByText('More audit events could not be loaded')).toBeInTheDocument();
    await settle();
    expect(nextPageCalls()).toBe(1);
    // Scrolling the end of the list out of view and back does not ask again either: Retry does.
    scrolling.scrollToEnd();
    await settle();
    expect(nextPageCalls()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(nextPageCalls()).toBe(2));
    await settle();
    scrolling.scrollToEnd();
    await settle();
    expect(nextPageCalls()).toBe(2);
    expect(screen.getByText('More audit events could not be loaded')).toBeInTheDocument();

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: /Audit events, 3 shown/ })).toBeVisible();
    expect(screen.queryByText('More audit events could not be loaded')).toBeNull();
    expect(nextPageCalls()).toBe(3);
  });

  it('audit log: a failed refresh is retried as a refresh, not as a request for another page', async () => {
    const user = userEvent.setup();
    navigateTo('/governance?tab=audit');
    let calls = 0;
    const fake = api({
      'governance.audit': () => {
        calls += 1;
        if (calls === 2) throw failure();
        return auditPage([auditEvent({ sequence: 2 }), auditEvent({ sequence: 1 })]);
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    await screen.findByRole('list', { name: /Audit events, 2 shown/ });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText('The latest audit events could not be loaded'),
    ).toBeInTheDocument();
    // The events already on screen stay.
    expect(screen.getByRole('list', { name: /Audit events, 2 shown/ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText('The latest audit events could not be loaded')).toBeNull(),
    );
    expect(calls).toBe(3);
  });

  it('reviewer decisions: one failed request for the next page, and Retry makes exactly one more', async () => {
    const user = userEvent.setup();
    const scrolling = stubNearEndObserver();
    navigateTo('/governance?tab=reviews');
    const fake = api({
      'governance.reviews': (input) => {
        if (cursorOf(input) === 'next-1') throw failure();
        return { items: [reviewDecision()], nextCursor: 'next-1' };
      },
    });
    renderApp(<GovernancePage />, { api: fake });
    const nextPageCalls = () =>
      fake.call.mock.calls.filter(
        (call) => call[0] === 'governance.reviews' && cursorOf(call[1]) === 'next-1',
      ).length;

    expect(
      await screen.findByText('More reviewer decisions could not be loaded'),
    ).toBeInTheDocument();
    await settle();
    scrolling.scrollToEnd();
    await settle();
    expect(nextPageCalls()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(nextPageCalls()).toBe(2));
    await settle();
    scrolling.scrollToEnd();
    await settle();
    expect(nextPageCalls()).toBe(2);
  });

  it('still loads the next page by itself when the end of the list is in view and nothing failed', async () => {
    stubNearEndObserver();
    navigateTo('/governance?tab=audit');
    const fake = api({
      'governance.audit': (input) =>
        cursorOf(input) === 'next-1'
          ? auditPage([auditEvent({ sequence: 1, action: 'case.ingested' })])
          : auditPage([auditEvent({ sequence: 3 }), auditEvent({ sequence: 2 })], 'next-1'),
    });
    renderApp(<GovernancePage />, { api: fake });
    expect(await screen.findByRole('list', { name: /Audit events, 3 shown/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more events' })).toBeNull();
  });
});
