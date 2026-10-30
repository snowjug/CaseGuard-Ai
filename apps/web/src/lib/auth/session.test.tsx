import { Button } from '@fluentui/react-components';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { ApiError } from '../api/errors';
import { Can, GatedAction, permissionDeniedReason, useSession } from './session';

function Probe() {
  const state = useSession();
  return (
    <ul>
      <li>loading:{String(state.isLoading)}</li>
      <li>ingest:{String(state.can('case:ingest'))}</li>
      <li>delete:{String(state.can('case:delete'))}</li>
      <li>roles:{state.roles.join(',')}</li>
    </ul>
  );
}

describe('[AUTH-CAN-01] useSession().can() is deny-by-default', () => {
  it('allows exactly the permissions in session.me', async () => {
    const api = fakeApi({ 'session.me': () => session('engineer', ['case:read', 'case:ingest']) });
    renderApp(<Probe />, { api });
    await waitFor(() => expect(screen.getByText('ingest:true')).toBeInTheDocument());
    expect(screen.getByText('delete:false')).toBeInTheDocument();
    expect(screen.getByText('roles:engineer')).toBeInTheDocument();
  });

  it('denies everything while loading, when nobody is signed in and when session.me fails', async () => {
    const pending = fakeApi({ 'session.me': () => new Promise(() => undefined) });
    const { unmount } = renderApp(<Probe />, { api: pending });
    expect(screen.getByText('loading:true')).toBeInTheDocument();
    expect(screen.getByText('ingest:false')).toBeInTheDocument();
    unmount();

    const signedOut = fakeApi({ 'session.me': () => session('administrator') });
    renderApp(<Probe />, { api: signedOut, persona: null });
    expect(screen.getByText('ingest:false')).toBeInTheDocument();
    expect(signedOut.call).not.toHaveBeenCalled();
  });

  it('denies everything when session.me fails', async () => {
    const failing = fakeApi({
      'session.me': () => {
        throw new ApiError({ status: 500, code: 'internal', title: 'Boom' });
      },
    });
    renderApp(<Probe />, { api: failing });
    await waitFor(() => expect(screen.getByText('loading:false')).toBeInTheDocument());
    expect(screen.getByText('ingest:false')).toBeInTheDocument();
  });
});

describe('[AUTH-CAN-02] gated actions explain themselves', () => {
  it('runs the action when the role has the permission', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { container } = renderApp(
      <GatedAction permission="case:ingest">
        <Button onClick={onDelete}>Load sample</Button>
      </GatedAction>,
      { api: fakeApi({ 'session.me': () => session('engineer', ['case:read', 'case:ingest']) }) },
    );
    // While permissions load the action is denied (deny by default); once known, the live button replaces it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load sample' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Load sample' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });

  it('keeps a denied action focusable, does not run it, and states why in a tooltip', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { container } = renderApp(
      <GatedAction permission="case:delete">
        <Button onClick={onDelete}>Delete case</Button>
      </GatedAction>,
      { api: fakeApi({ 'session.me': () => session('engineer', ['case:read']) }) },
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete case' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    const button = screen.getByRole('button', { name: 'Delete case' });
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /does not include the "case:delete" permission/,
    );
    await user.click(button);
    expect(onDelete).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('<Can> renders the fallback for a missing permission', async () => {
    renderApp(
      <Can permission="roles:manage" fallback={<span>Administrators only</span>}>
        <span>Manage roles</span>
      </Can>,
      { api: fakeApi({ 'session.me': () => session('engineer', ['case:read']) }) },
    );
    expect(await screen.findByText('Administrators only')).toBeInTheDocument();
    expect(screen.queryByText('Manage roles')).toBeNull();
  });

  it('words the reason for each situation', () => {
    const loaded = session('reviewer', ['case:read']);
    expect(
      permissionDeniedReason('case:delete', {
        isLoading: true,
        error: null,
        roles: [],
        session: undefined,
      }),
    ).toMatch(/Checking/);
    expect(
      permissionDeniedReason('case:delete', {
        isLoading: false,
        error: new ApiError({ status: 500, code: 'x', title: 'x' }),
        roles: [],
        session: undefined,
      }),
    ).toMatch(/could not be loaded/);
    expect(
      permissionDeniedReason('case:delete', {
        isLoading: false,
        error: null,
        roles: ['reviewer'],
        session: loaded,
      }),
    ).toBe('Your role (Support Quality Reviewer) does not include the "case:delete" permission.');
  });
});
