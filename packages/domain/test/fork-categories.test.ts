import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  FORK_CATEGORIES,
  type CaseBundle,
  type ForkCategory,
} from '@caseguard/schemas';
import { CASE_ONE, loadBundle, prepareBundle, prepareCase } from './helpers';

type BundleEvent = CaseBundle['events'][number];

/** A copy of Case One cut after `keep` events with extra engineer events appended (no resolution). */
function variant(keep: number, extra: unknown[]): CaseBundle {
  const copy = structuredClone(loadBundle(CASE_ONE)) as CaseBundle & { resolution?: unknown };
  copy.events = [...copy.events.slice(0, keep), ...(extra as BundleEvent[])];
  delete copy.resolution;
  return CaseBundleSchema.parse(copy);
}

const engineerEvent = (
  id: string,
  timestamp: string,
  key: string,
  label: string,
  effort: string,
  body: string,
) => ({
  id,
  timestamp,
  participantId: 'p-eng',
  type: 'engineer_email',
  channel: 'email',
  title: label,
  body,
  action: { actionKey: key, label, customerEffort: effort },
});

describe('[FR-FK-01] all eight fork categories are detected', () => {
  const caseOne = prepareCase(CASE_ONE).analysis.forks;

  it('the inefficient demo case exhibits six categories as primary', () => {
    const categories = new Set<ForkCategory>(caseOne.map((f) => f.category));
    expect(categories).toEqual(
      new Set<ForkCategory>([
        'disproportionate_customer_effort',
        'assumption_as_fact',
        'premature_destructive_action',
        'low_value_action',
        'contradiction_ignored',
        'premature_escalation',
      ]),
    );
  });

  it('flags a strong early signal that the next step ignores (high_value_signal_unused)', () => {
    const p = prepareBundle(
      variant(4, [
        engineerEvent(
          'x1',
          '2026-03-09T11:30:00Z',
          'act.device-registration-check',
          'Run dsregcmd',
          'medium',
          'Hello, please run dsregcmd /status on three devices and send the output. Regards',
        ),
      ]),
      'case_signal',
    );
    const fork = p.analysis.forks.find((f) => f.eventId === 'x1');
    expect(fork?.category).toBe('high_value_signal_unused');
    expect(fork?.summary).toMatch(/already pointed to/);
    expect(fork?.alternatives[0]?.actionKey).toBe('act.dns-resolver-comparison');
  });

  it('flags a clearly weaker next step that is not otherwise wasteful (alternative_action_available)', () => {
    const p = prepareBundle(
      variant(1, [
        engineerEvent(
          'y1',
          '2026-03-09T09:20:00Z',
          'act.request-recent-changes',
          'Ask about recent changes',
          'low',
          'Hello, were there any identity, network or policy changes shortly before 08:50 UTC? Regards',
        ),
      ]),
      'case_alternative',
    );
    const fork = p.analysis.forks.find((f) => f.eventId === 'y1');
    expect(fork?.category).toBe('alternative_action_available');
    expect(fork?.severity).toBe('low');
    expect(fork?.impactScore).toBeGreaterThanOrEqual(0.25);
  });

  it('does not flag sound, cheap or standard practice', () => {
    const cheap = prepareBundle(
      variant(1, [
        {
          id: 'y3',
          timestamp: '2026-03-09T09:20:00Z',
          participantId: 'p-eng',
          type: 'engineer_action',
          channel: 'tool',
          title: 'Check service health',
          body: 'Checked the Service health dashboard: nothing active.',
          action: {
            actionKey: 'act.check-service-health',
            label: 'Check service health',
            customerEffort: 'none',
          },
        },
      ]),
      'case_cheap',
    );
    expect(cheap.analysis.forks).toHaveLength(0);
  });

  it('every category value the engine emits exists in the contract', () => {
    for (const fork of caseOne) expect(FORK_CATEGORIES).toContain(fork.category);
  });
});
