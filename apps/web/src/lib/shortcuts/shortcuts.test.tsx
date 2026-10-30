import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { eventToken, formatKeys, isTypingTarget, matchSequence, parseKeys } from './keys';
import { KeyboardShortcutsProvider, useShortcut } from './index';

describe('[UX-KEYS-01] key matching', () => {
  it('normalises events to tokens', () => {
    expect(
      eventToken({ key: 'K', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
    ).toBe('mod+k');
    expect(
      eventToken({ key: 'k', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }),
    ).toBe('mod+k');
    expect(
      eventToken({ key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }),
    ).toBe('?');
    expect(
      eventToken({ key: 'g', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }),
    ).toBe('alt+g');
  });

  it('matches sequences as none, prefix or exact', () => {
    expect(matchSequence(['g'], parseKeys('g c'))).toBe('prefix');
    expect(matchSequence(['g', 'c'], parseKeys('g c'))).toBe('exact');
    expect(matchSequence(['g', 'x'], parseKeys('g c'))).toBe('none');
    expect(matchSequence(['g', 'c', 'd'], parseKeys('g c'))).toBe('none');
    expect(matchSequence([], parseKeys('g c'))).toBe('none');
  });

  it('formats for people, with the platform modifier', () => {
    expect(formatKeys('g c')).toBe('G then C');
    expect(formatKeys('mod+k')).toBe('Ctrl+K');
    expect(formatKeys('mod+k', true)).toBe('⌘K');
    expect(formatKeys('?')).toBe('?');
  });

  it('knows which elements are for typing', () => {
    const input = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});

function Probe({
  onGoCases,
  onSearch,
  onPalette,
  enabled = true,
}: {
  onGoCases: () => void;
  onSearch: () => void;
  onPalette: () => void;
  enabled?: boolean;
}) {
  useShortcut({
    id: 'go-cases',
    keys: 'g c',
    description: 'Go to Cases',
    group: 'Navigation',
    handler: onGoCases,
    enabled,
  });
  useShortcut({
    id: 'search',
    keys: '/',
    description: 'Search',
    group: 'General',
    handler: onSearch,
  });
  useShortcut({
    id: 'palette',
    keys: 'mod+k',
    description: 'Palette',
    group: 'General',
    handler: onPalette,
    allowInInput: true,
    allowInModal: true,
  });
  return <input aria-label="Name" />;
}

function setup(props: Partial<Parameters<typeof Probe>[0]> = {}) {
  const handlers = { onGoCases: vi.fn(), onSearch: vi.fn(), onPalette: vi.fn() };
  render(
    <KeyboardShortcutsProvider sequenceTimeoutMs={500}>
      <Probe {...handlers} {...props} />
    </KeyboardShortcutsProvider>,
  );
  return handlers;
}

describe('[UX-KEYS-02] KeyboardShortcutsProvider', () => {
  it('fires a g-then-c sequence, a single key and a modifier chord', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.keyboard('gc');
    expect(handlers.onGoCases).toHaveBeenCalledTimes(1);
    await user.keyboard('/');
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    await user.keyboard('{Control>}k{/Control}');
    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
  });

  it('abandons a sequence that is interrupted or times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const handlers = setup();
    await user.keyboard('gx');
    await user.keyboard('c');
    expect(handlers.onGoCases).not.toHaveBeenCalled();
    await user.keyboard('g');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await user.keyboard('c');
    expect(handlers.onGoCases).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not fire while typing in a field, except for shortcuts that opt in', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByLabelText('Name'));
    await user.keyboard('gc/');
    expect(handlers.onGoCases).not.toHaveBeenCalled();
    expect(handlers.onSearch).not.toHaveBeenCalled();
    await user.keyboard('{Control>}k{/Control}');
    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a modal dialog is open, except for shortcuts that opt in', async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    await user.keyboard('gc/');
    expect(handlers.onGoCases).not.toHaveBeenCalled();
    expect(handlers.onSearch).not.toHaveBeenCalled();
    await user.keyboard('{Control>}k{/Control}');
    expect(handlers.onPalette).toHaveBeenCalledTimes(1);
    dialog.remove();
  });

  it('skips disabled shortcuts', async () => {
    const user = userEvent.setup();
    const handlers = setup({ enabled: false });
    await user.keyboard('gc');
    expect(handlers.onGoCases).not.toHaveBeenCalled();
  });

  it('always calls the latest handler and stops listening after unmount', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(
      <KeyboardShortcutsProvider>
        <Probe onGoCases={first} onSearch={vi.fn()} onPalette={vi.fn()} />
      </KeyboardShortcutsProvider>,
    );
    rerender(
      <KeyboardShortcutsProvider>
        <Probe onGoCases={second} onSearch={vi.fn()} onPalette={vi.fn()} />
      </KeyboardShortcutsProvider>,
    );
    await user.keyboard('gc');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    await user.keyboard('gc');
    expect(second).toHaveBeenCalledTimes(1);
  });
});
