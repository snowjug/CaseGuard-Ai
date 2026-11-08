'use client';

import { Badge, Button, ButtonLink, ConfirmDialog, Panel, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { LockIcon, RotateCcwIcon } from 'lucide-react';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateAll } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { explainDemoError } from '../../lib/presentation/demo-errors';
import { useToast } from '../../lib/toast';
import { PROVIDER_HELP, ProviderSection } from '../system/ProviderPanel';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  note: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
});

/** The demo-data reset (`demo.reset`): confirmed, administrator only, and refused by the API outside a synthetic demo tenant. */
function ResetPanel() {
  const styles = useStyles();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const reset = useApiMutation('demo.reset');
  const button = (
    <Button variant="secondary" icon={<RotateCcwIcon />} disabled={reset.isPending}>
      Reset demo data
    </Button>
  );
  return (
    <Panel
      title="Demo data reset"
      description="Erase the demo cases and start the demo story again."
      help="Resetting erases the cases, analysis results, skills and jobs of the synthetic demo tenant and clears demo progress. Users, settings and the audit trail stay, and the reset itself is audited. The API refuses it anywhere that is not a synthetic demo tenant."
    >
      <p className={styles.text}>
        Everything in this environment is demo data. Resetting is how a presenter returns to step 1;
        the Guided demo can also play the whole story back.
      </p>
      <div className={styles.actions}>
        {can('demo:manage') ? (
          <ConfirmDialog
            trigger={button}
            title="Reset the demo data?"
            tone="danger"
            confirmLabel="Reset demo"
            onConfirm={async () => {
              try {
                await reset.mutateAsync({});
              } catch (error) {
                throw explainDemoError(error, 'The reset failed.');
              }
              await invalidateAll(queryClient, auth.identityKey);
              toast.success('Demo data reset');
            }}
          >
            This erases the cases, analysis results, skills and jobs of this synthetic tenant and
            clears demo progress. It cannot be undone; the audit trail records that it happened.
          </ConfirmDialog>
        ) : (
          <GatedAction permission="demo:manage">{button}</GatedAction>
        )}
        <ButtonLink href="/demo" variant="ghost">
          Open the Guided demo
        </ButtonLink>
      </div>
    </Panel>
  );
}

/** Operations: the AI provider status (`system.provider`) and the demo-data reset. */
export function OperationsPanel() {
  const styles = useStyles();
  const { can } = useSession();
  const systemLink = (
    <ButtonLink href="/system" variant="ghost" size="sm">
      Open System status
    </ButtonLink>
  );
  return (
    <div className={styles.stack}>
      {can('telemetry:read') ? (
        <ProviderSection extraActions={systemLink} />
      ) : (
        <Panel title="AI provider" help={PROVIDER_HELP} actions={systemLink}>
          <div className={styles.note}>
            <Badge tone="neutral" icon={<LockIcon />}>
              No access
            </Badge>
            <p className={styles.text}>
              Your role cannot read system status (it needs the telemetry:read permission).
            </p>
          </div>
        </Panel>
      )}
      <ResetPanel />
    </div>
  );
}
