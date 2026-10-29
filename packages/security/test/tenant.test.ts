import { describe, expect, it } from 'vitest';
import { TenantIsolationError } from '../src/errors';
import { assertAllSameTenant, assertSameTenant } from '../src/tenant';

describe('assertSameTenant', () => {
  it('accepts identical tenant ids', () => {
    expect(() =>
      assertSameTenant('tenant_contoso_support', 'tenant_contoso_support'),
    ).not.toThrow();
  });

  it('[NFR-SEC-01] throws TenantIsolationError (403) across tenants without leaking ids', () => {
    let caught: unknown;
    try {
      assertSameTenant('tenant_contoso_support', 'tenant_fabrikam_lab');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TenantIsolationError);
    const error = caught as TenantIsolationError;
    expect(error.status).toBe(403);
    expect(error.code).toBe('tenant_violation');
    expect(error.message).not.toContain('fabrikam');
    expect(JSON.stringify(error)).not.toContain('fabrikam');
    expect(Object.keys(error)).not.toContain('actualTenantId');
    // Still available to server-side logging.
    expect(error.actualTenantId).toBe('tenant_fabrikam_lab');
  });

  it('[NFR-SEC-01] treats a missing tenant on either side as a violation', () => {
    for (const [expected, actual] of [
      [undefined, undefined],
      [null, null],
      ['', ''],
      ['tenant_a', undefined],
      [undefined, 'tenant_a'],
      ['tenant_a', ''],
    ] as const) {
      expect(
        () => assertSameTenant(expected, actual),
        `${String(expected)}/${String(actual)}`,
      ).toThrow(TenantIsolationError);
    }
  });

  it('is case sensitive', () => {
    expect(() => assertSameTenant('tenant_a', 'TENANT_A')).toThrow(TenantIsolationError);
  });
});

describe('assertAllSameTenant', () => {
  it('passes for homogeneous collections and empty ones', () => {
    expect(() => assertAllSameTenant('t1', [{ tenantId: 't1' }, { tenantId: 't1' }])).not.toThrow();
    expect(() => assertAllSameTenant('t1', [])).not.toThrow();
  });

  it('[NFR-SEC-01] fails if any item belongs to another tenant', () => {
    expect(() => assertAllSameTenant('t1', [{ tenantId: 't1' }, { tenantId: 't2' }])).toThrow(
      TenantIsolationError,
    );
  });
});
