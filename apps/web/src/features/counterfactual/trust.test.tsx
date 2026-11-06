import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CounterfactualQuality } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { TrustPanel } from './TrustPanel';
import { describeTrust } from './trust';

const quality = (over: Partial<CounterfactualQuality> = {}): CounterfactualQuality => ({
  basis: {
    scenario: 'deterministic_estimate',
    summary:
      'A computed estimate. The engine simulated this path 200 times from the knowledge pack’s authored probabilities.',
    parts: [
      {
        what: 'Recorded path: elapsed time, steps and customer exchanges',
        basis: 'measured',
        note: 'Read from the timestamps and events of this case.',
      },
      {
        what: 'Alternative path: the steps and what each would return',
        basis: 'deterministic_estimate',
        note: 'Simulated 200 times.',
      },
    ],
  },
  feasibility: {
    level: 'feasible_with_conditions',
    reasons: ['Step 1 (Ask for scoping data): The customer has to do it.'],
  },
  constraints: ['The simulation does not know the access the engineer had.'],
  skillApplicability: {
    status: 'applies',
    skills: [
      {
        skillId: 'skl_a',
        name: 'Isolate a pre-authentication failure',
        triggerCoverage: 0.8,
        recommendsFirstStep: true,
      },
    ],
    note: '“Isolate a pre-authentication failure” already matched at that moment.',
  },
  validation: ['Quote times, token counts and any saving as ranges; do not quote a single figure.'],
  timeSavedClaim: 'estimated_range',
  ...over,
});

describe('how far to trust a simulated path: the words', () => {
  it('has nothing to say about a scenario stored before the engine wrote it down', () => {
    expect(describeTrust(undefined)).toBeNull();
  });

  it('names what the figures rest on, whether the path could be followed, and what is claimed', () => {
    const trust = describeTrust(quality());
    expect(trust).toMatchObject({
      basisLabel: 'Computed estimate',
      basisBadge: 'neutral',
      feasibilityLabel: 'Could have been done if certain things held',
      feasibilityBadge: 'uncertain',
      claimText: 'Times are shown as ranges. No exact saving is claimed.',
    });
    expect(trust?.parts.map((part) => part.basisLabel)).toEqual([
      'Measured from the record',
      'Computed estimate',
    ]);
    expect(trust?.skill).toMatchObject({
      label: 'A governed skill already applied at that moment',
      skills: [
        {
          name: 'Isolate a pre-authentication failure',
          coverageText: '80% of its triggers held',
          recommendsFirstStep: true,
        },
      ],
    });
  });

  it('an illustration claims no saving and is not shown as an estimate', () => {
    const trust = describeTrust(
      quality({
        basis: { ...quality().basis, scenario: 'illustrative' },
        timeSavedClaim: 'none',
        feasibility: { level: 'not_feasible', reasons: [] },
        skillApplicability: { status: 'not_assessed', skills: [], note: 'Not checked.' },
      }),
    );
    expect(trust).toMatchObject({
      basisLabel: 'Illustration only',
      basisBadge: 'uncertain',
      feasibilityLabel: 'Could not have been done as described',
      feasibilityBadge: 'unsupported',
      claimText: 'No saving is claimed for this path.',
    });
    expect(trust?.skill.label).toBe('Skills were not checked against this path');
  });
});

describe('how far to trust a simulated path: the panel', () => {
  it('shows the basis and feasibility up front and the detail one click away', async () => {
    const trust = describeTrust(quality());
    if (trust === null) throw new Error('expected a trust view');
    const { container } = renderApp(<TrustPanel trust={trust} />);

    expect(screen.getByRole('group', { name: 'How far to trust this path' })).toBeInTheDocument();
    expect(screen.getByText('Computed estimate')).toBeInTheDocument();
    expect(screen.getByText('Could have been done if certain things held')).toBeInTheDocument();
    expect(
      screen.getByText('Times are shown as ranges. No exact saving is claimed.'),
    ).toBeInTheDocument();

    const summary = screen.getByRole('button', {
      name: 'What it rests on, what limits it and what to check',
    });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expectNoAxeViolations(container);

    await userEvent.click(summary);
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('What to check before relying on it')).toBeInTheDocument();
    expect(
      screen.getByText(/Step 1 \(Ask for scoping data\): The customer has to do it\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Isolate a pre-authentication failure: 80% of its triggers held/),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
