import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useOverlayState } from './use-overlay-state';

function Overlay() {
  const [open, setOpen] = useOverlayState();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      ) : null}
    </>
  );
}

/** A menu whose item opens the overlay and disappears with the menu, as the account menu's items do. */
function OverlayFromMenuItem({ withAccountButton }: { withAccountButton: boolean }) {
  const [open, setOpen] = useOverlayState();
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <>
      {withAccountButton ? (
        <button type="button" title="Account and settings">
          Account
        </button>
      ) : null}
      <main id="main-content" tabIndex={-1}>
        page
      </main>
      {menuOpen ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setMenuOpen(false);
          }}
        >
          Menu item
        </button>
      ) : null}
      {open ? (
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      ) : null}
    </>
  );
}

describe('[A11Y-FOCUS-01] an overlay gives focus back when it closes', () => {
  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Overlay />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus());
  });

  it('returns focus to the account button when the opener was a menu item that is gone', async () => {
    const user = userEvent.setup();
    render(<OverlayFromMenuItem withAccountButton />);
    await user.click(screen.getByRole('button', { name: 'Menu item' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus());
  });

  it('falls back to the main region when there is no account button, so focus is never left on the body', async () => {
    const user = userEvent.setup();
    render(<OverlayFromMenuItem withAccountButton={false} />);
    await user.click(screen.getByRole('button', { name: 'Menu item' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('leaves focus alone when it was opened with nothing focused (a shortcut on the bare page)', async () => {
    const holder: { set: ((open: boolean) => void) | null } = { set: null };
    function Probe() {
      const [open, setOpen] = useOverlayState();
      useEffect(() => {
        holder.set = setOpen;
      }, [setOpen]);
      return <p>{open ? 'open' : 'closed'}</p>;
    }
    render(
      <>
        <button type="button">Other</button>
        <Probe />
      </>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => holder.set?.(true));
    expect(screen.getByText('open')).toBeInTheDocument();
    act(() => holder.set?.(false));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(screen.getByText('closed')).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
});
