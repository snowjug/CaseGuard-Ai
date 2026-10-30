import { formatDateTimeUtc } from '@caseguard/ui';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { AsOfPanel, type AsOfPanelProps, type KnownSummary } from './AsOfPanel';

const RANGE = { min: '2026-03-09T09:12:00Z', max: '2026-03-10T08:55:00Z' };
const AS_OF = '2026-03-09T09:41:00Z';
const KNOWN: KnownSummary = {
  evidenceCount: 9,
  claimCount: 20,
  criticalMissingCount: 1,
  openWarningCount: 3,
  withheldFutureEventCount: 4,
  cutAt: AS_OF,
};

function renderPanel(props: Partial<AsOfPanelProps> = {}) {
  return renderApp(
    <AsOfPanel caseId="case_1" range={RANGE} asOf={AS_OF} onChange={vi.fn()} {...props} />,
  );
}

describe('AsOfPanel', () => {
  it('says which moment it is looking up, with a placeholder and none of the counts, while they load', async () => {
    const { container } = renderPanel({ loading: true });
    expect(
      screen.getByText(`Looking up what was known at ${formatDateTimeUtc(AS_OF)}…`),
    ).toBeInTheDocument();
    expect(screen.getByText('Counting what was known…')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Nothing that could be taken for an answer about this moment.
    expect(screen.queryByText('Later events withheld')).toBeNull();
    expect(screen.queryByText(/No event had been recorded/)).toBeNull();
    expect(screen.queryByText(/Showing the case as of/)).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('shows the counts and the instant the server cut the evidence at once they are known', () => {
    renderPanel({ known: KNOWN });
    expect(
      screen.getByText(
        `Showing the case as of ${formatDateTimeUtc(AS_OF)}, the last event recorded by the moment you chose.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Later events withheld')).toBeInTheDocument();
    expect(screen.queryByText(/Looking up what was known/)).toBeNull();
  });

  it('says that nothing had been recorded only when the server says so', () => {
    renderPanel({ known: { ...KNOWN, cutAt: null, withheldFutureEventCount: 31 } });
    expect(
      screen.getByText('No event had been recorded by the moment you chose.'),
    ).toBeInTheDocument();
  });

  it('says the counts could not be loaded, instead of looking them up for ever', () => {
    renderPanel();
    expect(
      screen.getByText('What was known at the moment you chose could not be loaded.'),
    ).toBeInTheDocument();
    expect(screen.getByText('The counts for this moment could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/Looking up what was known/)).toBeNull();
    expect(screen.queryByText('Counting what was known…')).toBeNull();
  });

  it('explains a rate limit without claiming to be looking anything up', () => {
    renderPanel({ limited: true });
    expect(
      screen.getByText('What was known at the moment you chose could not be worked out just now.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Counts for this moment are not available right now/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Looking up what was known/)).toBeNull();
  });

  it('shows no counts, and no lookup, for the whole record', () => {
    renderPanel({ asOf: null, loading: true });
    expect(
      screen.getByText('Move the cursor to see the case as it stood at an earlier moment.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Showing the whole record, up to the last event.')).toBeInTheDocument();
    expect(screen.queryByText(/Looking up what was known/)).toBeNull();
  });

  it('offers to read the events of the case again when the cursor cannot land on one', async () => {
    const user = userEvent.setup();
    const onRetryInstants = vi.fn();
    const { container, unmount } = renderPanel({ instantsFailed: true, onRetryInstants });
    expect(
      screen.getByText(
        /The events of this case could not be listed, so the cursor cannot land on one/,
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryInstants).toHaveBeenCalledTimes(1);
    unmount();

    renderPanel({ instantsFailed: false, onRetryInstants });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
