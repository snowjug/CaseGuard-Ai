import { AppError, ValidationFailedError } from '../errors';
import { TenantViolationError } from '../db/errors';

/**
 * Object storage for the redacted source payload of each case. Keys are
 * `<tenantId>/<caseId>/<sourceId>.json`; a store scoped to a tenant refuses every key that does not
 * start with that tenant's prefix, so one tenant can never read or write another tenant's objects.
 */

/** Characters allowed in an object key (before the extra structural rules below). */
export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9/_.-]{1,300}$/;

export const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;

const KEY_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const METADATA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const METADATA_VALUE = /^[\x20-\x7E]{0,512}$/;
const CONTENT_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]{1,100}\/[A-Za-z0-9!#$&^_.+-]{1,100}(\s*;\s*[ -~]{1,100})?$/;
const MAX_METADATA_ENTRIES = 16;

/** Suffix of the sidecar file the local store keeps next to each object. */
export const LOCAL_METADATA_SUFFIX = '.cgmeta';
/** Metadata name reserved for the content hash both stores record. */
export const SHA256_METADATA_NAME = 'cg_sha256';

export interface PutOptions {
  contentType: string;
  /** Up to 16 entries; names are letters/digits/underscore (stored lower-case), values printable ASCII. */
  metadata?: Record<string, string> | undefined;
  /** Replace an existing object with different content. Default false: stored sources are immutable. */
  overwrite?: boolean | undefined;
}

export interface PutResult {
  key: string;
  sizeBytes: number;
  sha256: string;
  /** False when an identical object already existed (a repeat put is idempotent). */
  created: boolean;
}

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string | null;
  metadata: Record<string, string>;
  sizeBytes: number;
  sha256: string;
}

export interface ObjectStoreHealth {
  ok: boolean;
  detail: string;
  latencyMs: number;
}

export interface ObjectStore {
  readonly kind: 'local' | 'azure-blob';
  put(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult>;
  /** Null when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /** True when an object was removed. */
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  health(): Promise<ObjectStoreHealth>;
}

export class ObjectTooLargeError extends AppError {
  constructor(limitBytes: number) {
    super('payload_too_large', 413, `The object exceeds the ${limitBytes} byte storage limit`);
  }
}

function invalidKey(reason: string): ValidationFailedError {
  return new ValidationFailedError('Invalid object key', [{ path: 'key', message: reason }]);
}

/** Validates an object key; never lets `..`, empty segments, hidden files or odd characters through. */
export function validateObjectKey(key: string): string {
  if (typeof key !== 'string' || !OBJECT_KEY_PATTERN.test(key)) {
    throw invalidKey('Keys may use letters, digits and / _ . - only, up to 300 characters');
  }
  if (key.includes('..')) throw invalidKey('Keys must not contain ".."');
  if (key.startsWith('/') || key.endsWith('/'))
    throw invalidKey('Keys must not start or end with "/"');
  for (const segment of key.split('/')) {
    if (segment.length === 0) throw invalidKey('Keys must not contain empty path segments');
    if (segment.startsWith('.')) throw invalidKey('Path segments must not start with "."');
  }
  if (key.endsWith(LOCAL_METADATA_SUFFIX))
    throw invalidKey(`Keys must not end with ${LOCAL_METADATA_SUFFIX}`);
  return key;
}

/** `<tenantId>/<caseId>/<sourceId>.json` */
export function buildObjectKey(parts: {
  tenantId: string;
  caseId: string;
  sourceId: string;
}): string {
  for (const [name, value] of Object.entries(parts)) {
    if (!KEY_PART.test(value) || value.includes('..')) {
      throw invalidKey(`${name} cannot be used inside an object key`);
    }
  }
  return validateObjectKey(`${parts.tenantId}/${parts.caseId}/${parts.sourceId}.json`);
}

/** The tenant segment of a key (validated first). */
export function tenantOfKey(key: string): string {
  const [tenant] = validateObjectKey(key).split('/');
  return tenant ?? '';
}

/**
 * Returns a view of `store` that only accepts keys under `<tenantId>/`. Every method validates the
 * key first, then checks the tenant prefix; a mismatch throws TenantViolationError and never reaches
 * the underlying store.
 */
export function scopeObjectStoreToTenant(store: ObjectStore, tenantId: string): ObjectStore {
  if (!KEY_PART.test(tenantId)) throw invalidKey('tenantId cannot be used inside an object key');
  const guard = (key: string): string => {
    const valid = validateObjectKey(key);
    if (tenantOfKey(valid) !== tenantId || !valid.startsWith(`${tenantId}/`)) {
      throw new TenantViolationError('The object key does not belong to the current tenant');
    }
    return valid;
  };
  // Async so that a refused key is always a rejected promise, never a synchronous throw.
  return {
    kind: store.kind,
    put: async (key, bytes, options) => store.put(guard(key), bytes, options),
    get: async (key) => store.get(guard(key)),
    delete: async (key) => store.delete(guard(key)),
    exists: async (key) => store.exists(guard(key)),
    health: () => store.health(),
  };
}

/** Validates and normalises put options; metadata names are stored lower-case (Azure lower-cases them). */
export function normalizePutOptions(options: PutOptions): {
  contentType: string;
  metadata: Record<string, string>;
} {
  if (!CONTENT_TYPE.test(options.contentType)) {
    throw new ValidationFailedError('Invalid content type', [
      { path: 'contentType', message: 'Expected a media type such as application/json' },
    ]);
  }
  const metadata: Record<string, string> = {};
  const entries = Object.entries(options.metadata ?? {});
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new ValidationFailedError('Too much object metadata', [
      { path: 'metadata', message: `At most ${MAX_METADATA_ENTRIES} entries` },
    ]);
  }
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!METADATA_NAME.test(name) || lower.startsWith('cg_')) {
      throw new ValidationFailedError('Invalid object metadata', [
        {
          path: `metadata.${name}`,
          message: 'Use letters, digits and underscores; "cg_" is reserved',
        },
      ]);
    }
    if (!METADATA_VALUE.test(value)) {
      throw new ValidationFailedError('Invalid object metadata', [
        {
          path: `metadata.${name}`,
          message: 'Values must be printable ASCII up to 512 characters',
        },
      ]);
    }
    metadata[lower] = value;
  }
  return { contentType: options.contentType, metadata };
}
