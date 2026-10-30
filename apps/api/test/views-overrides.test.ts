/* The scan for reviewer overrides, without a database: what it asks the repository for, which decisions
 * it lists inline and in the list, which it counts as withheld inside a window, what it ignores, and
 * what it does when there are more than it will read or list. The same rules against the real routes
 * and database are in views.test.ts. */
import { describe, expect, it } from 'vitest';
import { ACTION_OVERRIDES_LISTED_MAX, type Page, type ReviewDecision } from '@caseguard/schemas';
import {
  OVERRIDE_MAX_PAGES,
  OVERRIDE_PAGE,
  loadOverrides,
  type OverrideScan,
  type OverrideSource,
} from '../src/services/views/overrides';
import { buildReviewDecision } from './builders';

const INSTANT = '2026-03-11T14:10:00.000Z';
const LATER = '2026-03-11T15:30:00.000Z';
const KEY = `${INSTANT}|act.capture`;
const NAMES: Readonly<Record<string, string>> = { 'act.capture': 'Capture the diagnostic logs' };

const decision = (
  id: string,
  rank: number,
  decidedAt: string,
  reason = 'A reason',
  targetId = KEY,
): ReviewDecision =>
  buildReviewDecision({
    id,
    caseId: 'case_a',
    targetType: 'action_value',
    targetId,
    decision: 'override',
    newValue: { rank },
    reason,
    decidedAt,
    reviewerId: 'user_riley_reviewer',
  });

interface Call {
  readonly caseId?: string | undefined;
  readonly targetType?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/** A repository that serves scripted pages and remembers how it was asked. */
function source(pages: readonly (readonly ReviewDecision[])[], endless = false) {
  const calls: Call[] = [];
  const warnings: { details: object; message: string }[] = [];
  const ctx: OverrideSource = {
    repos: {
      reviews: {
        list: (query): Promise<Page<ReviewDecision>> => {
          calls.push(query);
          // The cursor says which page of the script this call continues, so every scan starts at the top.
          const index = query.cursor === undefined ? 0 : Number(query.cursor.replace('page', ''));
          const items = pages[endless ? index % pages.length : index] ?? [];
          const more = endless || index + 1 < pages.length;
          return Promise.resolve({
            items: [...items],
            nextCursor: more ? `page${index + 1}` : null,
          });
        },
      },
    },
    logger: { warn: (details, message) => void warnings.push({ details, message }) },
  };
  return { ctx, calls, warnings };
}

const query = (instant: string, knownBy: string | null) => ({
  instant,
  knownBy,
  nameOf: (actionKey: string): string | undefined => NAMES[actionKey],
});

/** The whole record, ranked at `instant`. */
const whole = (ctx: OverrideSource, instant = INSTANT): Promise<OverrideScan> =>
  loadOverrides(ctx, 'case_a', query(instant, null));

/** A window ending at `end`: the ranking's own instant is the end of its window, as in the routes. */
const within = (ctx: OverrideSource, end: string): Promise<OverrideScan> =>
  loadOverrides(ctx, 'case_a', query(end, end));

const serialized = (scan: OverrideScan): string =>
  JSON.stringify({ inline: [...scan.inline], listed: scan.listed, withheld: scan.withheld });

describe('the scan for reviewer overrides', () => {
  it('[FR-AV-02] asks only for the action-value decisions of the case, page by page', async () => {
    const { ctx, calls } = source([
      [decision('rev_3', 3, '2026-07-03T00:00:00.000Z')],
      [decision('rev_2', 2, '2026-07-02T00:00:00.000Z')],
      [decision('rev_1', 1, '2026-07-01T00:00:00.000Z')],
    ]);
    const found = await whole(ctx);
    expect(calls).toEqual([
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE },
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE, cursor: 'page1' },
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE, cursor: 'page2' },
    ]);
    // Newest first: the first decision seen for an (instant, action) is the current one.
    expect(found.inline.get('act.capture')).toMatchObject({ rank: 3 });
    expect(found.inline.size).toBe(1);
    expect(found.listed).toHaveLength(1);
    expect(found.withheld).toBe(0);
  });

  it('[FR-AV-02] counts inside a window only what was decided by then, the latest of those', async () => {
    const { ctx } = source([
      [
        decision('rev_3', 3, '2026-07-03T00:00:00.000Z', 'Reason-token-late'),
        decision('rev_2', 2, INSTANT, 'Reason-token-exactly-then'),
        decision('rev_1', 1, '2026-03-11T14:09:59.999Z', 'Reason-token-before'),
      ],
    ]);
    const inWindow = await within(ctx, INSTANT);
    // The decision made at the very instant is part of the window, the later one is not.
    expect(inWindow.inline.get('act.capture')).toMatchObject({
      rank: 2,
      reason: 'Reason-token-exactly-then',
      at: INSTANT,
    });
    expect(inWindow.listed).toMatchObject([{ instant: INSTANT, rank: 2, at: INSTANT }]);
    expect(inWindow.withheld).toBe(0);
    expect(serialized(inWindow)).not.toContain('Reason-token-late');

    // A window that ends before the instant the override is about cannot show it, however early it was decided.
    const before = await within(ctx, '2026-03-11T14:09:59.999Z');
    expect(before.inline.size).toBe(0);
    expect(before.listed).toEqual([]);
    expect(before.withheld).toBe(1);
    expect(serialized(before)).not.toContain('Reason-token');

    // The whole record shows the latest decision of all.
    expect((await whole(ctx)).inline.get('act.capture')).toMatchObject({ rank: 3 });
  });

  it('[FR-AV-02] shows inline only the overrides about the ranking’s own instant and lists the rest', async () => {
    const otherKind = buildReviewDecision({
      id: 'rev_other',
      caseId: 'case_a',
      targetType: 'claim',
      targetId: KEY,
      decidedAt: '2026-07-04T00:00:00.000Z',
    });
    const elsewhere = decision(
      'rev_elsewhere',
      9,
      '2026-07-05T00:00:00.000Z',
      'About another instant',
      `${LATER}|act.capture`,
    );
    const garbled = {
      ...decision('rev_bad', 1, '2026-07-06T00:00:00.000Z'),
      newValue: { rank: 'first' },
    };
    const { ctx } = source([
      [otherKind, elsewhere, garbled, decision('rev_ok', 4, '2026-07-01T00:00:00.000Z')],
    ]);
    const found = await whole(ctx);
    expect([...found.inline.keys()]).toEqual(['act.capture']);
    expect(found.inline.get('act.capture')).toMatchObject({ rank: 4, by: 'user_riley_reviewer' });
    // The override about LATER is not on the candidate of this ranking, but it is in the list.
    expect(found.listed.map((entry) => [entry.instant, entry.rank])).toEqual([
      [LATER, 9],
      [INSTANT, 4],
    ]);
    const atLater = await whole(ctx, LATER);
    expect(atLater.inline.get('act.capture')).toMatchObject({ rank: 9 });
    expect(atLater.listed).toEqual(found.listed);
    const unrelated = await whole(ctx, '2026-03-11T16:00:00.000Z');
    expect(unrelated.inline.size).toBe(0);
    expect(unrelated.listed).toEqual(found.listed);
  });

  it('[FR-AV-02] finds the overrides of a ranking instant written without milliseconds', async () => {
    const { ctx } = source([[decision('rev_1', 2, '2026-07-01T00:00:00.000Z')]]);
    const found = await whole(ctx, '2026-03-11T14:10:00Z');
    expect(found.inline.get('act.capture')).toMatchObject({ rank: 2 });
  });

  it('[FR-AV-02] lists each (instant, action) once with its latest decision, newest decision first, named by the pack', async () => {
    const { ctx } = source([
      [
        decision('rev_5', 3, '2026-07-05T00:00:00.000Z', 'Fifth', `${LATER}|act.verify-fix`),
        decision('rev_4', 2, '2026-07-04T00:00:00.000Z', 'Fourth'),
        decision('rev_3', 1, '2026-07-03T00:00:00.000Z', 'Third', `${LATER}|act.capture`),
      ],
      [
        decision('rev_2', 6, '2026-07-02T00:00:00.000Z', 'Second, superseded'),
        decision(
          'rev_1',
          4,
          '2026-07-01T00:00:00.000Z',
          'First, superseded',
          `${LATER}|act.capture`,
        ),
      ],
    ]);
    const found = await whole(ctx, LATER);
    expect(found.listed).toEqual([
      {
        instant: LATER,
        actionKey: 'act.verify-fix',
        // The pack has no name for this action, so the key stands in.
        actionName: 'act.verify-fix',
        rank: 3,
        reason: 'Fifth',
        by: 'user_riley_reviewer',
        at: '2026-07-05T00:00:00.000Z',
      },
      {
        instant: INSTANT,
        actionKey: 'act.capture',
        actionName: 'Capture the diagnostic logs',
        rank: 2,
        reason: 'Fourth',
        by: 'user_riley_reviewer',
        at: '2026-07-04T00:00:00.000Z',
      },
      {
        instant: LATER,
        actionKey: 'act.capture',
        actionName: 'Capture the diagnostic logs',
        rank: 1,
        reason: 'Third',
        by: 'user_riley_reviewer',
        at: '2026-07-03T00:00:00.000Z',
      },
    ]);
    // Inline, the ranking at LATER carries only what is about LATER.
    expect([...found.inline].map(([actionKey, override]) => [actionKey, override.rank])).toEqual([
      ['act.verify-fix', 3],
      ['act.capture', 1],
    ]);
    expect(found.withheld).toBe(0);
  });

  it('[FR-AV-02] in a window lists only what was decided by then and is about an instant at or before it, and counts the rest by pair', async () => {
    const { ctx } = source([
      [
        decision('rev_a', 1, '2026-07-03T00:00:00.000Z', 'Reason-token-a', `${LATER}|act.capture`),
        decision(
          'rev_b',
          3,
          '2026-07-02T00:00:00.000Z',
          'Reason-token-b',
          `${INSTANT}|act.verify-fix`,
        ),
        decision('rev_c', 5, '2026-03-11T14:20:00.000Z', 'Reason-token-c'),
        decision('rev_d', 4, '2026-03-11T14:12:00.000Z', 'Reason-token-d'),
        // Decided long before either instant, but about LATER: no window before LATER can show it.
        decision(
          'rev_e',
          6,
          '2026-03-01T00:00:00.000Z',
          'Reason-token-e',
          `${LATER}|act.verify-fix`,
        ),
      ],
    ]);
    const whenRankedAt = await whole(ctx, LATER);
    expect(whenRankedAt.listed.map((entry) => entry.at)).toEqual([
      '2026-07-03T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
      '2026-03-11T14:20:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);

    // Four (instant, action) pairs exist; at the instant itself none of them can be shown: the
    // decisions were made later, or (rev_e) are about an instant that has not come yet.
    const atInstant = await within(ctx, INSTANT);
    expect(atInstant.listed).toEqual([]);
    expect(atInstant.inline.size).toBe(0);
    expect(atInstant.withheld).toBe(4);
    expect(serialized(atInstant)).not.toContain('Reason-token');

    // The older decision of a pair is current while the newer one is still in the future.
    const first = await within(ctx, '2026-03-11T14:15:00.000Z');
    expect(first.listed).toMatchObject([{ instant: INSTANT, rank: 4, reason: 'Reason-token-d' }]);
    expect(first.withheld).toBe(3);
    expect(serialized(first)).not.toMatch(/Reason-token-[abce]/);

    // The newer decision supersedes it the moment it exists (the boundary is inclusive).
    const second = await within(ctx, '2026-03-11T14:20:00.000Z');
    expect(second.listed).toMatchObject([{ instant: INSTANT, rank: 5, reason: 'Reason-token-c' }]);
    expect(second.withheld).toBe(3);
    const justBefore = await within(ctx, '2026-03-11T14:19:59.999Z');
    expect(justBefore.listed).toMatchObject([{ rank: 4 }]);

    // At LATER the early decision about LATER is in, the ones decided in July are still withheld.
    const atLater = await within(ctx, LATER);
    expect(atLater.listed).toMatchObject([{ rank: 5 }, { instant: LATER, rank: 6 }]);
    expect(atLater.inline.get('act.verify-fix')).toMatchObject({ rank: 6 });
    expect(atLater.withheld).toBe(2);
    expect(serialized(atLater)).not.toMatch(/Reason-token-[abd]/);

    // After every decision the window shows what the whole record shows.
    const after = await within(ctx, '2026-12-31T00:00:00.000Z');
    expect(after.listed).toEqual(whenRankedAt.listed);
    expect(after.withheld).toBe(0);
  });

  const valid = decision('rev_ok', 2, '2026-07-01T00:00:00.000Z', 'Valid');
  const forged: readonly (readonly [string, ReviewDecision])[] = [
    ['an id without an action', decision('f1', 1, '2026-07-02T00:00:00.000Z', 'Forged', INSTANT)],
    [
      'an instant without milliseconds',
      decision('f2', 1, '2026-07-02T00:00:00.000Z', 'Forged', '2026-03-11T14:10:00Z|act.capture'),
    ],
    [
      'an instant with extra precision',
      decision(
        'f3',
        1,
        '2026-07-02T00:00:00.000Z',
        'Forged',
        '2026-03-11T14:10:00.0000Z|act.capture',
      ),
    ],
    [
      'a date that does not exist',
      decision(
        'f4',
        1,
        '2026-07-02T00:00:00.000Z',
        'Forged',
        '2026-02-30T00:00:00.000Z|act.capture',
      ),
    ],
    ['an empty action key', decision('f5', 1, '2026-07-02T00:00:00.000Z', 'Forged', `${INSTANT}|`)],
    [
      'a key with a space',
      decision('f6', 1, '2026-07-02T00:00:00.000Z', 'Forged', `${INSTANT}|act capture`),
    ],
    [
      'a key that is too long',
      decision('f7', 1, '2026-07-02T00:00:00.000Z', 'Forged', `${INSTANT}|${'a'.repeat(81)}`),
    ],
    [
      'a key with a leading dash',
      decision('f8', 1, '2026-07-02T00:00:00.000Z', 'Forged', `${INSTANT}|-capture`),
    ],
    [
      'a key with a second separator',
      decision('f9', 1, '2026-07-02T00:00:00.000Z', 'Forged', `${INSTANT}|act.capture|more`),
    ],
    ['an id that is only text', decision('f10', 1, '2026-07-02T00:00:00.000Z', 'Forged', 'nope')],
    [
      'a rank given as text',
      { ...decision('v1', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: { rank: '1' } },
    ],
    [
      'a rank of zero',
      { ...decision('v2', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: { rank: 0 } },
    ],
    [
      'a negative rank',
      { ...decision('v3', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: { rank: -3 } },
    ],
    [
      'a fractional rank',
      { ...decision('v4', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: { rank: 1.5 } },
    ],
    ['no value', { ...decision('v5', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: null }],
    [
      'an empty value',
      { ...decision('v6', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: {} },
    ],
    [
      'a value that is only text',
      { ...decision('v7', 1, '2026-07-02T00:00:00.000Z', 'Forged'), newValue: 'first' },
    ],
    [
      'another kind of decision',
      { ...decision('k1', 1, '2026-07-02T00:00:00.000Z', 'Forged'), decision: 'reject' },
    ],
    [
      'another kind of target',
      { ...decision('k2', 1, '2026-07-02T00:00:00.000Z', 'Forged'), targetType: 'claim' },
    ],
    ['a time that is not a time', decision('k3', 1, 'not a time', 'Forged')],
  ];

  it.each(forged)(
    '[FR-AV-02] ignores %s: it is neither listed nor counted',
    async (_name, forgery) => {
      const { ctx } = source([[forgery, valid]]);
      const full = await whole(ctx);
      expect(full.listed).toMatchObject([{ reason: 'Valid', rank: 2 }]);
      expect(full.inline.size).toBe(1);
      expect(full.withheld).toBe(0);
      // Before the valid decision exists, only it is counted as withheld.
      const early = await within(ctx, INSTANT);
      expect(early.listed).toEqual([]);
      expect(early.withheld).toBe(1);
      expect(serialized(full) + serialized(early)).not.toContain('Forged');
    },
  );

  it('[FR-AV-02] shows nothing from a window whose end is not an instant', async () => {
    const { ctx } = source([[decision('rev_1', 2, '2026-07-01T00:00:00.000Z', 'Reason-token-x')]]);
    const broken = await loadOverrides(ctx, 'case_a', query(INSTANT, 'not an instant'));
    expect(broken.listed).toEqual([]);
    expect(broken.inline.size).toBe(0);
    expect(broken.withheld).toBe(1);
    expect(serialized(broken)).not.toContain('Reason-token');
  });

  it('[FR-AV-02] lists at most the newest 200 with one logged warning, and still shows the rest inline', async () => {
    // 201 actions, each overridden once about this instant, the oldest decision first made.
    const decisions = Array.from({ length: ACTION_OVERRIDES_LISTED_MAX + 1 }, (_, index) =>
      decision(
        `rev_${index}`,
        1,
        new Date(Date.parse('2026-07-01T00:00:00.000Z') + index * 1000).toISOString(),
        'Reason-token-secret',
        `${INSTANT}|act.k${index}`,
      ),
    ).reverse();
    const { ctx, warnings } = source([
      decisions.slice(0, OVERRIDE_PAGE),
      decisions.slice(OVERRIDE_PAGE),
    ]);
    const found = await whole(ctx);
    expect(found.listed).toHaveLength(ACTION_OVERRIDES_LISTED_MAX);
    expect(found.listed[0]?.actionKey).toBe('act.k200');
    expect(found.listed.at(-1)?.actionKey).toBe('act.k1');
    // The oldest override is cut from the list; it stays on its candidate, and is not "withheld".
    expect(found.listed.some((entry) => entry.actionKey === 'act.k0')).toBe(false);
    expect(found.inline.size).toBe(ACTION_OVERRIDES_LISTED_MAX + 1);
    expect(found.inline.has('act.k0')).toBe(true);
    expect(found.withheld).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.details).toEqual({
      caseId: 'case_a',
      overrides: ACTION_OVERRIDES_LISTED_MAX + 1,
      listed: ACTION_OVERRIDES_LISTED_MAX,
    });
    expect(JSON.stringify(warnings)).not.toContain('Reason-token-secret');
  });

  it('[FR-AV-02] does not warn about the list when it holds no more than 200', async () => {
    const decisions = Array.from({ length: ACTION_OVERRIDES_LISTED_MAX }, (_, index) =>
      decision(
        `rev_${index}`,
        1,
        '2026-07-01T00:00:00.000Z',
        'A reason',
        `${INSTANT}|act.k${index}`,
      ),
    );
    const { ctx, warnings } = source([decisions]);
    expect((await whole(ctx)).listed).toHaveLength(ACTION_OVERRIDES_LISTED_MAX);
    expect(warnings).toEqual([]);
  });

  it('[FR-AV-02] stops at its bound with a logged warning that holds no free text, instead of dropping older overrides silently', async () => {
    const page = Array.from({ length: OVERRIDE_PAGE }, (_, index) =>
      decision(
        `rev_${index}`,
        1,
        `2026-07-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        'Reason-token-secret',
      ),
    );
    const { ctx, calls, warnings } = source([page], true);
    const found = await whole(ctx);
    expect(calls).toHaveLength(OVERRIDE_MAX_PAGES);
    expect(found.inline.size).toBe(1);
    expect(found.listed).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.details).toEqual({
      caseId: 'case_a',
      scanned: OVERRIDE_MAX_PAGES * OVERRIDE_PAGE,
      bound: OVERRIDE_MAX_PAGES * OVERRIDE_PAGE,
    });
    expect(JSON.stringify(warnings)).not.toContain('Reason-token-secret');
  });

  it('[FR-AV-02] does not warn when the list ends within its bound', async () => {
    const { ctx, calls, warnings } = source([[decision('rev_1', 1, '2026-07-01T00:00:00.000Z')]]);
    await whole(ctx);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
