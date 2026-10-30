import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../test/harness';
import { ExpandableText } from './ExpandableText';

const EMOJI = '\u{1F600}';

// encodeURIComponent throws a URIError for a lone surrogate, which is what would show as a replacement character.
const isWellFormed = (value: string): boolean => {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};

describe('[FR-GOV-31] ExpandableText', () => {
  it('never cuts an emoji in half when it clips long text', async () => {
    const user = userEvent.setup();
    // The emoji occupies units 239 and 240 of the text, so a cut at the limit of 240 falls between its two halves.
    const text = `${'a'.repeat(239)}${EMOJI}${'b'.repeat(60)}`;
    renderApp(<ExpandableText text={text} limit={240} />);
    const shown = screen.getByText(/^a+…$/);
    expect(isWellFormed(shown.textContent ?? '')).toBe(true);
    expect(shown.textContent).toBe(`${'a'.repeat(239)}…`);

    await user.click(screen.getByRole('button', { name: /Show all \d+ characters/ }));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('keeps an emoji that fits entirely before the limit', () => {
    const text = `${'a'.repeat(238)}${EMOJI}${'b'.repeat(60)}`;
    renderApp(<ExpandableText text={text} limit={240} />);
    expect(screen.getByText(`${'a'.repeat(238)}${EMOJI}…`)).toBeInTheDocument();
  });

  it('shows short text as is, without a control', () => {
    renderApp(<ExpandableText text={`short ${EMOJI}`} limit={240} />);
    expect(screen.getByText(`short ${EMOJI}`)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
