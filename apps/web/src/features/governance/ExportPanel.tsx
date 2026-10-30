'use client';

import type { ExportControls, ExportResponse } from '@caseguard/schemas';
import { ConfirmDialog, Notice, Panel, cg, formatDateTimeUtc, formatNumber } from '@caseguard/ui';
import { Button, Field, Radio, RadioGroup, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownloadRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { CaseFilterSelect } from './CaseFilterSelect';
import { downloadJson } from './download';
import { explainExportRefusal } from './refusals';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: cg.space[3], maxWidth: '640px' },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
});

type Scope = 'case' | 'audit';

/**
 * Export (`governance.export`): case or audit data as a JSON file, guarded by the export controls above. The reason is
 * mandatory, the export is audited before any data is returned, and an export above the record cap is refused instead of
 * being cut short. A refusal is explained by the API's stable reason (`case_export_disabled`, `audit_export_disabled`,
 * `record_cap_exceeded`), pointing to the export controls above; when the reason says the controls changed after this
 * page loaded, they are reloaded so the switch and the notice above show the truth.
 */
export function ExportPanel({ controls }: { controls: ExportControls }) {
  const styles = useStyles();
  const toast = useToast();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const exportData = useApiMutation('governance.export');
  const [scope, setScope] = useState<Scope>('audit');
  const [caseId, setCaseId] = useState('');
  const [last, setLast] = useState<ExportResponse | null>(null);

  const allowed = can('export:data');
  const off = scope === 'case' ? !controls.allowCaseExport : !controls.allowAuditExport;
  const needsCase = scope === 'case' && caseId === '';
  const button = (
    <Button
      appearance="primary"
      icon={<ArrowDownloadRegular />}
      disabled={off || needsCase || exportData.isPending}
    >
      Export {scope === 'case' ? 'case data' : 'the audit log'}
    </Button>
  );

  const run = async (reason: string): Promise<void> => {
    try {
      const result = await exportData.mutateAsync({
        body: { scope, reason, ...(scope === 'case' ? { caseId } : {}) },
      });
      setLast(result);
      downloadJson(
        `caseguard-${result.scope}-export-${result.exportedAt.slice(0, 10)}.json`,
        result,
      );
      toast.success(
        `Exported ${result.recordCount} ${result.recordCount === 1 ? 'record' : 'records'}`,
      );
    } catch (error) {
      const refusal = explainExportRefusal(error, {
        cap: controls.maxRecordsPerExport,
        canChangeControls: can('governance:write'),
      });
      if (refusal.controlsChanged)
        void invalidateRoutes(queryClient, auth.identityKey, ['governance.get']);
      throw new Error(refusal.text);
    }
  };

  return (
    <Panel
      title="Export data"
      description="Download case or audit data as JSON. Guarded, audited and capped."
      help="An export needs the export permission and a reason, and it is written to the audit log before any data is returned. Case exports hold the redacted case record, its events, resolution and reviewer decisions. The audit export holds the hash chain so an auditor can verify it independently. Credentials are masked once more on the way out."
    >
      <div className={styles.form}>
        <Field label="What to export">
          <RadioGroup value={scope} onChange={(_event, data) => setScope(data.value as Scope)}>
            <Radio value="audit" label="The audit log (the whole hash chain)" />
            <Radio value="case" label="One case" />
          </RadioGroup>
        </Field>
        {scope === 'case' ? (
          <Field label="Case" required>
            <CaseFilterSelect value={caseId} emptyLabel="Choose a case" onChange={setCaseId} />
          </Field>
        ) : null}
        {off ? (
          <Notice variant="warning" compact title="Switched off">
            {scope === 'case' ? 'Case export' : 'Audit-log export'} is switched off in the export
            controls above, so the API would refuse it.
          </Notice>
        ) : null}
        <p className={styles.text}>
          At most {formatNumber(controls.maxRecordsPerExport)} records per export; a larger export
          is refused, never cut short.
        </p>
        <div>
          {allowed ? (
            <ConfirmDialog
              trigger={button}
              title={scope === 'case' ? 'Export this case?' : 'Export the audit log?'}
              confirmLabel="Export"
              reason={{ label: 'Reason for the export', minLength: 5, maxLength: 500 }}
              onConfirm={run}
            >
              The export is written to the audit log first, then downloaded as a JSON file. Treat
              the file as sensitive; it is not stored anywhere else.
            </ConfirmDialog>
          ) : (
            <GatedAction permission="export:data">{button}</GatedAction>
          )}
        </div>
        {last ? (
          <div role="status">
            <Notice variant="info" compact title="Last export">
              {formatNumber(last.recordCount)} {last.recordCount === 1 ? 'record' : 'records'} at{' '}
              {formatDateTimeUtc(last.exportedAt, { seconds: true })}. {last.notice}
            </Notice>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
