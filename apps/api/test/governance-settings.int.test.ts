import {
  DEFAULT_EXPORT_CONTROLS,
  DEFAULT_GOVERNANCE_VALUES,
  DEFAULT_REDACTION_CONFIG,
  GOVERNANCE_SECTIONS,
  GovernanceSettingsSchema,
  type AuditEvent,
} from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import {
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  resetTestDatabase,
  withFaultInjection,
  type FaultInjectingDatabase,
} from '../src/db/testing';
import { getGovernanceValue, getGovernanceValues } from '../src/services/governance';
import { API, NON_ADMINS, NOTE, auditEvents, ofAction, putSetting } from './governance-support';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

let database: Database;
let faulty: FaultInjectingDatabase;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  faulty = withFaultInjection(database);
  h = await createHarness({ database: faulty });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

beforeEach(async () => {
  faulty.disarm();
  await resetTestDatabase(database);
});

const put = (section: string, value: unknown, version: number, persona?: string) =>
  putSetting(h, section, value, version, persona);
const events = (tenantId: string = CONTOSO): Promise<AuditEvent[]> => auditEvents(h, tenantId);

describe('[FR-GV-01] governance.get', () => {
  it('returns every section at version 1 with the documented defaults', async () => {
    const res = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/governance/settings` });
    expect(res.statusCode).toBe(200);
    const settings = GovernanceSettingsSchema.parse(res.data);
    for (const section of GOVERNANCE_SECTIONS) {
      expect(settings[section].version).toBe(1);
      expect(settings[section].value).toEqual(DEFAULT_GOVERNANCE_VALUES[section]);
    }
  });

  it('[NFR-SEC-02] refuses callers without governance:read and records the refusal', async () => {
    for (const persona of NON_ADMINS) {
      const res = await h.call(persona, { method: 'GET', url: `${API}/governance/settings` });
      expect(res.statusCode).toBe(403);
      expect(res.data.code).toBe('forbidden');
    }
    const denied = ofAction(await events(), 'access.denied');
    expect(denied).toHaveLength(4);
    expect(denied[0]).toMatchObject({
      outcome: 'denied',
      targetId: 'governance.get',
      details: { requiredPermission: 'governance:read' },
    });
  });

  it('answers 401 without a credential', async () => {
    const res = await h.call(null, { method: 'GET', url: `${API}/governance/settings` });
    expect(res.statusCode).toBe(401);
    expect(res.data.code).toBe('unauthenticated');
  });
});

describe('[FR-GV-02] governance.update', () => {
  const next = { ...DEFAULT_EXPORT_CONTROLS, allowCaseExport: false, maxRecordsPerExport: 100 };

  it('stores the new version and audits changed keys only, in one step', async () => {
    const res = await put('export_controls', next, 1);
    expect(res.statusCode).toBe(200);
    const settings = GovernanceSettingsSchema.parse(res.data);
    expect(settings.export_controls).toMatchObject({
      version: 2,
      updatedBy: PERSONAS.admin,
      changeNote: NOTE,
      value: next,
    });
    expect(settings.model.version).toBe(1);

    const written = ofAction(await events(), 'governance.settings.updated');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: 'success',
      actorId: PERSONAS.admin,
      actorRole: 'administrator',
      targetType: 'governance_section',
      targetId: 'export_controls',
      details: {
        section: 'export_controls',
        fromVersion: 1,
        toVersion: 2,
        changedKeys: ['allowCaseExport', 'maxRecordsPerExport'],
      },
    });
    expect(Object.keys(written[0]?.details ?? {}).sort()).toEqual([
      'changedKeys',
      'fromVersion',
      'section',
      'toVersion',
    ]);
    expect(JSON.stringify(written[0]?.details)).not.toContain('100');
    // The handler audited, so the binder adds no generic record for this call.
    expect(ofAction(await events(), 'api.governance.update')).toHaveLength(0);

    const reread = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/governance/settings`,
    });
    expect(GovernanceSettingsSchema.parse(reread.data).export_controls.value).toEqual(next);
  });

  it('lets later services read the new value through the typed accessor', async () => {
    await put('export_controls', next, 1);
    const reader = { repos: h.repos(CONTOSO) };
    expect((await getGovernanceValue(reader, 'export_controls')).allowCaseExport).toBe(false);
    const values = await getGovernanceValues(reader);
    expect(values.export_controls.maxRecordsPerExport).toBe(100);
    expect(values.redaction).toEqual(DEFAULT_REDACTION_CONFIG);
  });

  it('accepts the default value of every section and versions each section on its own', async () => {
    for (const section of GOVERNANCE_SECTIONS) {
      const res = await put(section, DEFAULT_GOVERNANCE_VALUES[section], 1);
      expect(res.statusCode, section).toBe(200);
    }
    const settings = await h.repos(CONTOSO).governance.getSettings();
    for (const section of GOVERNANCE_SECTIONS) expect(settings[section].version).toBe(2);
    const written = ofAction(await events(), 'governance.settings.updated');
    expect(written).toHaveLength(GOVERNANCE_SECTIONS.length);
    // Saving an unchanged value is still a (recorded) new version, with nothing in `changedKeys`.
    for (const event of written) expect(event.details.changedKeys).toEqual([]);
  });

  it('records the changed paths of nested settings and of lists, never their values', async () => {
    const model = {
      ...DEFAULT_GOVERNANCE_VALUES.model,
      agentBudgets: {
        ...DEFAULT_GOVERNANCE_VALUES.model.agentBudgets,
        quality_judge: {
          ...DEFAULT_GOVERNANCE_VALUES.model.agentBudgets.quality_judge,
          maxRetries: 0,
        },
      },
      costLimits: { ...DEFAULT_GOVERNANCE_VALUES.model.costLimits, perDayUsd: 12.5 },
    };
    expect((await put('model', model, 1)).statusCode).toBe(200);

    const redaction = {
      ...DEFAULT_REDACTION_CONFIG,
      enabledCategories: DEFAULT_REDACTION_CONFIG.enabledCategories.filter(
        (category) => category !== 'phone_number',
      ),
    };
    expect((await put('redaction', redaction, 1)).statusCode).toBe(200);

    const trail = ofAction(await events(), 'governance.settings.updated');
    const changed = (section: string) =>
      trail.find((event) => event.details.section === section)?.details.changedKeys;
    expect(changed('model')).toEqual([
      'agentBudgets.quality_judge.maxRetries',
      'costLimits.perDayUsd',
    ]);
    expect(changed('redaction')).toEqual(['enabledCategories']);
    expect(JSON.stringify(trail)).not.toContain('phone_number');
    expect(JSON.stringify(trail)).not.toContain('12.5');
  });

  it('[NFR-REL-01] refuses a stale expected version with 409 and leaves no trace', async () => {
    expect((await put('export_controls', next, 1)).statusCode).toBe(200);
    const stale = await put('export_controls', { ...next, maxRecordsPerExport: 7 }, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    expect(stale.data.detail).toContain('expected version 1, found 2');

    const settings = await h.repos(CONTOSO).governance.getSettings();
    expect(settings.export_controls.version).toBe(2);
    expect(settings.export_controls.value.maxRecordsPerExport).toBe(100);
    expect(ofAction(await events(), 'governance.settings.updated')).toHaveLength(1);
  });

  it('reports every invalid field with its path (422) and changes nothing', async () => {
    const invalid = await put('export_controls', { ...next, maxRecordsPerExport: 0 }, 1);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.data.code).toBe('validation_failed');
    expect(invalid.data.errors.map((issue: { path: string }) => issue.path)).toEqual([
      'body.value.maxRecordsPerExport',
    ]);

    const typo = await put('export_controls', { ...next, maxRecordPerExport: 5 }, 1);
    expect(typo.statusCode).toBe(422);
    expect(typo.data.errors[0].path).toBe('body.value.maxRecordPerExport');

    const secretsOff = await put(
      'redaction',
      {
        ...DEFAULT_REDACTION_CONFIG,
        enabledCategories: DEFAULT_REDACTION_CONFIG.enabledCategories.filter(
          (category) => category !== 'private_key',
        ),
      },
      1,
    );
    expect(secretsOff.statusCode).toBe(422);
    expect(secretsOff.data.errors[0]).toMatchObject({ path: 'body.value.enabledCategories' });
    expect(secretsOff.data.errors[0].message).toContain('private_key');

    const noNote = await h.call(PERSONAS.admin, {
      method: 'PUT',
      url: `${API}/governance/settings/export_controls`,
      payload: { value: next, expectedVersion: 1, changeNote: '   ' },
    });
    expect(noNote.statusCode).toBe(422);
    expect(noNote.data.errors.map((issue: { path: string }) => issue.path)).toContain(
      'body.changeNote',
    );

    const unknownSection = await put('nonsense', next, 1);
    expect(unknownSection.statusCode).toBe(422);

    const settings = await h.repos(CONTOSO).governance.getSettings();
    expect(settings.export_controls.version).toBe(1);
    expect(ofAction(await events(), 'governance.settings.updated')).toHaveLength(0);
  });

  it('[NFR-REL-01] commits the setting and its audit event together or not at all', async () => {
    faulty.arm({ match: /INSERT INTO audit_events/i });
    const failed = await put('export_controls', next, 1);
    expect(failed.statusCode).toBe(500);
    expect(failed.data.code).toBe('internal');
    faulty.disarm();

    const settings = await h.repos(CONTOSO).governance.getSettings();
    expect(settings.export_controls.version).toBe(1);
    expect(settings.export_controls.value.allowCaseExport).toBe(true);
    expect(ofAction(await events(), 'governance.settings.updated')).toHaveLength(0);

    const retry = await put('export_controls', next, 1);
    expect(retry.statusCode).toBe(200);
  });

  it('[NFR-SEC-02] is limited to administrators', async () => {
    for (const persona of NON_ADMINS) {
      expect((await put('export_controls', next, 1, persona)).statusCode).toBe(403);
    }
    const anonymous = await h.call(null, {
      method: 'PUT',
      url: `${API}/governance/settings/export_controls`,
      payload: { value: next, expectedVersion: 1, changeNote: NOTE },
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await h.repos(CONTOSO).governance.getSettings()).export_controls.version).toBe(1);
  });

  it('[NFR-SEC-01] never touches another tenant’s configuration or audit trail', async () => {
    await h.repos(FABRIKAM).governance.updateUserRoles('user_fabi_engineer', ['administrator'], 1);
    expect((await put('export_controls', next, 1)).statusCode).toBe(200);

    const theirs = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/governance/settings`,
    });
    expect(theirs.statusCode).toBe(200);
    expect(GovernanceSettingsSchema.parse(theirs.data).export_controls).toMatchObject({
      version: 1,
      value: DEFAULT_EXPORT_CONTROLS,
    });

    const theirAudit = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/audit`,
    });
    expect(theirAudit.statusCode).toBe(200);
    for (const event of theirAudit.data.items as AuditEvent[]) {
      expect(event.tenantId).toBe(FABRIKAM);
      expect(event.action).not.toBe('governance.settings.updated');
    }
    expect(ofAction(await events(FABRIKAM), 'governance.settings.updated')).toHaveLength(0);
  });
});
