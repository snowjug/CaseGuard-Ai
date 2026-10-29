import { TenantIsolationError } from './errors';

/** Anything that belongs to a tenant: rows, DTOs, auth contexts. */
export interface TenantScopeLike {
  readonly tenantId: string;
}

/** `T` narrowed to records that carry a tenant id. */
export type TenantScoped<T> = T & TenantScopeLike;

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Throws `TenantIsolationError` unless `actual` is exactly `expected`. A missing value on either
 * side is a violation, so `undefined === undefined` can never let a record through.
 */
export function assertSameTenant(
  expected: string | null | undefined,
  actual: string | null | undefined,
): void {
  if (!isNonEmpty(expected) || !isNonEmpty(actual) || expected !== actual) {
    throw new TenantIsolationError(expected ?? null, actual ?? null);
  }
}

/** Asserts that every item in `items` belongs to `expected`; use after loading related records. */
export function assertAllSameTenant(
  expected: string | null | undefined,
  items: Iterable<TenantScopeLike>,
): void {
  for (const item of items) assertSameTenant(expected, item.tenantId);
}
