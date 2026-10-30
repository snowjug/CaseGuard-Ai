/* The scan for reviewer overrides, without a database: what it asks the repository for, which
 * decisions it counts inside a window, and what it does when there are more than it will read. */
import { describe, expect, it } from 'vitest';
import type { Page, ReviewDecision } from '@caseguard/schemas';
import {
  OVERRIDE_MAX_PAGES,
  OVERRIDE_PAGE,
  loadOverrides,
  type OverrideSource,
} from '../src/services/views/action-value';
import { buildReviewDecision } from './builders';

const INSTANT = '2026-03-11T14:10:00.000Z';
const KEY = `${INSTANT}|act.capture`;

const decision = (
  id: string,
  rank: number,
  decidedAt: string,
  reason = 'A reason',
): ReviewDecision =>
  buildReviewDecision({
    id,
    caseId: 'case_a',
    targetType: 'action_value',
    targetId: KEY,
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

describe('the scan for reviewer overrides', () => {
  it('[FR-AV-02] asks only for the action-value decisions of the case, page by page', async () => {
    const { ctx, calls } = source([
      [decision('rev_3', 3, '2026-07-03T00:00:00.000Z')],
      [decision('rev_2', 2, '2026-07-02T00:00:00.000Z')],
      [decision('rev_1', 1, '2026-07-01T00:00:00.000Z')],
    ]);
    const found = await loadOverrides(ctx, 'case_a', INSTANT, null);
    expect(calls).toEqual([
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE },
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE, cursor: 'page1' },
      { caseId: 'case_a', targetType: 'action_value', limit: OVERRIDE_PAGE, cursor: 'page2' },
    ]);
    // Newest first: the first decision seen for an action is the current one.
    expect(found.get('act.capture')).toMatchObject({ rank: 3 });
    expect(found.size).toBe(1);
  });

  it('[FR-AV-02] counts inside a window only what was decided by then, the latest of those', async () => {
    const { ctx } = source([
      [
        decision('rev_3', 3, '2026-07-03T00:00:00.000Z', 'Reason-token-late'),
        decision('rev_2', 2, '2026-03-11T14:10:00.000Z', 'Reason-token-exactly-then'),
        decision('rev_1', 1, '2026-03-11T14:09:59.999Z', 'Reason-token-before'),
      ],
    ]);
    const inWindow = await loadOverrides(ctx, 'case_a', INSTANT, INSTANT);
    // The decision made at the very instant is part of the window, the later one is not.
    expect(inWindow.get('act.capture')).toMatchObject({
      rank: 2,
      reason: 'Reason-token-exactly-then',
      at: '2026-03-11T14:10:00.000Z',
    });
    expect(JSON.stringify([...inWindow])).not.toContain('Reason-token-late');
    const before = await loadOverrides(ctx, 'case_a', INSTANT, '2026-03-11T14:09:59.999Z');
    expect(before.get('act.capture')).toMatchObject({ rank: 1 });
    const earlier = await loadOverrides(ctx, 'case_a', INSTANT, '2026-03-01T00:00:00.000Z');
    expect(earlier.size).toBe(0);
    // The whole record shows the latest decision of all.
    expect((await loadOverrides(ctx, 'case_a', INSTANT, null)).get('act.capture')).toMatchObject({
      rank: 3,
    });
  });

  it('[FR-AV-02] reads decisions about this instant and action only, whatever the repository sends', async () => {
    const other = buildReviewDecision({
      id: 'rev_other',
      caseId: 'case_a',
      targetType: 'claim',
      targetId: KEY,
      decidedAt: '2026-07-04T00:00:00.000Z',
    });
    const elsewhere = decision('rev_elsewhere', 9, '2026-07-05T00:00:00.000Z');
    const moved = { ...elsewhere, targetId: `2026-03-12T10:00:00.000Z|act.capture` };
    const garbled = {
      ...decision('rev_bad', 1, '2026-07-06T00:00:00.000Z'),
      newValue: { rank: 'first' },
    };
    const { ctx } = source([
      [other, moved, garbled, decision('rev_ok', 4, '2026-07-01T00:00:00.000Z')],
    ]);
    const found = await loadOverrides(ctx, 'case_a', INSTANT, null);
    expect([...found.keys()]).toEqual(['act.capture']);
    expect(found.get('act.capture')).toMatchObject({ rank: 4, by: 'user_riley_reviewer' });
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
    const found = await loadOverrides(ctx, 'case_a', INSTANT, null);
    expect(calls).toHaveLength(OVERRIDE_MAX_PAGES);
    expect(found.size).toBe(1);
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
    await loadOverrides(ctx, 'case_a', INSTANT, null);
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
