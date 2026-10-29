/** Shared constants and helpers for the schema-valid test builders. */

export const TENANT_A = 'tenant_contoso_support';
export const TENANT_B = 'tenant_fabrikam_lab';
export const ACTOR = 'user_ava_engineer';

/** Every builder timestamp is an offset from this instant (millisecond precision, UTC). */
export const T0 = '2026-01-15T09:00:00.000Z';

export function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

export function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** RecordMeta fields (tenant, timestamps, creator, version 1). */
export function meta(tenantId: string, stamp: string = T0, createdBy: string = ACTOR) {
  return { tenantId, createdAt: stamp, updatedAt: stamp, createdBy, version: 1 };
}
