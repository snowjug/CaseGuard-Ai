'use client';

import { ConfirmDialog, Notice, Panel, cg } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowResetRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { LinkButton } from '../../components/common/LinkButton';
import { ProviderStatusSection } from '../../components/system/ProviderStatus';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateAll } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { explainDemoError } from '../../lib/presentation/demo-errors';
import { useToast } from '../../lib/toast';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
});

/** The synthetic-data reset (`demo.reset`): confirmed, administrator only, and refused by the API outside a synthetic demo tenant. */
function ResetPanel() {
  const styles = useStyles();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const reset = useApiMutation('demo.reset');
  const button = (
    <Button appearance="outline" icon={<ArrowResetRegular />} disabled={reset.isPending}>
      Reset demo data
    </Button>
  );
  return (
    <Panel
      title="Synthetic-data reset"
      description="Erase the synthetic cases and start the demo story again."
      help="Resetting erases the cases, analysis results, skills and jobs of the synthetic demo tenant and clears demo progress. Users, governance settings and the audit trail stay, and the reset itself is audited. The API refuses it anywhere that is not a synthetic demo tenant."
    >
      <p className={styles.text}>
        Everything in this environment is synthetic. Resetting is how a presenter returns to step 1;
        the Demo Guide can also play the whole story back.
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
        <LinkButton href="/demo" appearance="subtle">
          Open the Demo Guide
        </LinkButton>
      </div>
    </Panel>
  );
}

/** Operations: the AI provider status (`system.provider`) and the synthetic-data reset. */
export function OperationsPanel() {
  const styles = useStyles();
  const { can } = useSession();
  return (
    <div className={styles.stack}>
      {can('telemetry:read') ? (
        <ProviderStatusSection />
      ) : (
        <Notice variant="info" title="AI provider status">
          Your role cannot read system status (it needs the telemetry:read permission).
        </Notice>
      )}
      <ResetPanel />
      <LinkButton href="/system" appearance="outline">
        Open System Health
      </LinkButton>
    </div>
  );
}
