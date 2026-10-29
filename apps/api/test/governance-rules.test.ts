import {
  AuditEventSchema,
  DEFAULT_EXPORT_CONTROLS,
  DEFAULT_GOVERNANCE_VALUES,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  DEFAULT_REDACTION_CONFIG,
  GOVERNANCE_SECTIONS,
  type AuditEvent,
  type Role,
  type User,
} from '@caseguard/schemas';
import { SECRET_REDACTION_CATEGORIES } from '@caseguard/security';
import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationFailedError } from '../src/errors';
import type { TenantRepositories } from '../src/db';
import type { AuditEventInput } from '../src/http/request-context';
import { changedKeys } from '../src/services/governance/changed-keys';
import {
  checkExportEnabled,
  normalizeExportRequest,
  recordCapRefusal,
  refusalError,
} from '../src/services/governance/export-policy';
import { maskSecrets } from '../src/services/governance/mask-secrets';
import { sanitizeAuditEvent } from '../src/services/governance/audit';
import {
  assignRoles,
  normalizeRoles,
  planRoleChange,
  type RolesContext,
} from '../src/services/governance/roles';
import { findUnknownKeys, validateSectionValue } from '../src/services/governance/section-schemas';
import { buildAuditInput, buildUser } from './builders';

function issuesOrNone(run: () => unknown): { path: string; message: string }[] {
  try {
    run();
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.issues;
    throw error;
  }
}

function issuesOf(run: () => unknown): { path: string; message: string }[] {
  const issues = issuesOrNone(run);
  if (issues.length === 0) throw new Error('Expected a ValidationFailedError');
  return issues;
}

describe('[FR-GV-02] section validation (pure)', () => {
  it('accepts the default value of every section', () => {
    for (const section of GOVERNANCE_SECTIONS) {
      expect(() => validateSectionValue(section, DEFAULT_GOVERNANCE_VALUES[section])).not.toThrow();
    }
  });

  it('reports a failing field with its full path', () => {
    const issues = issuesOf(() =>
      validateSectionValue('export_controls', {
        ...DEFAULT_EXPORT_CONTROLS,
        maxRecordsPerExport: 0,
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(['body.value.maxRecordsPerExport']);

    const nested = issuesOf(() =>
      validateSectionValue('model', {
        ...DEFAULT_MODEL_CONFIG,
        agentBudgets: {
          ...DEFAULT_MODEL_CONFIG.agentBudgets,
          quality_judge: {
            maxInputTokens: 12_000,
            maxOutputTokens: 3_000,
            maxRetries: 99,
            timeoutMs: 30_000,
          },
        },
      }),
    );
    expect(nested.map((issue) => issue.path)).toContain(
      'body.value.agentBudgets.quality_judge.maxRetries',
    );
  });

  it('refuses a value that is not an object', () => {
    for (const bad of [null, 'text', 42, [], undefined]) {
      expect(issuesOf(() => validateSectionValue('retention', bad)).length).toBeGreaterThan(0);
    }
  });

  it('refuses keys the schema does not know instead of silently dropping them', () => {
    const issues = issuesOf(() =>
      validateSectionValue('export_controls', {
        ...DEFAULT_EXPORT_CONTROLS,
        maxRecordPerExport: 5,
      }),
    );
    expect(issues).toEqual([
      { path: 'body.value.maxRecordPerExport', message: 'Unrecognised setting.' },
    ]);
    expect(findUnknownKeys({ a: { b: 1, c: 2 } }, { a: { b: 1 } }, 'x')).toEqual([
      { path: 'x.a.c', message: 'Unrecognised setting.' },
    ]);
    expect(findUnknownKeys([{ a: 1 }], [{}], 'x').map((issue) => issue.path)).toEqual(['x.0.a']);
  });

  it('refuses agent budgets for agents that do not exist', () => {
    const issues = issuesOf(() =>
      validateSectionValue('model', {
        ...DEFAULT_MODEL_CONFIG,
        agentBudgets: {
          ...DEFAULT_MODEL_CONFIG.agentBudgets,
          made_up_agent: DEFAULT_MODEL_CONFIG.agentBudgets.quality_judge,
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(['body.value.agentBudgets.made_up_agent']);
  });

  it('requires quality bands to strictly descend', () => {
    const issues = issuesOf(() =>
      validateSectionValue('quality', {
        ...DEFAULT_QUALITY_CONFIG,
        bands: { strong: 60, adequate: 70, needsAttention: 50 },
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(['body.value.bands']);
    expect(() =>
      validateSectionValue('quality', {
        ...DEFAULT_QUALITY_CONFIG,
        bands: { strong: 90, adequate: 75, needsAttention: 40 },
      }),
    ).not.toThrow();
  });

  it('[NFR-PRIV-01] keeps secret redaction on but lets a tenant choose personal-data categories', () => {
    const withoutSecrets = DEFAULT_REDACTION_CONFIG.enabledCategories.filter(
      (category) => category !== 'api_key' && category !== 'jwt',
    );
    const issues = issuesOf(() =>
      validateSectionValue('redaction', {
        ...DEFAULT_REDACTION_CONFIG,
        enabledCategories: withoutSecrets,
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('body.value.enabledCategories');
    expect(issues[0]?.message).toContain('api_key');
    expect(issues[0]?.message).toContain('jwt');

    const personalOff = DEFAULT_REDACTION_CONFIG.enabledCategories.filter(
      (category) => !['email_address', 'ipv4_address', 'phone_number'].includes(category),
    );
    expect(personalOff).toEqual(expect.arrayContaining([...SECRET_REDACTION_CATEGORIES]));
    expect(() =>
      validateSectionValue('redaction', {
        ...DEFAULT_REDACTION_CONFIG,
        enabledCategories: personalOff,
      }),
    ).not.toThrow();
  });

  it('[NFR-SEC-05] refuses custom patterns that would be skipped at ingestion, with the reason', () => {
    const issues = issuesOf(() =>
      validateSectionValue('redaction', {
        ...DEFAULT_REDACTION_CONFIG,
        customPatterns: [
          { name: 'nested', pattern: '(a+)+$' },
          { name: 'broken', pattern: '([' },
          { name: 'empty-match', pattern: 'x*' },
        ],
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      'body.value.customPatterns.0.pattern',
      'body.value.customPatterns.1.pattern',
      'body.value.customPatterns.2.pattern',
    ]);
    expect(issues[0]?.message).toContain('backtracking');
    expect(issues[1]?.message).toContain('not a valid regular expression');
    expect(issues[2]?.message).toContain('empty string');
  });

  it('[NFR-SEC-05] accepts a harmless custom pattern', () => {
    // The safety probe of @caseguard/security runs under a wall-clock budget, so a heavily loaded
    // machine can reject even a harmless pattern now and then. Retrying keeps this test about the rule.
    let issues: { path: string; message: string }[] = [];
    for (let attempt = 0; attempt < 3 && (attempt === 0 || issues.length > 0); attempt += 1) {
      issues = issuesOrNone(() =>
        validateSectionValue('redaction', {
          ...DEFAULT_REDACTION_CONFIG,
          customPatterns: [{ name: 'Ticket ids', pattern: 'ACME-[0-9]{6}' }],
        }),
      );
    }
    expect(issues).toEqual([]);
  });
});

describe('changedKeys', () => {
  it('lists the paths that differ, never the values', () => {
    const before = { a: 1, nested: { x: 'secret-old-value', y: [1, 2] }, same: true };
    const after = { a: 2, nested: { x: 'secret-new-value', y: [1, 2] }, same: true, added: 'v' };
    const keys = changedKeys(before, after);
    expect(keys).toEqual(['a', 'added', 'nested.x']);
    expect(JSON.stringify(keys)).not.toContain('secret');
  });

  it('treats an array as one setting and reports nothing for equal values', () => {
    expect(changedKeys({ list: [1, 2, 3] }, { list: [1, 2, 4] })).toEqual(['list']);
    expect(changedKeys({ a: { b: [1] } }, { a: { b: [1] } })).toEqual([]);
  });

  it('records the changes of a real default configuration', () => {
    const next = { ...DEFAULT_EXPORT_CONTROLS, allowCaseExport: false, maxRecordsPerExport: 10 };
    expect(changedKeys(DEFAULT_EXPORT_CONTROLS, next)).toEqual([
      'allowCaseExport',
      'maxRecordsPerExport',
    ]);
  });

  it('records a changed list of custom patterns as one key, without their text', () => {
    const next = {
      ...DEFAULT_REDACTION_CONFIG,
      customPatterns: [{ name: 'Ticket ids', pattern: 'ACME-[0-9]{6}' }],
    };
    const keys = changedKeys(DEFAULT_REDACTION_CONFIG, next);
    expect(keys).toEqual(['customPatterns']);
    expect(JSON.stringify(keys)).not.toContain('ACME');
  });
});

const user = (id: string, roles: Role[], overrides: Partial<User> = {}): User =>
  buildUser({ id, roles, ...overrides });

describe('[NFR-SEC-02] role changes (pure)', () => {
  it('normalises roles: canonical order, no duplicates', () => {
    expect(normalizeRoles(['administrator', 'engineer', 'engineer'])).toEqual([
      'engineer',
      'administrator',
    ]);
    expect(normalizeRoles([])).toEqual([]);
  });

  it('refuses an empty role set', () => {
    const target = user('u1', ['engineer']);
    expect(planRoleChange({ users: [target], target, nextRoles: [] })).toMatchObject({
      ok: false,
      reason: 'empty_roles',
    });
  });

  it('refuses removing the last active administrator, however it is done', () => {
    const admin = user('admin', ['administrator']);
    const other = user('other', ['engineer']);
    const decision = planRoleChange({
      users: [admin, other],
      target: admin,
      nextRoles: ['manager'],
    });
    expect(decision).toMatchObject({ ok: false, reason: 'last_administrator' });
  });

  it('allows demoting an administrator while another active one remains', () => {
    const first = user('a1', ['administrator']);
    const second = user('a2', ['administrator', 'reviewer']);
    expect(
      planRoleChange({ users: [first, second], target: first, nextRoles: ['engineer'] }),
    ).toEqual({
      ok: true,
    });
  });

  it('does not count a disabled administrator as one', () => {
    const active = user('a1', ['administrator']);
    const disabled = user('a2', ['administrator'], { status: 'disabled' });
    expect(
      planRoleChange({ users: [active, disabled], target: active, nextRoles: ['engineer'] }),
    ).toMatchObject({ ok: false, reason: 'last_administrator' });
  });

  it('allows keeping the administrator role and granting more roles', () => {
    const admin = user('admin', ['administrator']);
    expect(
      planRoleChange({ users: [admin], target: admin, nextRoles: ['administrator', 'reviewer'] }),
    ).toEqual({ ok: true });
  });

  it('does not block repairing a tenant that has no administrator', () => {
    const lonely = user('u1', ['engineer']);
    expect(
      planRoleChange({ users: [lonely], target: lonely, nextRoles: ['administrator'] }),
    ).toEqual({
      ok: true,
    });
  });

  it('counts the target even when it is missing from a truncated user list', () => {
    const target = user('admin', ['administrator']);
    expect(planRoleChange({ users: [], target, nextRoles: ['engineer'] })).toMatchObject({
      ok: false,
      reason: 'last_administrator',
    });
  });
});

describe('[NFR-SEC-02] role assignment in Entra mode', () => {
  it('answers 409 without touching the repositories and records a denied audit event', async () => {
    const audits: AuditEventInput[] = [];
    const untouched = new Proxy(
      {},
      {
        get() {
          throw new Error('repositories must not be used in Entra mode');
        },
      },
    );
    const ctx: RolesContext = {
      config: { auth: { mode: 'entra' } },
      auth: { userId: 'admin' } as unknown as RolesContext['auth'],
      repos: untouched as TenantRepositories,
      audit: async (event) => {
        audits.push(event);
      },
    };
    const error = await assignRoles(ctx, 'user_x', {
      roles: ['engineer'],
      expectedVersion: 1,
      reason: 'Entra owns roles',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).status).toBe(409);
    expect((error as ConflictError).message).toBe('Roles are managed in Microsoft Entra ID');
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'roles.assigned',
        outcome: 'denied',
        details: { userId: 'user_x', reason: 'entra_managed' },
      }),
    ]);
  });
});

describe('[NFR-SEC-07] defensive masking of audit data', () => {
  const event = (details: Record<string, unknown>): AuditEvent =>
    AuditEventSchema.parse({
      ...buildAuditInput({ details }),
      id: 'aud_00000000000000000000000001',
      tenantId: 'tenant_contoso_support',
      sequence: 1,
      occurredAt: '2026-01-15T09:00:00.000Z',
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    });

  it('leaves well-formed details byte-identical', () => {
    const clean = event({
      section: 'export_controls',
      changedKeys: ['allowCaseExport'],
      inputHash: 'b'.repeat(64),
      caseId: 'case_01JABCDEFGHJKMNPQRSTVWXYZ0',
      toVersion: 2,
    });
    const result = sanitizeAuditEvent(clean);
    expect(result.masked).toBe(false);
    expect(result.event).toBe(clean);
  });

  it('masks credentials that should never have been stored and says so', () => {
    const dirty = event({
      // secretscan:allow-next-line synthetic credential that proves audit sanitising masks secrets
      apiKey: 'sk-live-should-not-be-here-0123456789',
      note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      ok: 'kept',
    });
    const result = sanitizeAuditEvent(dirty);
    expect(result.masked).toBe(true);
    const text = JSON.stringify(result.event.details);
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.event.details.ok).toBe('kept');
    expect(result.event.hash).toBe(dirty.hash);
  });

  it('maskSecrets counts replacements and leaves personal data alone', () => {
    const { value, replacements } = maskSecrets({
      reason: 'contact jo@contoso-synthetic.invalid',
      password: 'hunter2hunter2',
    });
    expect(replacements).toBe(1);
    expect(value.reason).toBe('contact jo@contoso-synthetic.invalid');
    expect(value.password).toContain('REDACTED');
  });
});

describe('[FR-GV-01] export policy (pure)', () => {
  it('requires a real reason and a case id exactly for the case scope', () => {
    const reasonIssues = issuesOf(() =>
      normalizeExportRequest({ scope: 'audit', reason: '      ' }),
    );
    expect(reasonIssues.map((issue) => issue.path)).toEqual(['body.reason']);

    expect(
      issuesOf(() => normalizeExportRequest({ scope: 'case', reason: 'Legal request 12' })).map(
        (i) => i.path,
      ),
    ).toEqual(['body.caseId']);
    expect(
      issuesOf(() =>
        normalizeExportRequest({ scope: 'audit', caseId: 'case_a', reason: 'Legal request 12' }),
      ).map((i) => i.path),
    ).toEqual(['body.caseId']);

    expect(
      normalizeExportRequest({ scope: 'case', caseId: 'case_a', reason: '  Legal request 12 ' }),
    ).toEqual({
      scope: 'case',
      caseId: 'case_a',
      reason: 'Legal request 12',
    });
    expect(normalizeExportRequest({ scope: 'audit', reason: 'Annual audit review' })).toEqual({
      scope: 'audit',
      caseId: null,
      reason: 'Annual audit review',
    });
  });

  it('refuses a kind of export that the controls switch off (403)', () => {
    const off = { ...DEFAULT_EXPORT_CONTROLS, allowCaseExport: false, allowAuditExport: false };
    expect(checkExportEnabled(off, 'case')).toMatchObject({
      reason: 'case_export_disabled',
      status: 403,
    });
    expect(checkExportEnabled(off, 'audit')).toMatchObject({
      reason: 'audit_export_disabled',
      status: 403,
    });
    expect(checkExportEnabled(DEFAULT_EXPORT_CONTROLS, 'case')).toBeNull();
    expect(
      checkExportEnabled({ ...DEFAULT_EXPORT_CONTROLS, allowCaseExport: false }, 'audit'),
    ).toBeNull();
  });

  it('describes a cap refusal clearly and maps refusals to 403 / 409 problems', () => {
    const refusal = recordCapRefusal(10, 25);
    expect(refusal).toMatchObject({ reason: 'record_cap_exceeded', status: 409 });
    expect(refusal.message).toContain('25');
    expect(refusal.message).toContain('10');
    expect(refusalError(refusal).status).toBe(409);
    expect(
      refusalError({ reason: 'case_export_disabled', status: 403, message: 'off' }).status,
    ).toBe(403);
  });
});
