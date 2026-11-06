'use client';

import { ROLES, ROLE_LABELS, type Role, type User } from '@caseguard/schemas';
import {
  Button,
  EmptyState,
  Field,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  RelativeTime,
  Textarea,
  Tooltip,
  cg,
  useDialogClasses,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import {
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { UserCogIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { ResponsiveTable, StateBadge, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { useApiMutation, useApiQuery } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { explainRoleRefusal } from './refusals';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  cell: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  muted: { fontSize: tokens.fontSizeBase200, color: cg.textMuted, overflowWrap: 'anywhere' },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  roles: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    border: 'none',
  },
  legend: {
    padding: 0,
    marginBottom: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  alert: { margin: 0, color: cg.tone.unsupported.fg, fontSize: tokens.fontSizeBase300 },
  caption: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
});

const MIN_REASON = 5;

interface EditorProps {
  user: User;
  onClose: () => void;
}

/** Edit one user's roles. The change needs the user's current version (optimistic lock) and a reason, and is audited. */
function RoleEditor({ user, onClose }: EditorProps) {
  const styles = useStyles();
  const dialog = useDialogClasses('md');
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { session } = useSession();
  const assign = useApiMutation('governance.assignRoles', { invalidate: ['governance.users'] });
  const [roles, setRoles] = useState<readonly Role[]>(user.roles);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reasonShort = reason.trim().length < MIN_REASON;
  const unchanged = ROLES.every((role) => roles.includes(role) === user.roles.includes(role));
  const none = roles.length === 0;

  const save = async (): Promise<void> => {
    setTouched(true);
    if (reasonShort || none || unchanged) return;
    setFailure(null);
    try {
      await assign.mutateAsync({
        params: { userId: user.id },
        body: {
          roles: ROLES.filter((role) => roles.includes(role)),
          expectedVersion: user.version,
          reason: reason.trim(),
        },
      });
      if (session?.user.id === user.id) {
        await invalidateRoutes(queryClient, auth.identityKey, ['session.me']);
      }
      toast.success(`Roles updated for ${user.displayName}`);
      onClose();
    } catch (error) {
      const refusal = explainRoleRefusal(error);
      setFailure(refusal.text);
      if (refusal.stale) void invalidateRoutes(queryClient, auth.identityKey, ['governance.users']);
      if (refusal.entraManaged)
        void invalidateRoutes(queryClient, auth.identityKey, ['session.me']);
    }
  };

  return (
    <DialogBody className={dialog.body}>
      <DialogTitle className={dialog.title}>Change roles for {user.displayName}</DialogTitle>
      <DialogContent className={mergeClasses(dialog.content, styles.stack)}>
        <fieldset className={styles.roles}>
          <legend className={styles.legend}>Roles (at least one)</legend>
          {ROLES.map((role) => (
            <Checkbox
              key={role}
              label={ROLE_LABELS[role]}
              checked={roles.includes(role)}
              disabled={assign.isPending}
              onChange={(_event, data) =>
                setRoles((previous) =>
                  data.checked ? [...previous, role] : previous.filter((item) => item !== role),
                )
              }
            />
          ))}
        </fieldset>
        {none ? (
          <p role="alert" className={styles.alert}>
            Choose at least one role.
          </p>
        ) : null}
        <Field
          label="Reason"
          required
          hint="Required. The audit event records who changed which roles and when; this text is not copied into it."
          error={touched && reasonShort ? `Enter at least ${MIN_REASON} characters.` : undefined}
        >
          <Textarea
            value={reason}
            rows={3}
            maxLength={500}
            disabled={assign.isPending}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <p className={styles.caption}>
          A tenant must keep at least one active administrator; a change that would remove the last
          one is refused.
        </p>
        {failure ? (
          <div role="alert">
            <Notice variant="warning" title="Not changed">
              {failure}
            </Notice>
          </div>
        ) : null}
      </DialogContent>
      <DialogActions className={dialog.actions}>
        <Button variant="secondary" onClick={onClose} disabled={assign.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={assign.isPending}
          disabledFocusable={unchanged || none || assign.isPending}
          onClick={() => void save()}
        >
          Save roles
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

/** Users and role assignments (`governance.users`, `governance.assignRoles`). In Entra mode roles come from Entra and cannot be changed here. */
export function RolesPanel() {
  const styles = useStyles();
  const dialog = useDialogClasses('md');
  const auth = useAuth();
  const { session, can } = useSession();
  const [editing, setEditing] = useState<User | null>(null);
  const restoreFocus = useRestoreFocusTarget();
  const users = useApiQuery('governance.users', undefined, { enabled: auth.status === 'ready' });
  const entra = session?.authMode === 'entra';
  const manage = can('roles:manage') && !entra;

  if (users.isPending) return <LoadingSkeleton variant="table" count={5} label="Loading users" />;
  if (users.isError || !users.data) {
    return (
      <QueryErrorState
        error={users.error}
        subject="The user list"
        onRetry={() => void users.refetch()}
        retrying={users.isFetching}
      />
    );
  }

  const columns: ResponsiveColumn<User>[] = [
    {
      id: 'name',
      header: 'User',
      rowHeader: true,
      sortValue: (row) => row.displayName,
      cell: (row) => (
        <span className={styles.cell}>
          <strong>{row.displayName}</strong>
          <span className={styles.muted}>{row.email}</span>
        </span>
      ),
    },
    {
      id: 'roles',
      header: 'Roles',
      cell: (row) => row.roles.map((role) => ROLE_LABELS[role]).join(', '),
    },
    {
      id: 'status',
      header: 'Status',
      width: '112px',
      cell: (row) =>
        row.status === 'active' ? (
          <StateBadge status="productive" label="Active" title="Can sign in." />
        ) : (
          <StateBadge status="missing" label="Disabled" title="Cannot sign in." />
        ),
    },
    {
      id: 'synthetic',
      header: 'Data',
      width: '128px',
      cell: (row) =>
        row.synthetic ? <ProvenanceBadge kind="synthetic" /> : <span>Real account</span>,
    },
    {
      id: 'changed',
      header: 'Last changed',
      width: '144px',
      cell: (row) => (
        <span className={styles.cell}>
          <RelativeTime value={row.updatedAt} />
          <span className={styles.muted}>Version {row.version}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="cg-sr-only">Actions</span>,
      card: 'footer',
      width: '152px',
      cell: (row) => {
        if (entra) {
          return (
            <Tooltip content="Roles are managed in Microsoft Entra ID">
              <Button
                variant="secondary"
                size="sm"
                icon={<UserCogIcon />}
                disabledFocusable
                aria-label={`Change roles for ${row.displayName}`}
              >
                Change roles
              </Button>
            </Tooltip>
          );
        }
        const button = (
          <Button
            variant="secondary"
            size="sm"
            icon={<UserCogIcon />}
            aria-label={`Change roles for ${row.displayName}`}
            onClick={manage ? () => setEditing(row) : undefined}
            {...(manage ? restoreFocus : {})}
          >
            Change roles
          </Button>
        );
        return manage ? button : <GatedAction permission="roles:manage">{button}</GatedAction>;
      },
    },
  ];

  return (
    <div className={styles.stack}>
      {entra ? (
        <Notice variant="info" title="Roles are managed in Microsoft Entra ID">
          In this environment roles come from the token&apos;s claims, so CaseGuard cannot change
          them (the API answers 409). Ask an Entra administrator to change app-role or group
          membership. The list below is read-only.
        </Notice>
      ) : null}
      <Panel
        title="Users and roles"
        description="Who can do what in this tenant. Roles grant permissions; there is no ranking or scoring of people."
        help="A role is a bundle of permissions: engineers investigate, reviewers review and override with a reason, managers read analytics, curators run the skill lifecycle and administrators govern. A tenant must keep at least one active administrator. Every change is written to the audit trail."
      >
        {entra ? null : (
          <p className={styles.caption}>
            Development identity: roles are stored in CaseGuard and every change is audited with its
            reason. Users here are demo data.
          </p>
        )}
        {users.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<UsersIcon />}
            title="No users"
            description="The API returned no users for this tenant."
          />
        ) : (
          <ResponsiveTable
            caption="Users and their roles"
            minWidth={880}
            columns={columns}
            rows={users.data.items}
            getRowId={(row) => row.id}
            defaultSort={{ columnId: 'name', direction: 'ascending' }}
          />
        )}
      </Panel>
      <Dialog
        open={editing !== null}
        modalType="modal"
        onOpenChange={(_event, data) => {
          if (!data.open) setEditing(null);
        }}
      >
        <DialogSurface className={dialog.surface} backdrop={{ className: dialog.backdrop }}>
          {editing ? (
            <RoleEditor key={editing.id} user={editing} onClose={() => setEditing(null)} />
          ) : null}
        </DialogSurface>
      </Dialog>
    </div>
  );
}
