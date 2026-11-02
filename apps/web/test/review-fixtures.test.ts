import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO, OVERLAY_ONE, OVERLAY_TWO, PROVENANCE_ONE } from './review-fixtures';

/** The facts the guided review tests rely on. If a fixture is refreshed, these show what changed in the engine. */
describe('the captured engine output of the samples', () => {
  it('has the shape the review is built for: Case One has decision points, Case Two has none', () => {
    expect(CASE_ONE.detail.reference).toBe('CG-SYN-1001');
    expect(CASE_ONE.timeline.events).toHaveLength(31);
    expect(CASE_ONE.forks.items).toHaveLength(9);
    expect(CASE_ONE.forks.items.filter((fork) => fork.isEarliestMeaningful)).toHaveLength(1);
    expect(CASE_ONE.quality.band).toBe('poor');
    expect(CASE_ONE.scenarios.some((scenario) => scenario.reviewState === 'confirmed')).toBe(true);

    expect(CASE_TWO.detail.reference).toBe('CG-SYN-1002');
    expect(CASE_TWO.timeline.events).toHaveLength(15);
    expect(CASE_TWO.forks.items).toEqual([]);
    expect(CASE_TWO.warnings).toEqual([]);
    expect(CASE_TWO.scenarios).toEqual([]);
    expect(CASE_TWO.quality.band).toBe('strong');
    expect(CASE_TWO.matches[0]?.applied).toBe(true);
  });

  it('keeps the hand-built responses consistent with the captured cases', () => {
    expect(OVERLAY_ONE.caseId).toBe(CASE_ONE.detail.id);
    expect(OVERLAY_ONE.matchId).toBe(CASE_ONE.matches[0]?.id);
    expect(OVERLAY_TWO.caseId).toBe(CASE_TWO.detail.id);
    expect(OVERLAY_TWO.matchId).toBe(CASE_TWO.matches[0]?.id);
    expect(PROVENANCE_ONE.caseId).toBe(CASE_ONE.detail.id);
    const eventIds = new Set(CASE_ONE.timeline.events.map((event) => event.id));
    for (const item of PROVENANCE_ONE.items)
      if (item.event) expect(eventIds.has(item.event.id)).toBe(true);
  });
});
