import { screen, waitFor, within, configure, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../../test/fixtures';
import {
  expectNoAxeViolations,
  fakeApi,
  renderApp,
  type FakeHandlers,
} from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import {
  BEFORE_FORK_EVENT,
  CASE_ID,
  LAST_EVENT,
  actionRanking,
  caseDetail,
  forkList,
  hypothesesResponse,
  recordedActions,
  reviewerOverride,
  timelineWindow,
  wholeTimeline,
  zeroScoreRanking,
} from '../../../test/reasoning-fixtures';
import { ApiError } from '../../lib/api/errors';
import { HypothesisArenaPage } from './HypothesisArenaPage';

// The page chains several reads (identity, case, instants, hypotheses, forks, ranking); a loaded machine needs room.
configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 90_000 });

const REVIEWER = [
  'case:read',
  'quality:review',
  'actionvalue:override',
  'counterfactual:review',
] as const;
const ENGINEER = ['case:read', 'counterfactual:run', 'skill:extract'] as const;
/** An instant between two events (09:30 and 09:41): the cursor lands on the earlier event. */
const BETWEEN_EVENTS = '2026-03-09T09:40:59Z';
/** The `asOf` of the ranking fixture, which the override is recorded against. */
const RANKING_AS_OF = '2026-03-09T09:40:59Z';
const LATER_DECISIONS = 'Reviewer decisions recorded later are not shown in this earlier view.';

const asOfOf = (input: unknown): string | null =>
  (input as { query?: { asOf?: string } }).query?.asOf ?? null;

function api(overrides: FakeHandlers = {}, role: 'reviewer' | 'engineer' = 'reviewer') {
  return fakeApi({
    'session.me': () =>
      role === 'reviewer' ? session('reviewer', REVIEWER) : session('engineer', ENGINEER),
    'cases.get': () => caseDetail(),
    'hypotheses.list': () => hypothesesResponse(),
    'forks.list': (input) =>
      asOfOf(input) ? { items: [], earliestMeaningfulForkId: null } : forkList(),
    'actions.list': () => ({ items: recordedActions() }),
    'actionValue.rank': () => actionRanking(),
    'timeline.get': (input) => {
      const asOf = asOfOf(input);
      return asOf ? timelineWindow(asOf, 29) : wholeTimeline();
    },
    ...overrides,
  });
}

const renderArena = (handler = api()) =>
  renderApp(<HypothesisArenaPage caseId={CASE_ID} />, { api: handler });

const list = () => screen.findByRole('list', { name: 'Hypotheses ranked by confidence' });
const detailOf = (name: string) => screen.getByRole('group', { name });

describe('[FR-HY-01] Hypothesis Arena', () => {
  it('shows a skeleton, then every hypothesis ranked with its estimated range and the model-estimate notice', async () => {
    renderArena();
    expect(screen.getAllByText(/Loading the confidence chart/).length).toBeGreaterThan(0);

    const rows = within(await list()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: /DNS resolution failure for sign-in endpoints/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(rows[0] as HTMLElement).getByRole('img', { name: /estimate 73%, range 55% to 84%/ }),
    ).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Ruled out')).toBeInTheDocument();
    expect(screen.getAllByText(/not statistical truth/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Model estimates').length).toBeGreaterThan(0);
    expect(await screen.findByText('Synthetic')).toBeInTheDocument();
  });

  it('draws the confidence chart with a text alternative and the actions and forks as numbered markers', async () => {
    renderArena();
    await list();
    const chart = await screen.findByRole('img', {
      name: /Model-estimated confidence in each hypothesis over time/,
    });
    expect(chart).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText(/Decision fork: Heavy customer request/).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getAllByText(/Action: Request HAR and Fiddler traces/).length).toBeGreaterThan(0);
  });

  it('opens the leading hypothesis with its evidence for and against, missing evidence, assumptions and cheapest safe action', async () => {
    renderArena();
    await list();
    const detail = detailOf('DNS resolution failure for sign-in endpoints');
    expect(
      within(detail).getByRole('heading', { name: 'Evidence that supports it (2)' }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText('Client reports a name-resolution failure'),
    ).toBeInTheDocument();
    expect(within(detail).getByText(/ERR_NAME_NOT_RESOLVED/)).toBeInTheDocument();
    const [firstLink] = within(detail).getAllByRole('link', { name: /Source event e04/ });
    expect(firstLink).toHaveAttribute('href', '/cases/case_1/timeline?sel=e04');
    expect(
      within(detail).getByRole('heading', { name: 'Evidence that contradicts it (0)' }),
    ).toBeInTheDocument();

    expect(
      within(detail).getByRole('heading', { name: 'Missing evidence (1)' }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText('Network path check (DNS or proxy) from an affected site'),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText(/Already collected: Exact client error code or text/),
    ).toBeInTheDocument();

    expect(within(detail).getByRole('heading', { name: 'Assumptions (1)' })).toBeInTheDocument();
    const action = within(detail).getByRole('region', { name: 'Cheapest safe validating action' });
    expect(
      within(action).getByText('Ask about recent identity, network or policy changes'),
    ).toBeInTheDocument();
    expect(within(action).getByText('0.24 bits')).toBeInTheDocument();
    expect(within(action).getByText('Estimated')).toBeInTheDocument();

    const changes = within(detail).getByRole('list', { name: 'Promotions and demotions' });
    expect(within(changes).getByText(/Still possible → Leading/)).toBeInTheDocument();
  });

  it('explains why a hypothesis moved and keeps contradictions visible', async () => {
    const user = userEvent.setup();
    renderArena();
    const rows = within(await list());
    await user.click(
      rows.getByRole('button', { name: /Conditional Access or MFA policy enforcement/ }),
    );
    await waitFor(() => expect(window.location.search).toBe('?sel=hyp_ca'));
    const detail = detailOf('Conditional Access or MFA policy enforcement');
    expect(
      within(detail).getByRole('heading', { name: 'Evidence that contradicts it (1)' }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByText('Policy-related log events do not coincide with the failures'),
    ).toBeInTheDocument();
    expect(within(detail).getAllByText(/Contradicts/).length).toBeGreaterThan(0);
    expect(within(detail).getByText(/Nothing more needs testing/)).toBeInTheDocument();
    expect(within(detail).getAllByText(/Ruled out/).length).toBeGreaterThan(0);
  });

  it('shares the selection through the URL, by record id or by key', async () => {
    navigateTo('/?sel=hyp.conditional-access');
    renderArena();
    await list();
    expect(detailOf('Conditional Access or MFA policy enforcement')).toBeInTheDocument();
  });

  it('can draw every hypothesis instead of the contenders, and keeps that choice in the URL', async () => {
    const user = userEvent.setup();
    const base = hypothesesResponse();
    const [first] = base.items;
    if (!first) throw new Error('fixture has hypotheses');
    const quiet = {
      ...first,
      id: 'hyp_quiet',
      key: 'hyp.quiet',
      name: 'Client cache corruption',
      currentConfidence: 0.03,
      currentLow: 0.01,
      currentHigh: 0.06,
      currentStatus: 'active' as const,
      timeline: first.timeline.map((point) => ({
        ...point,
        confidence: 0.03,
        low: 0.01,
        high: 0.06,
        status: 'active' as const,
      })),
    };
    renderArena(api({ 'hypotheses.list': () => ({ ...base, items: [...base.items, quiet] }) }));
    await list();
    expect(
      await screen.findByText(
        /Showing the 3 that reached at least 10% at some point; 1 stayed below\./,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Show every hypothesis (4)' }));
    await waitFor(() => expect(window.location.search).toBe('?chart=all'));
    expect(screen.getByText('Showing all 4 hypotheses.')).toBeInTheDocument();
  });

  it('says it is showing all of them when every hypothesis is a contender', async () => {
    renderArena();
    await list();
    expect(await screen.findByText('Showing all 3 hypotheses.')).toBeInTheDocument();
  });

  it('has no accessibility violations when loaded', async () => {
    const { container } = renderArena();
    await list();
    await expectNoAxeViolations(container);
  }, 120_000);
});

describe('[FR-HY-02] decision-time view (as-of)', () => {
  it('lands the cursor on an event, requests every read there without hidden retries, and never asks for later data', async () => {
    navigateTo(`/?asOf=${BETWEEN_EVENTS}`);
    const handler = api();
    renderArena(handler);
    await list();
    expect(
      (await screen.findAllByText('Known as of 9 Mar 2026, 09:30 UTC')).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText('29 later events are withheld from this view.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Showing the case as of 9 Mar 2026, 09:30 UTC, the last event recorded by the moment you chose.',
      ),
    ).toBeInTheDocument();
    const known = await screen.findByLabelText('Known as of 9 Mar 2026, 09:30 UTC');
    expect(within(known).getByText('Evidence items')).toBeInTheDocument();
    expect(within(known).getByText('Later events withheld')).toBeInTheDocument();

    const restricted = ['hypotheses.list', 'forks.list', 'actions.list', 'actionValue.rank'];
    const calls = handler.call.mock.calls.filter(([route]) => restricted.includes(route as string));
    expect(calls.length).toBeGreaterThanOrEqual(restricted.length);
    for (const [, input] of calls) {
      expect(asOfOf(input)).toBe(BEFORE_FORK_EVENT);
      expect(input).toMatchObject({ maxRetries: 0 });
    }
    expect(handler.call).toHaveBeenCalledWith(
      'timeline.get',
      expect.objectContaining({ query: { asOf: BEFORE_FORK_EVENT, limit: 1 }, maxRetries: 0 }),
    );
    // The instants are read from the whole record before any earlier view is requested, so none is requested twice.
    expect(
      calls.filter(([, input]) => asOfOf(input) !== null && asOfOf(input) !== BEFORE_FORK_EVENT),
    ).toEqual([]);
    // No quick jump into the future: the fork does not exist yet at this boundary.
    expect(
      screen.queryByRole('button', { name: /Just before the earliest meaningful decision fork/ }),
    ).toBeNull();
  });

  it('jumps to the event just before the earliest meaningful fork and limits everything to it', async () => {
    const user = userEvent.setup();
    const handler = api();
    renderArena(handler);
    const jump = await screen.findByRole('button', {
      name: 'Just before the earliest meaningful decision fork',
    });
    expect(
      screen.getByRole('link', { name: /Simulate a safer path from 9 Mar 2026, 09:41 UTC/ }),
    ).toHaveAttribute('href', '/cases/case_1/counterfactual?sel=fork_1');
    // The cursor knows the event instants once its previous/next buttons exist.
    await screen.findByRole('button', { name: 'Previous event' });
    await user.click(jump);
    await waitFor(() =>
      expect(window.location.search).toBe(`?asOf=${encodeURIComponent(BEFORE_FORK_EVENT)}`),
    );
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'hypotheses.list',
        expect.objectContaining({ query: { asOf: BEFORE_FORK_EVENT } }),
      ),
    );
    expect(
      (await screen.findAllByText('Known as of 9 Mar 2026, 09:30 UTC')).length,
    ).toBeGreaterThan(0);
  });

  it('shows the boundary the server reports, which can be earlier than the one asked for', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'timeline.get': (input) => {
          const asOf = asOfOf(input);
          return asOf ? timelineWindow('2026-03-09T09:12:00Z', 7) : wholeTimeline();
        },
      }),
    );
    await list();
    expect(
      await screen.findByText(
        'Showing the case as of 9 Mar 2026, 09:12 UTC, the last event recorded by the moment you chose.',
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('7 later events are withheld from this view.'),
    ).toBeInTheDocument();
  });

  it('lists the overrides an earlier view may show and says how many recorded later it cannot, never what they are', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'actionValue.rank': () =>
          actionRanking({
            asOf: BEFORE_FORK_EVENT,
            reviewerOverrides: [
              reviewerOverride({
                instant: '2026-03-09T09:12:00.000Z',
                at: '2026-03-09T09:20:00.000Z',
                reason: 'Wait for the customer reply.',
              }),
            ],
            withheldOverrides: 2,
          }),
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    const overrides = await within(ranking).findByRole('group', { name: 'Reviewer overrides (1)' });
    expect(
      within(overrides).getByText(
        '2 reviewer overrides recorded later are not shown, because this view only shows what was known at 9 Mar 2026, 09:30 UTC.',
      ),
    ).toBeInTheDocument();
    expect(within(overrides).getByText(/Wait for the customer reply\./)).toBeInTheDocument();
    // The older note, which carried no count, is gone: this one is the only statement about what is withheld.
    expect(within(ranking).queryByText(LATER_DECISIONS)).toBeNull();
  });

  it('says "1 reviewer override ... is not shown" for a single withheld override and offers the whole record', async () => {
    const user = userEvent.setup();
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'actionValue.rank': (input) =>
          actionRanking({ asOf: asOfOf(input) ?? BEFORE_FORK_EVENT, withheldOverrides: 1 }),
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(
      await within(ranking).findByText(
        '1 reviewer override recorded later is not shown, because this view only shows what was known at 9 Mar 2026, 09:30 UTC.',
      ),
    ).toBeInTheDocument();
    await user.click(within(ranking).getByRole('button', { name: 'Show the whole record' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('shows no note when nothing is withheld, or when the field is absent', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'actionValue.rank': (input) => {
          const ranking = actionRanking({ asOf: BEFORE_FORK_EVENT });
          // A server that predates the fields sends neither of them; the schema keeps both optional.
          return asOfOf(input) ? { ...ranking, withheldOverrides: undefined } : ranking;
        },
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    const overrides = await within(ranking).findByRole('group', { name: 'Reviewer overrides (0)' });
    expect(within(overrides).queryByText(/recorded later/)).toBeNull();
    expect(
      within(overrides).getByText('No reviewer override had been recorded by this moment.'),
    ).toBeInTheDocument();
  });

  it('offers an override on an earlier view, about its moment, says where it will appear and counts it as withheld there', async () => {
    const user = userEvent.setup();
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    let recorded = false;
    const handler = api({
      'actionValue.rank': () =>
        actionRanking({ asOf: BEFORE_FORK_EVENT, withheldOverrides: recorded ? 1 : 0 }),
      'actionValue.override': () => {
        recorded = true;
        return actionRanking({
          asOf: BEFORE_FORK_EVENT,
          reviewerOverrides: [
            reviewerOverride({
              actionKey: 'act.request-minimal-scoping',
              actionName: 'Ask for minimal scoping data',
              rank: 2,
              by: 'user_reviewer',
              reason: 'The customer already mentioned a deployment.',
            }),
          ],
          withheldOverrides: 0,
        });
      },
    });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    await waitFor(() =>
      expect(
        within(ranking).getByRole('button', { name: 'Override this rank' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(within(ranking).getByRole('button', { name: 'Override this rank' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Override the rank of/ });
    expect(
      within(dialog).getByText(
        /It is about the ranking at 9 Mar 2026, 09:30 UTC\. This view only shows what was known then, so the override does not appear here: it is listed in the whole record\./,
      ),
    ).toBeInTheDocument();
    const rank = within(dialog).getByRole('spinbutton');
    await user.clear(rank);
    await user.type(rank, '2');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the override/ }),
      'The customer already mentioned a deployment.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'actionValue.override',
        expect.objectContaining({
          body: {
            asOf: BEFORE_FORK_EVENT,
            actionKey: 'act.request-minimal-scoping',
            rank: 2,
            reason: 'The customer already mentioned a deployment.',
          },
        }),
      ),
    );
    expect(
      (
        await screen.findAllByText(
          /This view only shows what was known at 9 Mar 2026, 09:30 UTC, so the override is listed in the whole record, not here\./,
        )
      ).length,
    ).toBeGreaterThan(0);
    // The earlier view never shows a decision made after it: the whole-record list in the response is not put into it.
    // Its window is read again, and now counts the override it cannot show.
    expect(
      await within(ranking).findByText(
        '1 reviewer override recorded later is not shown, because this view only shows what was known at 9 Mar 2026, 09:30 UTC.',
      ),
    ).toBeInTheDocument();
    // The dialog may still be closing: the page behind a modal dialog is not in the accessibility tree until it is gone.
    expect(
      await within(ranking).findByRole('group', { name: 'Reviewer overrides (0)' }),
    ).toBeInTheDocument();
  });

  it('does not add the withheld note to the whole-record view, where every override is listed', async () => {
    renderArena();
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(within(ranking).queryByText(/recorded later/)).toBeNull();
    expect(within(ranking).queryByText(LATER_DECISIONS)).toBeNull();
    expect(
      await within(ranking).findByText(
        'No reviewer has overridden an action ranking on this case yet.',
      ),
    ).toBeInTheDocument();
    expect(
      within(ranking).getAllByText('No reviewer has overridden this rank.').length,
    ).toBeGreaterThan(0);
  });

  it('explains a rate-limited earlier view calmly, with a countdown and Retry, and recovers', async () => {
    const user = userEvent.setup();
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    let attempts = 0;
    const handler = api({
      'hypotheses.list': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            message:
              'Too many views were recomputed in a short time. Views already computed stay available; retry shortly.',
            retryAfterMs: 1000,
          });
        return hypothesesResponse();
      },
    });
    const { container } = renderArena(handler);
    const notice = await screen.findByText('Earlier views are limited');
    expect(notice).toBeInTheDocument();
    const explanation = screen.getByText(
      /Computing earlier views is limited to keep the service responsive/,
    );
    expect(explanation).toHaveTextContent(/the hypothesis view/);
    expect(explanation).toHaveTextContent(/Views you already opened stay available\./);
    // The page stays: the cursor is still there so another (already computed) moment can be chosen.
    expect(screen.getByRole('slider', { name: 'Time cursor' })).toBeInTheDocument();
    expect(screen.queryByText('The Hypothesis Arena could not be loaded')).toBeNull();
    const retry = screen.getByRole('button', { name: /Retry in \d+ s/ });
    expect(retry).toBeDisabled();
    await expectNoAxeViolations(container);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(), {
      timeout: 20_000,
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await list()).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
  }, 60_000);

  it('offers the whole record, which is never limited, when an earlier view is refused', async () => {
    const user = userEvent.setup();
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'hypotheses.list': (input) => {
          if (asOfOf(input))
            throw new ApiError({
              status: 429,
              code: 'rate_limited',
              reason: 'engine_budget',
              title: 'Too many requests',
              retryAfterMs: 30_000,
            });
          return hypothesesResponse();
        },
      }),
    );
    await screen.findByText('Earlier views are limited');
    await user.click(screen.getByRole('button', { name: 'Show the whole record' }));
    expect(await list()).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('limits only the ranking when only the ranking is refused, and keeps the hypotheses', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'actionValue.rank': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 30_000,
          });
        },
      }),
    );
    await list();
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByText(/Computing earlier views is limited/)).toHaveTextContent(
      /the action ranking/,
    );
    expect(screen.getByRole('heading', { name: 'Competing hypotheses' })).toBeInTheDocument();
  });

  it('answers the API general limit (a 429 that names no reason) the same calm way', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'hypotheses.list': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            title: 'Too many requests',
            retryAfterMs: 30_000,
          });
        },
      }),
    );
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in \d+ s/ })).toBeDisabled();
  });

  it('treats a 429 that names another reason as an ordinary error, whatever its wording says', async () => {
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'hypotheses.list': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'provider_throttled',
            title: 'Too many requests',
            message: 'Too many views were recomputed in a short time.',
            retryAfterMs: 30_000,
          });
        },
      }),
    );
    expect(await screen.findByText('The Hypothesis Arena could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Earlier views are limited')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('cancels the request of a moment that was left before it answered', async () => {
    const user = userEvent.setup();
    navigateTo('/?asOf=2026-03-09T11:05:00Z');
    const signals = new Map<string, AbortSignal>();
    renderArena(
      api({
        'hypotheses.list': (input) => {
          const { signal } = input as { signal?: AbortSignal };
          const asOf = asOfOf(input);
          if (asOf === '2026-03-09T11:05:00Z') {
            if (signal) signals.set(asOf, signal);
            return new Promise(() => undefined);
          }
          return hypothesesResponse();
        },
      }),
    );
    await waitFor(() => expect(signals.has('2026-03-09T11:05:00Z')).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));
    await waitFor(() => expect(signals.get('2026-03-09T11:05:00Z')?.aborted).toBe(true));
    expect(await list()).toBeInTheDocument();
  });

  it('makes one request when the cursor rests, not one per position while it is dragged', async () => {
    const handler = api();
    renderArena(handler);
    await list();
    const slider = await screen.findByRole('slider', { name: 'Time cursor' });
    // Three positions in quick succession: 09:32, 09:37 and 09:42 (the last lands on the 09:41 event).
    fireEvent.change(slider, { target: { value: '20' } });
    fireEvent.change(slider, { target: { value: '25' } });
    fireEvent.change(slider, { target: { value: '30' } });
    await waitFor(() => expect(window.location.search).toBe('?asOf=2026-03-09T09%3A41%3A00Z'));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'hypotheses.list',
        expect.objectContaining({ query: { asOf: '2026-03-09T09:41:00Z' } }),
      ),
    );
    const asOfCalls = handler.call.mock.calls.filter(
      ([route, input]) => route === 'hypotheses.list' && asOfOf(input) !== null,
    );
    expect(asOfCalls).toHaveLength(1);
  });
});

describe('[FR-HY-02] only the chosen moment is ever on screen', () => {
  const never = () => new Promise<never>(() => undefined);
  const refused = (retryAfterMs: number) =>
    new ApiError({
      status: 429,
      code: 'rate_limited',
      reason: 'engine_budget',
      title: 'Too many requests',
      retryAfterMs,
    });

  it('shows only that the moment is being looked up, never the numbers of the moment before it', async () => {
    const user = userEvent.setup();
    renderArena(
      api({ 'hypotheses.list': (input) => (asOfOf(input) ? never() : hypothesesResponse()) }),
    );
    await list();
    await screen.findByRole('group', { name: 'Next best action' });
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));

    expect(
      await screen.findByText('Looking up what was known at 11 Mar 2026, 11:50 UTC…'),
    ).toBeInTheDocument();
    // Nothing of the whole record stays under the name of the moment that was chosen.
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Hypotheses ranked by confidence' })).toBeNull(),
    );
    expect(screen.queryByRole('heading', { name: 'Competing hypotheses' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Next best action' })).toBeNull();
    expect(screen.queryByText('DNS resolution failure for sign-in endpoints')).toBeNull();
    expect(screen.queryByText(/estimate 73%/)).toBeNull();
    expect(
      screen.getAllByText(/Loading the confidence chart/)[0]?.closest('[aria-busy="true"]'),
    ).not.toBeNull();
  });

  it('says which moment it is looking up once, whether only the hypotheses or also the counts of the moment are pending', async () => {
    const user = userEvent.setup();
    renderArena(
      api({
        'hypotheses.list': (input) => (asOfOf(input) ? never() : hypothesesResponse()),
        'timeline.get': (input) => (asOfOf(input) ? never() : wholeTimeline()),
      }),
    );
    await list();
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));
    // The "What was known" panel says it while its counts load; the page says it only when that panel does not.
    await waitFor(() =>
      expect(
        screen.getAllByText(/Looking up what was known at 11 Mar 2026, 11:50 UTC/),
      ).toHaveLength(1),
    );
    expect(screen.queryByRole('list', { name: 'Hypotheses ranked by confidence' })).toBeNull();
  });

  it('shows the ranking as loading, not the ranking of the moment before, while only its answer is pending', async () => {
    const user = userEvent.setup();
    renderArena(
      api({ 'actionValue.rank': (input) => (asOfOf(input) ? never() : actionRanking()) }),
    );
    await screen.findByRole('group', { name: 'Next best action' });
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));

    expect(await screen.findByText(/Loading the action ranking/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Next best action' })).toBeNull();
    expect(screen.queryByText('Ask for minimal scoping data')).toBeNull();
    expect(
      screen.getByText(/Loading the action ranking/).closest('[aria-busy="true"]'),
    ).not.toBeNull();
    // The rest of the chosen moment is there: only what is pending is held back.
    expect(await list()).toBeInTheDocument();
  });

  it('shows only the calm notice when the moment is refused, and still nothing of the whole record while Retry waits', async () => {
    const user = userEvent.setup();
    let asked = 0;
    renderArena(
      api({
        'hypotheses.list': (input) => {
          if (!asOfOf(input)) return hypothesesResponse();
          asked += 1;
          if (asked === 1) throw refused(1000);
          return never();
        },
      }),
    );
    await list();
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Hypotheses ranked by confidence' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Next best action' })).toBeNull();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled(), {
      timeout: 20_000,
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('Looking up what was known at 11 Mar 2026, 11:50 UTC…'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Hypotheses ranked by confidence' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Next best action' })).toBeNull();
    expect(asked).toBe(2);
  }, 60_000);

  it('puts only the calm notice where the ranking was when its moment is refused', async () => {
    const user = userEvent.setup();
    renderArena(
      api({
        'actionValue.rank': (input) => {
          if (asOfOf(input)) throw refused(30_000);
          return actionRanking();
        },
      }),
    );
    await screen.findByRole('group', { name: 'Next best action' });
    await user.click(await screen.findByRole('button', { name: 'Previous event' }));
    expect(await screen.findByText('Earlier views are limited')).toBeInTheDocument();
    expect(screen.getByText(/Computing earlier views is limited/)).toHaveTextContent(
      /the action ranking/,
    );
    expect(screen.queryByRole('group', { name: 'Next best action' })).toBeNull();
    expect(screen.queryByText('Ask for minimal scoping data')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Competing hypotheses' })).toBeInTheDocument();
  });
});

describe('[FR-HY-03] action-value ranking', () => {
  it('shows the ranking with its formula, the full calculation, sensitivity and the safety-blocked actions', async () => {
    const user = userEvent.setup();
    renderArena();
    await list();
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(within(ranking).getByText(/not a scientific measurement/)).toBeInTheDocument();
    expect(within(ranking).getByText('Estimated scores')).toBeInTheDocument();

    const first = within(ranking).getByRole('button', { name: /#1 Ask for minimal scoping data/ });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    const calculation = within(ranking).getByRole('table', {
      name: 'Calculation of Ask for minimal scoping data',
    });
    expect(within(calculation).getByText('Expected information gain')).toBeInTheDocument();
    expect(within(calculation).getAllByText('Numerator')).toHaveLength(3);
    expect(within(calculation).getAllByText('Denominator')).toHaveLength(4);
    const sentence = within(ranking).getByText(
      (_content, element) =>
        element?.tagName === 'P' &&
        /Numerator 0\.2387 ÷ denominator 0\.1793 = score 1\.33, which is 100% of the best safe action/.test(
          element.textContent ?? '',
        ),
    );
    expect(sentence).toBeInTheDocument();
    expect(
      within(ranking).getByText(/The rank holds \(1\) when each weight changes by 25%/),
    ).toBeInTheDocument();
    expect(
      within(ranking).getByRole('table', {
        name: 'Rank under changed weights for Ask for minimal scoping data',
      }),
    ).toBeInTheDocument();

    await user.click(within(ranking).getByText(/Blocked by the safety policy \(1\)/));
    expect(within(ranking).getByText('Remove the resolver from service')).toBeInTheDocument();
    expect(within(ranking).getByText(/Remediation, not a diagnostic step/)).toBeInTheDocument();
  });

  it('says when a rank is only a close call', async () => {
    const user = userEvent.setup();
    renderArena();
    await list();
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    await user.click(within(ranking).getByRole('button', { name: /#3 Request HAR/ }));
    expect(within(ranking).getByText(/The rank changes \(3–4\)/)).toBeInTheDocument();
  });

  it('lets a reviewer override a rank with a required reason and records it at the ranking instant', async () => {
    const user = userEvent.setup();
    const handler = api({ 'actionValue.override': () => actionRanking() });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    // The permission check settles after the first paint and replaces the button, so look it up again.
    await waitFor(() =>
      expect(
        within(ranking).getByRole('button', { name: 'Override this rank' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(within(ranking).getByRole('button', { name: 'Override this rank' }));

    const dialog = await screen.findByRole('alertdialog', {
      name: /Override the rank of “Ask for minimal scoping data”/,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));
    expect(within(dialog).getByText('Enter at least 5 characters.')).toBeInTheDocument();
    expect(handler.call).not.toHaveBeenCalledWith('actionValue.override', expect.anything());

    const rank = within(dialog).getByRole('spinbutton');
    await user.clear(rank);
    await user.type(rank, '2');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the override/ }),
      'The customer already mentioned a deployment.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'actionValue.override',
        expect.objectContaining({
          params: { caseId: CASE_ID },
          body: {
            asOf: RANKING_AS_OF,
            actionKey: 'act.request-minimal-scoping',
            rank: 2,
            reason: 'The customer already mentioned a deployment.',
          },
        }),
      ),
    );
    expect(await screen.findByText('Override recorded')).toBeInTheDocument();
  });

  it('shows an existing override next to the machine rank, which stays visible', async () => {
    const ranked = actionRanking();
    const first = ranked.candidates[1];
    if (!first) throw new Error('fixture has two candidates');
    const withOverride = actionRanking({
      candidates: ranked.candidates.map((item, index) =>
        index === 1
          ? {
              ...item,
              override: {
                rank: 1,
                reason: 'Ask about changes first.',
                by: 'user_riley_reviewer',
                at: '2026-10-30T05:51:41.391Z',
              },
            }
          : item,
      ),
    });
    renderArena(api({ 'actionValue.rank': () => withOverride }));
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(await within(ranking).findByText('Reviewer override: rank 1')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(ranking).getByRole('button', { name: /#2 Ask about recent identity/ }));
    expect(within(ranking).getByText(/Override: rank 1/)).toBeInTheDocument();
    expect(within(ranking).getByText(/machine rank 2/)).toBeInTheDocument();
    expect(within(ranking).getByText(/Ask about changes first\./)).toBeInTheDocument();
    expect(within(ranking).getByText(/By user_riley_reviewer on/)).toBeInTheDocument();
  });

  it('says "you" when the override was recorded by the signed-in reviewer', async () => {
    const ranked = actionRanking();
    const mine = actionRanking({
      candidates: ranked.candidates.map((item, index) =>
        index === 0
          ? {
              ...item,
              override: {
                rank: 2,
                reason: 'Wait for the customer reply.',
                by: 'user_reviewer',
                at: '2026-10-30T05:51:41.391Z',
              },
            }
          : item,
      ),
    });
    renderArena(api({ 'actionValue.rank': () => mine }));
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(await within(ranking).findByText(/By you on/)).toBeInTheDocument();
  });

  it('lists every reviewer override under the ranking with what is known about each, and invents nothing', async () => {
    renderArena(
      api({
        'actionValue.rank': () =>
          actionRanking({
            reviewerOverrides: [
              reviewerOverride({
                instant: RANKING_AS_OF,
                actionKey: 'act.request-recent-changes',
                actionName: 'Ask about recent identity, network or policy changes',
                rank: 1,
                by: 'user_reviewer',
                at: '2026-10-30T09:29:00.000Z',
                reason: 'The customer mentioned a deployment, so ask about changes first.',
              }),
              reviewerOverride({
                instant: '2026-03-09T09:12:00.000Z',
                actionKey: 'act.request-minimal-scoping',
                actionName: 'Ask for minimal scoping data',
                rank: 2,
                by: 'user_riley_reviewer',
                at: '2026-10-29T10:00:00.000Z',
                reason: 'Too early to ask the customer for data.',
              }),
            ],
          }),
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    const overrides = await within(ranking).findByRole('group', { name: 'Reviewer overrides (2)' });
    const items = within(
      within(overrides).getByRole('list', { name: 'Reviewer overrides' }),
    ).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [mine, theirs] = items as [HTMLElement, HTMLElement];
    expect(mine).toHaveTextContent('Ask about recent identity, network or policy changes');
    // The ranking on screen is the one this override is about, so the machine rank of that action is known.
    expect(mine).toHaveTextContent('Reviewer rank 1, machine rank 2');
    expect(mine).toHaveTextContent(
      'About the ranking at 9 Mar 2026, 09:40:59 UTC, the one shown here.',
    );
    expect(mine).toHaveTextContent(
      '“The customer mentioned a deployment, so ask about changes first.”',
    );
    await waitFor(() =>
      expect(mine).toHaveTextContent('Decided by you on 30 Oct 2026, 09:29 UTC.'),
    );
    // The machine rank of another moment is not in this response: none is shown, and none is made up.
    expect(theirs).toHaveTextContent('Reviewer rank 2');
    expect(theirs).not.toHaveTextContent('machine rank');
    expect(theirs).toHaveTextContent('About the ranking at 9 Mar 2026, 09:12 UTC.');
    expect(theirs).not.toHaveTextContent('the one shown here');
    expect(theirs).toHaveTextContent('Decided by user_riley_reviewer on 29 Oct 2026, 10:00 UTC.');
    expect(theirs).toHaveTextContent('“Too early to ask the customer for data.”');
    expect(within(overrides).queryByText(/recorded later/)).toBeNull();
  });

  it('shows the newest eight overrides and the rest on request', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 10 }, (_, index) =>
      reviewerOverride({
        instant: `2026-03-09T09:${String(10 + index)}:00.000Z`,
        reason: `Reason number ${index + 1} for the override.`,
      }),
    );
    renderArena(api({ 'actionValue.rank': () => actionRanking({ reviewerOverrides: many }) }));
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    const overrides = await within(ranking).findByRole('group', {
      name: 'Reviewer overrides (10)',
    });
    const items = () => within(overrides).getAllByRole('listitem');
    expect(items()).toHaveLength(8);
    expect(overrides).toHaveTextContent('Reason number 1 for the override.');
    expect(overrides).not.toHaveTextContent('Reason number 9 for the override.');
    await user.click(within(overrides).getByRole('button', { name: 'Show all 10 overrides' }));
    expect(items()).toHaveLength(10);
    expect(overrides).toHaveTextContent('Reason number 10 for the override.');
    await user.click(within(overrides).getByRole('button', { name: 'Show the newest 8' }));
    expect(items()).toHaveLength(8);
  });

  it('puts the list of the response in place of the whole-record one at once, without waiting for the ranking to be read again', async () => {
    const user = userEvent.setup();
    let recorded = false;
    const reason = 'The customer already mentioned a deployment.';
    const base = actionRanking();
    const overridden = actionRanking({
      candidates: base.candidates.map((item) =>
        item.actionKey === 'act.request-minimal-scoping'
          ? {
              ...item,
              override: { rank: 2, reason, by: 'user_reviewer', at: '2026-10-30T09:29:00.000Z' },
            }
          : item,
      ),
      reviewerOverrides: [
        reviewerOverride({
          instant: RANKING_AS_OF,
          actionKey: 'act.request-minimal-scoping',
          actionName: 'Ask for minimal scoping data',
          rank: 2,
          by: 'user_reviewer',
          reason,
        }),
      ],
    });
    const handler = api({
      // Once the override is recorded the ranking is never answered again: what is on screen comes from the response.
      'actionValue.rank': () => (recorded ? new Promise<never>(() => undefined) : base),
      'actionValue.override': () => {
        recorded = true;
        return overridden;
      },
    });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(
      within(ranking).getByRole('group', { name: 'Reviewer overrides (0)' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(ranking).getByRole('button', { name: 'Override this rank' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(within(ranking).getByRole('button', { name: 'Override this rank' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Override the rank of/ });
    const rank = within(dialog).getByRole('spinbutton');
    await user.clear(rank);
    await user.type(rank, '2');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the override/ }),
      reason,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));

    const overrides = await within(ranking).findByRole('group', { name: 'Reviewer overrides (1)' });
    expect(overrides).toHaveTextContent('Ask for minimal scoping data');
    expect(overrides).toHaveTextContent('Reviewer rank 2, machine rank 1');
    expect(within(ranking).getByText('Reviewer override: rank 2')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Every ranking is read again in the background, and the dialog did not wait for that.
    await waitFor(() =>
      expect(
        handler.call.mock.calls.filter(([route]) => route === 'actionValue.rank').length,
      ).toBeGreaterThan(1),
    );
  });

  it('says plainly that an override on an earlier ranking was not recorded when earlier views are limited', async () => {
    const user = userEvent.setup();
    navigateTo(`/?asOf=${BEFORE_FORK_EVENT}`);
    renderArena(
      api({
        'actionValue.rank': () => actionRanking({ asOf: BEFORE_FORK_EVENT }),
        'actionValue.override': () => {
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            reason: 'engine_budget',
            title: 'Too many requests',
            retryAfterMs: 3500,
          });
        },
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    await waitFor(() =>
      expect(
        within(ranking).getByRole('button', { name: 'Override this rank' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(within(ranking).getByRole('button', { name: 'Override this rank' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Override the rank of/ });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the override/ }),
      'The customer already mentioned a deployment.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Computing earlier views is limited to keep the service responsive, so the override could not be recorded just now and nothing was recorded. Try again in 4 s.',
    );
    // The dialog stays, with what the person typed, and nothing was announced as recorded.
    expect(within(dialog).getByRole('textbox', { name: /Reason for the override/ })).toHaveValue(
      'The customer already mentioned a deployment.',
    );
    expect(screen.queryByText('Override recorded')).toBeNull();
  });

  it('keeps the override disabled, with the reason, for a role without the permission', async () => {
    const user = userEvent.setup();
    const handler = api({}, 'engineer');
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    const button = await within(ranking).findByRole('button', { name: 'Override this rank' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    await user.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "actionvalue:override" permission/,
    );
  });

  it('shows the ranking error inside its own panel with Retry while the rest of the page stays', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const handler = api({
      'actionValue.rank': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 500,
            code: 'internal_error',
            title: 'Server error',
            correlationId: 'corr-9',
          });
        return actionRanking();
      },
    });
    renderArena(handler);
    await list();
    expect(await screen.findByText('The action ranking could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Competing hypotheses' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('group', { name: 'Next best action' })).toBeInTheDocument();
  });
});

describe('[FR-HY-03] a resolved case has nothing left to rank at its last event', () => {
  const NOTHING_LEFT =
    'The case is resolved: at its last event there is nothing left to rank. Choose an earlier decision point.';
  const noForks = () => ({ items: [], earliestMeaningfulForkId: null });
  /** The whole record is the last event, all zeros; every earlier moment is a real ranking. */
  const rankings =
    (listed: ReturnType<typeof reviewerOverride>[] = []) =>
    (input: unknown) => {
      const asOf = asOfOf(input);
      return asOf ? actionRanking({ asOf }) : zeroScoreRanking({ reviewerOverrides: listed });
    };

  it('shows the ranking just before the earliest meaningful decision fork instead, and says why', async () => {
    const handler = api({
      'actionValue.rank': rankings([
        reviewerOverride({
          instant: BEFORE_FORK_EVENT,
          actionKey: 'act.request-recent-changes',
          rank: 1,
          reason: 'Ask about changes first.',
        }),
      ]),
    });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(await within(ranking).findByText(NOTHING_LEFT)).toBeInTheDocument();
    expect(within(ranking).getByText('Nothing left to rank at the last event')).toBeInTheDocument();
    expect(
      within(ranking).getByText(
        /Showing the ranking just before the earliest meaningful decision fork/,
      ),
    ).toHaveTextContent(
      /Heavy customer request when a lighter ask was available.*decided 9 Mar 2026, 09:41 UTC/,
    );
    expect(
      within(ranking).getByText(
        /Ranked as of 9 Mar 2026, 09:30 UTC, just before the earliest meaningful decision fork/,
      ),
    ).toBeInTheDocument();
    expect(handler.call).toHaveBeenCalledWith(
      'actionValue.rank',
      expect.objectContaining({ query: { asOf: BEFORE_FORK_EVENT } }),
    );
    // The cursor is untouched: this is still the whole record.
    expect(window.location.search).toBe('');
    // The ranking that mattered is a recommendation again, and no zero score is shown as one.
    expect(
      within(ranking).getByRole('button', { name: /#1 Ask for minimal scoping data/ }),
    ).toBeInTheDocument();
    expect(within(ranking).queryByText(/Review federation server health/)).toBeNull();
    // The list is the whole record's: the override about this very ranking shows its machine rank, and no window is named.
    const overrides = within(ranking).getByRole('group', { name: 'Reviewer overrides (1)' });
    expect(overrides).toHaveTextContent('Reviewer rank 1, machine rank 2');
    expect(within(ranking).getByText('Reviewer override: rank 1')).toBeInTheDocument();
    expect(within(ranking).queryByText(/recorded later/)).toBeNull();
  });

  it('records an override on that ranking at its own moment and lists it at once', async () => {
    const user = userEvent.setup();
    const reason = 'The customer already mentioned a deployment.';
    let recorded = false;
    const handler = api({
      'actionValue.rank': (input) =>
        recorded ? new Promise<never>(() => undefined) : rankings()(input),
      'actionValue.override': () => {
        recorded = true;
        return actionRanking({
          asOf: BEFORE_FORK_EVENT,
          reviewerOverrides: [
            reviewerOverride({
              instant: BEFORE_FORK_EVENT,
              actionKey: 'act.request-minimal-scoping',
              actionName: 'Ask for minimal scoping data',
              rank: 2,
              by: 'user_reviewer',
              reason,
            }),
          ],
        });
      },
    });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    await waitFor(() =>
      expect(
        within(ranking).getByRole('button', { name: 'Override this rank' }),
      ).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(within(ranking).getByRole('button', { name: 'Override this rank' }));
    const dialog = await screen.findByRole('alertdialog', { name: /Override the rank of/ });
    const rank = within(dialog).getByRole('spinbutton');
    await user.clear(rank);
    await user.type(rank, '2');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the override/ }),
      reason,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record override' }));
    await waitFor(() =>
      expect(handler.call).toHaveBeenCalledWith(
        'actionValue.override',
        expect.objectContaining({
          body: {
            asOf: BEFORE_FORK_EVENT,
            actionKey: 'act.request-minimal-scoping',
            rank: 2,
            reason,
          },
        }),
      ),
    );
    const overrides = await within(ranking).findByRole('group', { name: 'Reviewer overrides (1)' });
    expect(overrides).toHaveTextContent('Reviewer rank 2, machine rank 1');
    expect(within(ranking).getByText('Reviewer override: rank 2')).toBeInTheDocument();
    // Still the ranking before the fork: the whole record has not been asked to answer again for this to show.
    expect(within(ranking).getByText(NOTHING_LEFT)).toBeInTheDocument();
  });

  it('says so plainly, and folds the zero scores away, when there is no decision point to show instead', async () => {
    renderArena(api({ 'forks.list': noForks, 'actionValue.rank': () => zeroScoreRanking() }));
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(within(ranking).getByText('Nothing left to rank at the last event')).toBeInTheDocument();
    expect(within(ranking).getByText(NOTHING_LEFT)).toBeInTheDocument();
    expect(
      within(ranking).getByText(/Move the time cursor back to an earlier moment/),
    ).toBeInTheDocument();
    const folded = within(ranking)
      .getByText(/Candidate actions \(3\): every score is 0, so none is a recommendation/)
      .closest('details');
    expect(folded).not.toBeNull();
    expect(folded).not.toHaveAttribute('open');
    const firstRow = within(ranking).getByRole('button', { name: /#1 /, hidden: true });
    expect(firstRow).not.toBeVisible();
  });

  it('does not call the case resolved when it is still open', async () => {
    renderArena(
      api({
        'cases.get': () => caseDetail({ status: 'open', closedAt: null }),
        'forks.list': noForks,
        'actionValue.rank': () => zeroScoreRanking(),
      }),
    );
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(
      await within(ranking).findByText(
        'At its last event there is nothing left to rank. Choose an earlier decision point.',
      ),
    ).toBeInTheDocument();
    expect(within(ranking).queryByText(/The case is resolved/)).toBeNull();
  });

  it('shows a moment the person chose as it is, even at the last event: the default only applies to the whole record', async () => {
    navigateTo(`/?asOf=${LAST_EVENT}`);
    const handler = api({
      'actionValue.rank': (input) => zeroScoreRanking({ asOf: asOfOf(input) ?? LAST_EVENT }),
    });
    renderArena(handler);
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(await within(ranking).findByText(NOTHING_LEFT)).toBeInTheDocument();
    expect(
      within(ranking).queryByText(/just before the earliest meaningful decision fork/),
    ).toBeNull();
    expect(handler.call).not.toHaveBeenCalledWith(
      'actionValue.rank',
      expect.objectContaining({ query: { asOf: BEFORE_FORK_EVENT } }),
    );
    expect(new URLSearchParams(window.location.search).get('asOf')).toBe(LAST_EVENT);
  });

  it('words a moment that is not the last event without saying the case is over', async () => {
    const moment = '2026-03-11T11:50:00Z';
    navigateTo(`/?asOf=${moment}`);
    renderArena(api({ 'actionValue.rank': () => zeroScoreRanking({ asOf: moment }) }));
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(
      await within(ranking).findByText(
        'No candidate action is expected to add information at this moment, so there is nothing left to rank. Choose an earlier decision point.',
      ),
    ).toBeInTheDocument();
    expect(within(ranking).getByText('Nothing left to rank at this moment')).toBeInTheDocument();
    expect(within(ranking).queryByText(/The case is resolved/)).toBeNull();
  });

  it('shows no zero-score note for a ranking with scores', async () => {
    renderArena();
    const ranking = await screen.findByRole('group', { name: 'Next best action' });
    expect(within(ranking).queryByText(/nothing left to rank/i)).toBeNull();
    expect(within(ranking).queryByText(/every score is 0/)).toBeNull();
  });
});

describe('[FR-HY-04] Hypothesis Arena states', () => {
  it('offers a next step when there are no hypotheses yet', async () => {
    const { container } = renderArena(
      api({ 'hypotheses.list': () => hypothesesResponse({ items: [] }) }),
    );
    expect(await screen.findByRole('heading', { name: 'No hypotheses yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the case' })).toHaveAttribute(
      'href',
      '/cases/case_1',
    );
    await expectNoAxeViolations(container);
  });

  it('shows an error with Retry and recovers', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const flaky = api({
      'hypotheses.list': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({
            status: 502,
            code: 'upstream_unavailable',
            title: 'API unavailable',
            correlationId: 'corr-1',
          });
        return hypothesesResponse();
      },
    });
    const { container } = renderArena(flaky);
    expect(await screen.findByText('The CaseGuard API is not reachable')).toBeInTheDocument();
    expect(screen.getByText('corr-1')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(
      await screen.findByRole('heading', { name: 'Competing hypotheses' }),
    ).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('does not offer Retry for a forbidden response', async () => {
    renderArena(
      api({
        'hypotheses.list': () => {
          throw new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden' });
        },
      }),
    );
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('asks for an identity instead of failing when nobody is signed in', async () => {
    const quiet = api();
    renderApp(<HypothesisArenaPage caseId={CASE_ID} />, { api: quiet, persona: null });
    expect(
      await screen.findByRole('heading', { name: 'Choose who you are acting as' }),
    ).toBeInTheDocument();
    expect(quiet.call).not.toHaveBeenCalledWith('hypotheses.list', expect.anything());
  });

  it('registers the case reference as the breadcrumb label and links to the Counterfactual Lab', async () => {
    renderArena();
    await list();
    expect(screen.getByRole('link', { name: 'Counterfactual Lab' })).toHaveAttribute(
      'href',
      '/cases/case_1/counterfactual',
    );
    expect(await screen.findByText('CG-SYN-1001')).toBeInTheDocument();
  });
});
