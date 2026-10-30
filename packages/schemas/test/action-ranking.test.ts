import { describe, expect, it } from 'vitest';
import {
  ACTION_OVERRIDES_LISTED_MAX,
  ActionOverrideRecordSchema,
  ActionRankingSchema,
  ROUTES,
} from '../src';

const ranking = {
  caseId: 'case_a',
  asOf: '2026-03-09T09:41:00.000Z',
  configVersion: 'av-1',
  formula: 'a heuristic, not a scientific law',
  notice: 'decision support only',
  posterior: [],
  candidates: [],
  blocked: [],
};

const override = {
  instant: '2026-03-09T09:41:00.000Z',
  actionKey: 'act.capture-logs',
  actionName: 'Capture the diagnostic logs',
  rank: 1,
  reason: 'The customer cannot run captures this week',
  by: 'user_riley_reviewer',
  at: '2026-07-01T00:00:00.000Z',
};

describe('the action ranking and its reviewer overrides', () => {
  it('[FR-AV-02] still accepts a ranking without the override fields, as an older server sends it', () => {
    const parsed = ActionRankingSchema.parse(ranking);
    expect(parsed.reviewerOverrides).toBeUndefined();
    expect(parsed.withheldOverrides).toBeUndefined();
    expect(ROUTES['actionValue.rank'].response).toBe(ActionRankingSchema);
  });

  it('[FR-AV-02] accepts the list of overrides and the count of those a window cannot show', () => {
    const parsed = ActionRankingSchema.parse({
      ...ranking,
      reviewerOverrides: [override],
      withheldOverrides: 2,
    });
    expect(parsed.reviewerOverrides).toEqual([override]);
    expect(parsed.withheldOverrides).toBe(2);
  });

  it('[FR-AV-02] bounds the list and refuses malformed entries and counts', () => {
    const entries = Array.from({ length: ACTION_OVERRIDES_LISTED_MAX }, () => override);
    expect(ActionRankingSchema.safeParse({ ...ranking, reviewerOverrides: entries }).success).toBe(
      true,
    );
    expect(
      ActionRankingSchema.safeParse({ ...ranking, reviewerOverrides: [...entries, override] })
        .success,
    ).toBe(false);
    expect(ActionRankingSchema.safeParse({ ...ranking, withheldOverrides: -1 }).success).toBe(
      false,
    );
    expect(ActionRankingSchema.safeParse({ ...ranking, withheldOverrides: 1.5 }).success).toBe(
      false,
    );
    for (const broken of [
      { ...override, rank: 0 },
      { ...override, instant: 'yesterday' },
      { ...override, at: '2026-07-01' },
      { ...override, actionName: undefined },
    ]) {
      expect(ActionOverrideRecordSchema.safeParse(broken).success).toBe(false);
    }
  });
});
