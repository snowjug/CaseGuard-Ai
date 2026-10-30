import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorInit } from '../../lib/api/errors';
import { explainExportRefusal, explainRoleRefusal } from './refusals';

const conflict = (init: Partial<ApiErrorInit> = {}) =>
  new ApiError({ status: 409, code: 'conflict', title: 'Conflict', ...init });

describe('[FR-GOV-40] a refused role change is explained by code and reason', () => {
  it('names Entra ID for entra_managed, and asks the session to reload', () => {
    const result = explainRoleRefusal(
      conflict({ reason: 'entra_managed', message: 'Unrelated words' }),
    );
    expect(result.text).toMatch(/Roles are managed in Microsoft Entra ID/);
    expect(result.text).not.toContain('Unrelated words');
    expect(result).toMatchObject({ entraManaged: true, stale: false });
  });

  it('explains last_administrator and changes nothing else', () => {
    const result = explainRoleRefusal(
      conflict({ reason: 'last_administrator', message: 'Unrelated words' }),
    );
    expect(result.text).toMatch(/must keep at least one active administrator/);
    expect(result.text).toMatch(/Nothing was changed\.$/);
    expect(result).toMatchObject({ entraManaged: false, stale: false });
  });

  it('treats the version_conflict code as a stale user and asks for the list to be reloaded', () => {
    const result = explainRoleRefusal(
      new ApiError({
        status: 409,
        code: 'version_conflict',
        title: 'Conflict',
        message: 'User was modified by someone else (expected version 1, found 2).',
      }),
    );
    expect(result.text).toMatch(/expected version 1, found 2\)\./);
    expect(result.text).toMatch(/open the user again/);
    expect(result.stale).toBe(true);
  });

  it('shows the API sentence for a conflict without a known reason', () => {
    expect(explainRoleRefusal(conflict({ message: 'Something else.' })).text).toBe(
      'Something else. Nothing was changed.',
    );
    expect(explainRoleRefusal(conflict({ reason: 'last_administrator' })).text).toMatch(
      /at least one active administrator/,
    );
  });

  it('only reads a reason on the code it belongs to', () => {
    const wrongCode = new ApiError({
      status: 403,
      code: 'forbidden',
      reason: 'entra_managed',
      title: 'Forbidden',
    });
    expect(explainRoleRefusal(wrongCode).text).toBe(
      'Your role does not allow this. Nothing was changed.',
    );
  });
});

describe('[FR-GOV-41] a refused export is explained by reason', () => {
  const asAdministrator = { cap: 5000, canChangeControls: true };
  const asReader = { cap: 5000, canChangeControls: false };
  const forbidden = (init: Partial<ApiErrorInit> = {}) =>
    new ApiError({ status: 403, code: 'forbidden', title: 'Forbidden', ...init });

  it.each([
    ['case_export_disabled', 'Case export', 'Allow case export'],
    ['audit_export_disabled', 'Audit export', 'Allow audit-log export'],
  ])(
    '%s says the export is switched off and points to the Export controls card, whatever the message says',
    (reason, kind, control) => {
      const result = explainExportRefusal(
        forbidden({ reason, message: 'Wording the UI must not depend on' }),
        asAdministrator,
      );
      expect(result.text).toBe(
        `${kind} is switched off in this workspace's export controls, so nothing was exported. If it should be allowed, switch on "${control}" in the Export controls card above.`,
      );
      expect(result.text).not.toContain('Wording the UI');
      // The page's copy of the controls said it was allowed, so it is out of date.
      expect(result.controlsChanged).toBe(true);
    },
  );

  it('sends a person who cannot change the controls to an administrator instead', () => {
    const result = explainExportRefusal(forbidden({ reason: 'audit_export_disabled' }), asReader);
    expect(result.text).toBe(
      "Audit export is switched off in this workspace's export controls, so nothing was exported. Ask an administrator, who can change the export controls.",
    );
    expect(result.text).not.toContain('Export controls card above');
  });

  it('only reads these reasons on a 403 forbidden', () => {
    const result = explainExportRefusal(
      conflict({ reason: 'audit_export_disabled', message: 'Some other conflict.' }),
      asAdministrator,
    );
    expect(result).toEqual({ text: 'Some other conflict.', controlsChanged: false });
  });

  it('tells the cap for record_cap_exceeded without needing the count in the message', () => {
    const result = explainExportRefusal(
      conflict({ reason: 'record_cap_exceeded', message: 'Wording the UI must not depend on' }),
      asAdministrator,
    );
    expect(result.text).toBe(
      'This export is larger than the 5,000 records the export controls allow, so nothing was exported. Raise "Most records per export" in the Export controls card above.',
    );
    expect(result.controlsChanged).toBe(false);
    expect(
      explainExportRefusal(conflict({ reason: 'record_cap_exceeded' }), asReader).text,
    ).toMatch(/Ask an administrator to raise the limit/);
  });

  it('shows the API sentence for a 403 without a reason (the role lacks export:data)', () => {
    const result = explainExportRefusal(
      forbidden({ message: 'You do not have permission to perform this action' }),
      asAdministrator,
    );
    expect(result).toEqual({
      text: 'You do not have permission to perform this action',
      controlsChanged: false,
    });
  });

  it('falls back to the plain explanation for everything else', () => {
    expect(
      explainExportRefusal(
        new ApiError({ status: 500, code: 'internal', title: 'Internal' }),
        asAdministrator,
      ).text,
    ).toMatch(/server had a problem/);
    expect(explainExportRefusal(new Error('boom'), asAdministrator).text).toBe(
      'The export failed.',
    );
  });
});
