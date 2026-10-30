import { formatNumber } from '@caseguard/ui';
import { ApiError, describeError } from '../../lib/api/errors';
import { hasReason } from '../../lib/api/reason';
import { sentence } from './messages';

/** What a refused role change means for the dialog: the text to show, and what else to refresh. */
export interface RoleRefusal {
  text: string;
  /** The user was changed by someone else: the list must be reloaded. */
  stale: boolean;
  /** The API says roles come from Entra ID although the page thought otherwise: the session must be reloaded. */
  entraManaged: boolean;
}

/**
 * Explains a refused `governance.assignRoles` by its stable `code` and `reason`, never by the wording of the message:
 * `version_conflict` (someone else changed the user), `conflict` with `entra_managed` (roles come from Entra ID) or
 * `last_administrator` (a tenant must keep an active administrator). Anything else falls back to the API's sentence.
 */
export function explainRoleRefusal(error: unknown): RoleRefusal {
  if (error instanceof ApiError && error.code === 'version_conflict') {
    return {
      text: `${sentence(error.message)} The list has been refreshed; close this dialog and open the user again to see the latest roles.`,
      stale: true,
      entraManaged: false,
    };
  }
  if (hasReason(error, 'entra_managed', 'conflict')) {
    return {
      text: 'Roles are managed in Microsoft Entra ID, so CaseGuard cannot change them. Ask an Entra administrator to change the app role or group membership. Nothing was changed.',
      stale: false,
      entraManaged: true,
    };
  }
  if (hasReason(error, 'last_administrator', 'conflict')) {
    return {
      text: 'A tenant must keep at least one active administrator, so this change was refused. Give another active user the Administrator role first. Nothing was changed.',
      stale: false,
      entraManaged: false,
    };
  }
  return {
    text: `${sentence(describeError(error))} Nothing was changed.`,
    stale: false,
    entraManaged: false,
  };
}

export interface ExportRefusalOptions {
  /** The record cap of the export controls this page loaded. */
  cap: number;
  /** Whether this person may edit the export controls (`governance:write`). */
  canChangeControls: boolean;
}

/** What a refused export means for the dialog: the text to show, and whether the page's export controls are stale. */
export interface ExportRefusal {
  text: string;
  /** An export the controls this page shows allow is now forbidden: they changed since the page loaded, so reload them. */
  controlsChanged: boolean;
}

function switchedOff(kind: string, control: string, canChange: boolean): ExportRefusal {
  const next = canChange
    ? `If it should be allowed, switch on "${control}" in the Export controls card above.`
    : 'Ask an administrator, who can change the export controls.';
  return {
    text: `${kind} is switched off in this workspace's export controls, so nothing was exported. ${next}`,
    controlsChanged: true,
  };
}

/**
 * Explains a refused `governance.export` by its stable `code` and `reason`, never by the wording of the message:
 * `case_export_disabled` / `audit_export_disabled` (403: the export controls switch that kind of export off) and
 * `record_cap_exceeded` (409: more records than the controls allow; the cap is known here, the count is not needed).
 * Both point to the export controls when this person can change them. A 403 without a reason (the role lacks
 * `export:data`) and anything else fall back to the API's own sentence.
 */
export function explainExportRefusal(
  error: unknown,
  { cap, canChangeControls }: ExportRefusalOptions,
): ExportRefusal {
  if (hasReason(error, 'case_export_disabled', 'forbidden'))
    return switchedOff('Case export', 'Allow case export', canChangeControls);
  if (hasReason(error, 'audit_export_disabled', 'forbidden'))
    return switchedOff('Audit export', 'Allow audit-log export', canChangeControls);
  if (hasReason(error, 'record_cap_exceeded', 'conflict')) {
    const next = canChangeControls
      ? 'Raise "Most records per export" in the Export controls card above.'
      : 'Ask an administrator to raise the limit in the export controls.';
    return {
      text: `This export is larger than the ${formatNumber(cap)} records the export controls allow, so nothing was exported. ${next}`,
      controlsChanged: false,
    };
  }
  if (!(error instanceof ApiError)) return { text: 'The export failed.', controlsChanged: false };
  if (error.isForbidden && error.message) return { text: error.message, controlsChanged: false };
  return { text: describeError(error), controlsChanged: false };
}
