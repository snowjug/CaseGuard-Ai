'use client';

import type { AnalysisState, CaseDetail, Permission } from '@caseguard/schemas';
import { Button, ConfirmDialog, Tooltip, cg, useRestoreFocusTarget } from '@caseguard/ui';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
} from '@fluentui/react-components';
import { EllipsisIcon, PlayIcon, RefreshCwIcon, RotateCwIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { permissionDeniedReason, useSession } from '../../lib/auth/session';
import type { ReviewRun } from './AnalysisPanel';
import { DeleteCaseDialog } from './DeleteCaseButton';

const useStyles = makeStyles({
  popover: {
    padding: cg.space[1],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
  },
  danger: { color: cg.tone.unsupported.fg },
});

interface GatedItemProps {
  permission: Permission;
  icon: ReactElement;
  children: ReactNode;
  onClick: () => void;
  /** Unavailable for a reason other than the role, said in the tooltip. */
  blocked?: string | undefined;
  danger?: boolean;
}

/**
 * A menu item the role may not use stays in the menu, focusable and disabled, and says which permission it lacks: the
 * same rule as a gated button, so keyboard and screen-reader users find the explanation too.
 */
function GatedItem({
  permission,
  icon,
  children,
  onClick,
  blocked,
  danger = false,
}: GatedItemProps) {
  const styles = useStyles();
  const session = useSession();
  const allowed = session.can(permission);
  const why = allowed ? blocked : permissionDeniedReason(permission, session);
  const item = (
    <MenuItem
      icon={icon}
      disabled={why !== undefined}
      className={danger ? styles.danger : undefined}
      onClick={why === undefined ? onClick : undefined}
    >
      {children}
    </MenuItem>
  );
  return why === undefined ? (
    item
  ) : (
    <Tooltip content={why} side="start">
      {item}
    </Tooltip>
  );
}

/** What the run item of the menu is called and does, from where the review stands. */
function runItemFor(state: AnalysisState): { label: string; confirm: boolean } {
  if (state === 'analyzed') return { label: 'Re-run the review', confirm: true };
  if (state === 'failed') return { label: 'Retry the review', confirm: false };
  return { label: 'Run the review', confirm: false };
}

export interface CaseMenuProps {
  detail: CaseDetail;
  review: ReviewRun;
  /** Reads the case, its review and its structure again. */
  onRefresh: () => void;
  refreshing: boolean;
  onDeleted: () => void;
}

/**
 * The case's own management, out of the way: refresh, run or re-run the review, and delete. The record itself cannot be
 * edited. Re-running replaces the stored review and deleting removes the case, so both ask first, and each stays visible
 * but disabled, with the reason, for a role that may not do it.
 */
export function CaseMenu({ detail, review, onRefresh, refreshing, onDeleted }: CaseMenuProps) {
  const styles = useStyles();
  const restoreFocus = useRestoreFocusTarget();
  const [dialog, setDialog] = useState<'rerun' | 'delete' | null>(null);
  const run = runItemFor(detail.analysisState);
  const close = (next: boolean): void => {
    if (!next) setDialog(null);
  };

  return (
    <>
      <Menu positioning={{ position: 'below', align: 'end' }}>
        <MenuTrigger disableButtonEnhancement>
          <Button variant="secondary" icon={<EllipsisIcon />} {...restoreFocus}>
            Manage case
          </Button>
        </MenuTrigger>
        <MenuPopover className={styles.popover}>
          <MenuList>
            <MenuItem icon={<RefreshCwIcon />} disabled={refreshing} onClick={onRefresh}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </MenuItem>
            <GatedItem
              permission="case:analyze"
              icon={run.confirm ? <RotateCwIcon /> : <PlayIcon />}
              blocked={review.busy ? 'A review is already running for this case.' : undefined}
              onClick={run.confirm ? () => setDialog('rerun') : review.startPlain}
            >
              {run.label}
            </GatedItem>
            <MenuDivider />
            <GatedItem
              permission="case:delete"
              icon={<Trash2Icon />}
              danger
              onClick={() => setDialog('delete')}
            >
              Delete case
            </GatedItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <ConfirmDialog
        open={dialog === 'rerun'}
        onOpenChange={close}
        title="Re-run the review?"
        confirmLabel="Re-run"
        onConfirm={() => review.begin(true)}
      >
        This replaces the stored review with a fresh run of the same case, even though the input has
        not changed. Reviewer decisions on claims and what-if paths are carried forward where the
        result is unchanged.
      </ConfirmDialog>
      <DeleteCaseDialog
        open={dialog === 'delete'}
        onOpenChange={close}
        caseId={detail.id}
        reference={detail.reference}
        title={detail.title}
        onDeleted={onDeleted}
      />
    </>
  );
}
