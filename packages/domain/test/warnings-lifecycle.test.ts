import { describe, expect, it } from 'vitest';
import { CaseWarningSchema, type CaseWarning } from '@caseguard/schemas';
import {
  WarningDismissalSchema,
  createTemporalView,
  evaluateLiveWarnings,
  replayWarnings,
  runDeterministicAnalysis,
  type WarningDismissal,
  type WarningReplay,
} from '../src';
import {
  CASE_ONE,
  CONFIG,
  eventBySuffix,
  prepareBundle,
  prepareCase,
  type Prepared,
} from './helpers';
import { customerEvent, engineerEvent, variantOfCaseOne } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const at = (iso: string): number => Date.parse(iso);
const EVD02 = 'LQ-EVD-02|hyp.conditional-access';
const EVD03 = 'LQ-EVD-03|hyp.conditional-access';
const REASON = 'Reviewed with the customer and being tested';

const dismissal = (dedupeKey: string, when: string, reason = REASON): WarningDismissal => ({
  dedupeKey,
  by: 'Reviewer 1',
  at: when,
  reason,
});

const replayOf = (
  p: Prepared,
  extra: Partial<Parameters<typeof replayWarnings>[0]> = {},
): WarningReplay =>
  replayWarnings({
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    ctx: p.ctx,
    analysis: p.analysis,
    ...extra,
  });

const find = (
  r: { warnings: readonly CaseWarning[] },
  fingerprint: string,
): CaseWarning | undefined => r.warnings.find((w) => w.fingerprint === fingerprint);

const need = (r: { warnings: readonly CaseWarning[] }, fingerprint: string): CaseWarning => {
  const found = find(r, fingerprint);
  if (!found) throw new Error(`no warning ${fingerprint}`);
  return found;
};

describe('dismissal (FR-LQ-01)', () => {
  it('[FR-LQ-01] a dismissed warning keeps its reason and is not raised again while the condition continues', () => {
    const r = replayOf(one, { dismissals: [dismissal(EVD02, '2026-03-09T12:15:00Z')] });
    const w = need(r, EVD02);
    expect(w.state).toBe('dismissed');
    expect(w.dismissal).toEqual({ by: 'Reviewer 1', at: '2026-03-09T12:15:00Z', reason: REASON });
    expect(w.resolvedAt).toBeNull();
    expect(r.warnings.filter((x) => x.fingerprint.startsWith(EVD02))).toHaveLength(1);
    expect(r.counts).toMatchObject({ dismissed: 1, open: 0, resolved: r.warnings.length - 1 });
    expect(r.transitions.filter((t) => t.dedupeKey === EVD02).map((t) => t.kind)).toEqual([
      'raised',
      'dismissed',
      'suppressed',
    ]);
    expect(r.warnings[0]?.fingerprint).toBe(EVD02);
    expect(r.unmatchedDismissals).toEqual([]);
    expect(() => CaseWarningSchema.parse(w)).not.toThrow();
  });

  it('[FR-LQ-01] a dismissal made before the warning existed, after it resolved, or for an unknown key changes nothing', () => {
    const early = dismissal(EVD02, '2026-03-09T12:00:00Z');
    const late = dismissal(EVD02, '2026-03-11T00:00:00Z');
    const unknown = dismissal('LQ-EVD-99|nothing', '2026-03-10T00:00:00Z');
    const r = replayOf(one, { dismissals: [early, late, unknown] });
    expect(r.counts.dismissed).toBe(0);
    expect(r.unmatchedDismissals).toEqual([early, late, unknown]);
    expect(need(r, EVD02).state).toBe('resolved');
  });

  it('[FR-LQ-01] a dismissal needs a reason of at least five characters and a valid time', () => {
    expect(() =>
      replayOf(one, { dismissals: [dismissal(EVD02, '2026-03-09T12:15:00Z', 'no')] }),
    ).toThrow();
    expect(WarningDismissalSchema.safeParse(dismissal(EVD02, 'not a time')).success).toBe(false);
    expect(WarningDismissalSchema.safeParse(dismissal(EVD02, '2026-03-09T12:15:00Z')).success).toBe(
      true,
    );
    expect(
      WarningDismissalSchema.safeParse({ ...dismissal(EVD02, '2026-03-09T12:15:00Z'), by: '' })
        .success,
    ).toBe(false);
  });

  it('[FR-LQ-01] a dismissed one-off nudge stays dismissed after the next engineer step', () => {
    const r = replayOf(one, { dismissals: [dismissal('LQ-TRB-03|e08', '2026-03-09T12:26:00Z')] });
    const w = need(r, 'LQ-TRB-03|e08');
    expect(w.state).toBe('dismissed');
    expect(w.resolvedAt).toBeNull();
    expect(need(r, 'LQ-TRB-03|e09').state).toBe('resolved');
  });

  it('[FR-LQ-01] a dismissed waiting-time warning does not hide it once it is a day overdue (the condition worsened)', () => {
    const four = dismissal('LQ-COM-01|e14:4h', '2026-03-09T22:00:00Z');
    const r = replayOf(one, { dismissals: [four] });
    expect(need(r, 'LQ-COM-01|e14:4h').state).toBe('dismissed');
    const day = need(r, 'LQ-COM-01|e14:24h');
    expect(day.dismissal).toBeNull();
    expect(day.state).toBe('resolved');

    const during = replayWarnings({
      events: one.normalized.events,
      resolution: one.normalized.resolution,
      pack: one.pack,
      ctx: one.ctx,
      asOf: '2026-03-10T18:00:00Z',
      dismissals: [four],
    });
    expect(during.open.map((w) => w.fingerprint)).toContain('LQ-COM-01|e14:24h');
    expect(find(during, 'LQ-COM-01|e14:4h')?.state).toBe('dismissed');
  });

  it('[FR-LQ-01] a dismissal made after the replay boundary is not yet known', () => {
    const d = dismissal(EVD02, '2026-03-09T12:15:00Z');
    const base = {
      events: one.normalized.events,
      resolution: one.normalized.resolution,
      pack: one.pack,
      ctx: one.ctx,
      dismissals: [d],
    };
    const early = replayWarnings({ ...base, asOf: eventBySuffix(one, 'e07').timestamp });
    expect(need(early, EVD02).state).toBe('open');
    expect(early.unmatchedDismissals).toEqual([]);
    const later = replayWarnings({ ...base, asOf: eventBySuffix(one, 'e08').timestamp });
    expect(need(later, EVD02).state).toBe('dismissed');
    expect(need(later, 'LQ-TRB-03|e08').state).toBe('open');
  });
});

describe('a condition that returns is a new occurrence (FR-LQ-01)', () => {
  const restated = engineerEvent({
    id: 'z6',
    timestamp: '2026-03-10T10:00:00Z',
    body: "Root cause is the Conditional Access policy 'Require MFA for Teams'.",
  });
  const variant = prepareBundle(variantOfCaseOne(16, [restated]), 'case_refire');

  it('[FR-LQ-01] a resolved state warning that fires again is raised again with a new identity', () => {
    const r = replayOf(variant);
    const first = need(r, EVD02);
    const second = need(r, `${EVD02}#2`);
    expect(first.state).toBe('resolved');
    expect(at(first.resolvedAt ?? '')).toBe(at(eventBySuffix(variant, 'e15').timestamp));
    expect(second.state).toBe('open');
    expect(second.id).not.toBe(first.id);
    expect(at(second.raisedAt)).toBe(at(restated.timestamp));
    expect(() => CaseWarningSchema.parse(second)).not.toThrow();
  });

  it('[FR-LQ-01] a dismissed warning is not raised again as a new occurrence', () => {
    const r = replayOf(variant, { dismissals: [dismissal(EVD02, '2026-03-09T12:15:00Z')] });
    expect(need(r, EVD02).state).toBe('dismissed');
    expect(find(r, `${EVD02}#2`)).toBeUndefined();
  });
});

describe('continuing the lifecycle between evaluations (FR-LQ-01)', () => {
  const prefix = (suffix: string) =>
    runDeterministicAnalysis({
      view: createTemporalView(one.normalized.events, eventBySuffix(one, suffix).timestamp),
      pack: one.pack,
      config: CONFIG,
      ctx: one.ctx,
    });
  const evaluate = (
    suffix: string,
    extra: Partial<Parameters<typeof evaluateLiveWarnings>[0]> = {},
  ) => evaluateLiveWarnings({ analysis: prefix(suffix), pack: one.pack, ctx: one.ctx, ...extra });

  it('[FR-LQ-01] earlier warnings are kept as raised, new ones are added, and resolved ones close', () => {
    const e07 = evaluate('e07');
    expect(e07.open.map((w) => w.fingerprint).sort()).toEqual([EVD02, EVD03]);
    expect(e07.transitions.map((t) => t.kind)).toEqual(['raised', 'raised']);

    const e08 = evaluate('e08', { previous: e07.warnings });
    for (const w of e07.warnings) {
      expect(find(e08, w.fingerprint)).toMatchObject({
        id: w.id,
        raisedAt: w.raisedAt,
        message: w.message,
      });
    }
    expect(e08.open.map((w) => w.fingerprint)).toContain('LQ-TRB-03|e08');
    expect(evaluate('e08', { previous: e08.warnings }).warnings).toEqual(e08.warnings);

    const e15 = evaluate('e15', { previous: e08.warnings });
    expect(need(e15, EVD02)).toMatchObject({
      state: 'resolved',
      resolvedAt: eventBySuffix(one, 'e15').timestamp,
    });
    expect(need(e15, 'LQ-TRB-03|e08').state).toBe('resolved');
    expect(need(e15, EVD03).state).toBe('open');
    expect(e15.open.map((w) => w.fingerprint)).toContain('LQ-EVD-01|planned');
    for (const w of e15.warnings) expect(() => CaseWarningSchema.parse(w)).not.toThrow();
  });

  it('[FR-LQ-01] a dismissal carries over to later evaluations and the warning stays closed', () => {
    const e08 = evaluate('e08', { previous: evaluate('e07').warnings });
    const dismissals = [dismissal(EVD03, '2026-03-10T08:00:00Z')];
    const e15 = evaluate('e15', { previous: e08.warnings, dismissals });
    expect(need(e15, EVD03)).toMatchObject({
      state: 'dismissed',
      dismissal: { by: 'Reviewer 1', at: '2026-03-10T08:00:00Z', reason: REASON },
    });
    expect(e15.open.map((w) => w.fingerprint)).not.toContain(EVD03);

    const e19 = evaluate('e19', { previous: e15.warnings, dismissals });
    expect(e19.warnings.filter((w) => w.fingerprint.startsWith(EVD03))).toHaveLength(1);
    expect(need(e19, EVD03).state).toBe('dismissed');
    expect(e19.open.map((w) => w.fingerprint)).toContain('LQ-EVD-01|recorded');
  });
});

describe('thresholds can be configured (FR-LQ-01)', () => {
  it('[FR-LQ-01] the reply-wait thresholds move the waiting-time warnings', () => {
    const r = replayOf(one, { options: { replyWaitHours: 2, replyWaitCriticalHours: 6 } });
    const e14 = eventBySuffix(one, 'e14');
    const keys = r.warnings
      .map((w) => w.fingerprint)
      .filter((f) => f.startsWith('LQ-COM-01|e14:'))
      .sort();
    expect(keys).toEqual(['LQ-COM-01|e14:2h', 'LQ-COM-01|e14:6h']);
    expect(at(need(r, 'LQ-COM-01|e14:2h').raisedAt) - at(e14.timestamp)).toBe(2 * 3_600_000);
    expect(at(need(r, 'LQ-COM-01|e14:6h').raisedAt) - at(e14.timestamp)).toBe(6 * 3_600_000);
  });

  it('[FR-LQ-01] the heavy-request threshold controls the expectation-setting warning only', () => {
    const r = replayOf(one, { options: { heavyEffortScore: 2 } });
    expect(r.warnings.some((w) => w.ruleId === 'LQ-COM-02')).toBe(false);
    expect(replayOf(one).warnings.some((w) => w.ruleId === 'LQ-COM-02')).toBe(true);
    expect(r.warnings.some((w) => w.ruleId === 'LQ-TRB-04')).toBe(true);
    expect(r.warnings.some((w) => w.ruleId === 'LQ-TRB-03')).toBe(true);
  });
});

describe('scoping, closure and checklist rules (FR-LQ-01)', () => {
  const ack = engineerEvent({
    id: 'z1',
    timestamp: '2026-03-09T09:41:00Z',
    type: 'engineer_email',
    title: 'Acknowledged',
    body: 'Hello, thank you for reporting this. We are looking into it and will keep you posted. Regards',
  });
  const note = engineerEvent({
    id: 'z2',
    timestamp: '2026-03-09T13:00:00Z',
    body: 'Reviewing the tenant configuration.',
  });
  const request = engineerEvent({
    id: 'z3',
    timestamp: '2026-03-09T13:30:00Z',
    type: 'engineer_email',
    title: 'Request for scoping details',
    body: 'Hello, please send the exact error text, three affected users with UTC failure times, and which sites are affected. Regards',
    action: {
      actionKey: 'act.request-minimal-scoping',
      label: 'Ask for minimal scoping data',
      customerEffort: 'low',
      destructive: false,
    },
  });
  const scopingOf = (r: WarningReplay) => r.warnings.filter((w) => w.category === 'scoping');

  it('[FR-LQ-01] flags scoping items that were neither obtained nor requested once the grace period has passed', () => {
    const p = prepareBundle(variantOfCaseOne(2, [ack, note]), 'case_scoping');
    const scoping = scopingOf(replayOf(p));
    expect(scoping.map((w) => w.fingerprint).sort()).toEqual([
      'LQ-SCO-01|req.error-code',
      'LQ-SCO-01|req.failure-timestamps',
      'LQ-SCO-01|req.sample-users',
      'LQ-SCO-01|req.site-pattern',
    ]);
    for (const w of scoping) {
      expect(at(w.raisedAt)).toBe(at('2026-03-09T11:12:00Z'));
      expect(w.state).toBe('open');
      expect(w.message).toMatch(/no request for it has gone to the customer/);
      expect(w.suggestedAction).toMatch(/^Ask for it now: Ask for minimal scoping data/);
      expect(w.evidence.map((l) => l.type)).toContain('requirement');
      expect(() => CaseWarningSchema.parse(w)).not.toThrow();
    }
    expect(need({ warnings: scoping }, 'LQ-SCO-01|req.error-code').priority).toBe('medium');
    expect(need({ warnings: scoping }, 'LQ-SCO-01|req.site-pattern').priority).toBe('low');
    expect(scopingOf(replayOf(one))).toEqual([]);
  });

  it('[FR-LQ-01] they clear as soon as the engineer asks for them', () => {
    const p = prepareBundle(variantOfCaseOne(2, [ack, note, request]), 'case_scoping_asked');
    const scoping = scopingOf(replayOf(p));
    expect(scoping).toHaveLength(4);
    for (const w of scoping) {
      expect(w.state).toBe('resolved');
      expect(at(w.resolvedAt ?? '')).toBe(at(request.timestamp));
      expect(w.resolvedReason).toMatch(/obtained or requested/);
    }
  });

  it('[FR-LQ-01] the grace period is configurable and a warning that falls due after the replay boundary is not raised', () => {
    const p = prepareBundle(variantOfCaseOne(2, [ack, note]), 'case_scoping_grace');
    expect(scopingOf(replayOf(p, { options: { scopingGraceMinutes: 300 } }))).toEqual([]);
    const later = replayWarnings({
      events: p.normalized.events,
      resolution: p.normalized.resolution,
      pack: p.pack,
      ctx: p.ctx,
      asOf: '2026-03-09T15:00:00Z',
      options: { scopingGraceMinutes: 300 },
    });
    const scoping = scopingOf(later);
    expect(scoping).toHaveLength(4);
    for (const w of scoping) expect(at(w.raisedAt)).toBe(at('2026-03-09T14:12:00Z'));
  });

  const closing = engineerEvent({
    id: 'z4',
    timestamp: '2026-03-12T10:05:00Z',
    type: 'resolution_note',
    title: 'Resolution summary',
    body: 'Resolution summary. Resolved after the DNS change. Closing the case.',
  });

  it('[FR-LQ-01] flags a closure recorded without validation or customer confirmation, from the moment it is recorded', () => {
    const p = prepareBundle(variantOfCaseOne(27, [closing]), 'case_closing');
    const w = need(replayOf(p), 'LQ-CLS-01|closure');
    expect(w).toMatchObject({ category: 'closure', priority: 'critical', state: 'open' });
    expect(at(w.raisedAt)).toBe(at(closing.timestamp));
    expect(w.message).toMatch(/Fix validated with a before\/after comparison/);
    expect(w.message).toMatch(/Customer confirms users can sign in/);
    expect(w.suggestedAction).toMatch(
      /^Validate before closing: Validate the fix with a before\/after comparison/,
    );

    const base = {
      events: p.normalized.events,
      resolution: p.normalized.resolution,
      pack: p.pack,
      ctx: p.ctx,
    };
    const before = replayWarnings({ ...base, asOf: eventBySuffix(p, 'e27').timestamp });
    expect(find(before, 'LQ-CLS-01|closure')).toBeUndefined();
    const atClosure = replayWarnings({ ...base, asOf: closing.timestamp });
    expect(find(atClosure, 'LQ-CLS-01|closure')?.state).toBe('open');
  });

  it('[FR-LQ-01] the closure warning resolves automatically once validation and confirmation are on record', () => {
    const confirmation = customerEvent({
      id: 'z5',
      timestamp: '2026-03-12T10:20:00Z',
      title: 'Overnight update',
      body: 'Our helpdesk reports no sign-in tickets since yesterday. We confirm users can sign in.',
      structured: { fixTarget: 'dns-resolver', failuresAfterChange: 0, monitoringHours: 20 },
    });
    const p = prepareBundle(variantOfCaseOne(27, [closing, confirmation]), 'case_closing_fixed');
    const w = need(replayOf(p), 'LQ-CLS-01|closure');
    expect(w.state).toBe('resolved');
    expect(at(w.resolvedAt ?? '')).toBe(at(confirmation.timestamp));
    expect(w.resolvedReason).toMatch(/missing validation and confirmation are now on record/);
  });

  it('[FR-LQ-01] flags a workaround that is not separated from the permanent fix', () => {
    const workaroundOnly = engineerEvent({
      id: 'z6',
      timestamp: '2026-03-12T10:05:00Z',
      type: 'resolution_note',
      title: 'Resolution summary',
      body: 'Resolution summary. Workaround: resolver removed from DHCP scopes. Closing the case.',
    });
    const p = prepareBundle(variantOfCaseOne(14, [workaroundOnly]), 'case_conflation');
    const w = need(replayOf(p), 'LQ-CLS-02|closure');
    expect(w).toMatchObject({ category: 'closure', priority: 'medium', state: 'open' });
    expect(w.title).toMatch(/not stated separately/);
    expect(w.suggestedAction).toMatch(/State the workaround and the permanent fix separately/);
    expect(find(replayOf(one), 'LQ-CLS-02|closure')).toBeUndefined();
  });

  it('[FR-LQ-01] checklist wording is flagged once and clears at the next engineer step', () => {
    const template = engineerEvent({
      id: 'z7',
      timestamp: '2026-03-09T11:00:00Z',
      body: 'All checks completed per checklist. No issues found.',
    });
    const next = engineerEvent({
      id: 'z8',
      timestamp: '2026-03-09T11:30:00Z',
      body: 'Querying the sign-in logs for the sample users next.',
    });
    const open = need(
      replayOf(prepareBundle(variantOfCaseOne(4, [template]), 'case_tpl')),
      'LQ-EVD-04|z7',
    );
    expect(open).toMatchObject({ state: 'open', category: 'evidence', priority: 'medium' });
    expect(open.suggestedAction).toMatch(/Record what was actually observed/);
    const closed = need(
      replayOf(prepareBundle(variantOfCaseOne(4, [template, next]), 'case_tpl_next')),
      'LQ-EVD-04|z7',
    );
    expect(closed.state).toBe('resolved');
    expect(at(closed.resolvedAt ?? '')).toBe(at(next.timestamp));
  });
});
