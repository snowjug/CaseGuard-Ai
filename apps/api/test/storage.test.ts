import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ConflictError, ValidationFailedError } from '../src/errors';
import { TenantViolationError } from '../src/db/errors';
import { sha256Hex } from '../src/db/hash';
import {
  AZURE_BLOB_VALIDATION_NOTE,
  AzureBlobObjectStore,
  LocalObjectStore,
  ObjectTooLargeError,
  buildObjectKey,
  createObjectStore,
  scopeObjectStoreToTenant,
  tenantOfKey,
  validateObjectKey,
  type BlobContainerLike,
  type BlockBlobLike,
  type ObjectStore,
} from '../src/storage';

const SCRATCH_ROOT = fileURLToPath(new URL('../.data/', import.meta.url));
const dirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH_ROOT, `${prefix}-`));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const KEY = 'tenant_contoso_support/case_alpha/src_alpha.json';
const JSON_TYPE = { contentType: 'application/json' };

describe('object keys', () => {
  it('accepts the tenant/case/source layout and builds keys from ids', () => {
    expect(validateObjectKey(KEY)).toBe(KEY);
    expect(
      buildObjectKey({ tenantId: 'tenant_a', caseId: 'case_01HZX', sourceId: 'src.1-b' }),
    ).toBe('tenant_a/case_01HZX/src.1-b.json');
    expect(tenantOfKey(KEY)).toBe('tenant_contoso_support');
  });

  it.each([
    '',
    '..',
    '../etc/passwd',
    'a/../b',
    'a/..',
    '/absolute/path',
    'a//b',
    'a/b/',
    'a/./b',
    './a',
    'a/.hidden/b',
    '.hidden',
    'a\\b',
    'C:\\Windows\\win.ini',
    'a b',
    'a/b?x=1',
    'a/%2e%2e/b',
    'ünï/code',
    'a/b.json.cgmeta',
    'x'.repeat(301),
    'tenant:one/case/src.json',
  ])('refuses the key %j', (key) => {
    expect(() => validateObjectKey(key)).toThrow(ValidationFailedError);
  });

  it('refuses ids that cannot be part of a key', () => {
    for (const bad of ['a/b', '..', '', 'x:y', '.hidden', 'a b']) {
      expect(() => buildObjectKey({ tenantId: 't', caseId: bad, sourceId: 's' })).toThrow(
        ValidationFailedError,
      );
    }
  });
});

describe('[NFR-SEC-01] tenant isolation at the storage layer', () => {
  function spyStore(): { store: ObjectStore; calls: string[] } {
    const calls: string[] = [];
    const record = (name: string) => (key: string) => {
      calls.push(`${name}:${key}`);
    };
    const store: ObjectStore = {
      kind: 'local',
      put: async (key) => {
        record('put')(key);
        return { key, sizeBytes: 0, sha256: '', created: true };
      },
      get: async (key) => {
        record('get')(key);
        return null;
      },
      delete: async (key) => {
        record('delete')(key);
        return false;
      },
      exists: async (key) => {
        record('exists')(key);
        return false;
      },
      health: async () => ({ ok: true, detail: 'ok', latencyMs: 0 }),
    };
    return { store, calls };
  }

  it('refuses keys whose tenant prefix does not match and never reaches the underlying store', async () => {
    const { store, calls } = spyStore();
    const scoped = scopeObjectStoreToTenant(store, 'tenant_a');
    const foreign = 'tenant_b/case_1/src_1.json';
    await expect(scoped.put(foreign, text('x'), JSON_TYPE)).rejects.toBeInstanceOf(
      TenantViolationError,
    );
    await expect(scoped.get(foreign)).rejects.toBeInstanceOf(TenantViolationError);
    await expect(scoped.delete(foreign)).rejects.toBeInstanceOf(TenantViolationError);
    await expect(scoped.exists(foreign)).rejects.toBeInstanceOf(TenantViolationError);
    // A longer tenant id that merely starts with the same characters is another tenant.
    await expect(scoped.get('tenant_a_evil/case_1/src_1.json')).rejects.toBeInstanceOf(
      TenantViolationError,
    );
    await expect(scoped.get('tenant_a')).rejects.toBeInstanceOf(TenantViolationError);
    expect(calls).toEqual([]);

    await scoped.put('tenant_a/case_1/src_1.json', text('x'), JSON_TYPE);
    await scoped.get('tenant_a/case_1/src_1.json');
    expect(calls).toEqual(['put:tenant_a/case_1/src_1.json', 'get:tenant_a/case_1/src_1.json']);
    // Malformed keys are rejected before the tenant comparison.
    await expect(scoped.get('tenant_a/../tenant_b/x.json')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it("one tenant cannot read another tenant's stored source through its scoped store", async () => {
    const root = await scratch('tenants');
    const store = new LocalObjectStore(root);
    const a = scopeObjectStoreToTenant(store, 'tenant_a');
    const b = scopeObjectStoreToTenant(store, 'tenant_b');
    await a.put('tenant_a/case_1/src_1.json', text('{"secret":"a"}'), JSON_TYPE);
    await expect(b.get('tenant_a/case_1/src_1.json')).rejects.toBeInstanceOf(TenantViolationError);
    expect((await a.get('tenant_a/case_1/src_1.json'))?.sizeBytes).toBe(14);
    expect(await b.exists('tenant_b/case_1/src_1.json')).toBe(false);
    expect(() => scopeObjectStoreToTenant(store, 'tenant/../b')).toThrow(ValidationFailedError);
  });
});

describe('LocalObjectStore', () => {
  it('round-trips bytes, content type and metadata, and is idempotent for identical content', async () => {
    const store = new LocalObjectStore(await scratch('local'));
    const bytes = text('{"synthetic":true}');
    const first = await store.put(KEY, bytes, {
      contentType: 'application/json',
      metadata: { Case_Id: 'case_alpha', source: 'bundle' },
    });
    expect(first).toEqual({
      key: KEY,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      created: true,
    });

    const stored = await store.get(KEY);
    expect(stored).toMatchObject({
      key: KEY,
      contentType: 'application/json',
      metadata: { case_id: 'case_alpha', source: 'bundle' },
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    expect(Buffer.from(stored?.bytes ?? []).toString('utf8')).toBe('{"synthetic":true}');
    expect(await store.exists(KEY)).toBe(true);
    expect(await store.put(KEY, bytes, JSON_TYPE)).toMatchObject({ created: false });
  });

  it('keeps stored sources immutable unless a replacement is explicitly requested', async () => {
    const store = new LocalObjectStore(await scratch('immutable'));
    await store.put(KEY, text('original'), JSON_TYPE);
    await expect(store.put(KEY, text('tampered'), JSON_TYPE)).rejects.toBeInstanceOf(ConflictError);
    expect(Buffer.from((await store.get(KEY))?.bytes ?? []).toString()).toBe('original');
    await store.put(KEY, text('replacement'), { ...JSON_TYPE, overwrite: true });
    expect(Buffer.from((await store.get(KEY))?.bytes ?? []).toString()).toBe('replacement');
  });

  it('deletes, reports missing objects and cleans up its sidecar', async () => {
    const root = await scratch('delete');
    const store = new LocalObjectStore(root);
    expect(await store.get(KEY)).toBeNull();
    expect(await store.exists(KEY)).toBe(false);
    expect(await store.delete(KEY)).toBe(false);
    await store.put(KEY, text('x'), JSON_TYPE);
    expect(await store.delete(KEY)).toBe(true);
    expect(await store.exists(KEY)).toBe(false);
    await expect(stat(join(root, ...KEY.split('/')) + '.cgmeta')).rejects.toBeDefined();
  });

  it('[NFR-SEC-05] path traversal attempts are refused and nothing is written outside the root', async () => {
    const base = await scratch('traversal');
    const root = join(base, 'objects');
    const store = new LocalObjectStore(root);
    for (const key of [
      '../escaped.json',
      'a/../../escaped.json',
      '/etc/passwd',
      'C:\\escaped.json',
      'a/..%2f..%2fescaped.json',
    ]) {
      await expect(store.put(key, text('x'), JSON_TYPE)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      await expect(store.get(key)).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(store.delete(key)).rejects.toBeInstanceOf(ValidationFailedError);
    }
    await expect(stat(join(base, 'escaped.json'))).rejects.toBeDefined();
  });

  it('enforces size limits and validates content type and metadata', async () => {
    const store = new LocalObjectStore(await scratch('limits'), { maxObjectBytes: 10 });
    await expect(store.put(KEY, text('12345678901'), JSON_TYPE)).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
    await expect(store.put(KEY, text('ok'), { contentType: 'not a type' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      store.put(KEY, text('ok'), { ...JSON_TYPE, metadata: { 'bad name': 'v' } }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      store.put(KEY, text('ok'), { ...JSON_TYPE, metadata: { cg_sha256: 'forged' } }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      store.put(KEY, text('ok'), { ...JSON_TYPE, metadata: { k: 'line\nbreak' } }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']));
    await expect(
      store.put(KEY, text('ok'), { ...JSON_TYPE, metadata: many }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await store.exists(KEY)).toBe(false);
  });

  it('survives a damaged sidecar and concurrent identical writes, and reports health', async () => {
    const root = await scratch('resilience');
    const store = new LocalObjectStore(root);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => store.put(KEY, text('same'), JSON_TYPE)),
    );
    expect(results.every((r) => r.sha256 === sha256Hex('same'))).toBe(true);
    await writeFile(join(root, ...KEY.split('/')) + '.cgmeta', '{not json', 'utf8');
    expect(await store.get(KEY)).toMatchObject({ contentType: null, metadata: {}, sizeBytes: 4 });
    expect(await readFile(join(root, ...KEY.split('/')), 'utf8')).toBe('same');

    expect(await store.health()).toMatchObject({ ok: true });
    const blocked = join(root, 'a-file');
    await writeFile(blocked, 'x');
    expect(await new LocalObjectStore(join(blocked, 'child')).health()).toMatchObject({
      ok: false,
    });
  });
});

/** Minimal in-memory stand-in for an Azure container: this is all the Azure store is tested against. */
class FakeContainer implements BlobContainerLike {
  readonly blobs = new Map<
    string,
    { bytes: Buffer; contentType: string | undefined; metadata: Record<string, string> }
  >();
  containerExists = true;
  failure: Error | null = null;
  readonly uploads: { name: string; conditions: unknown }[] = [];

  getBlockBlobClient(name: string): BlockBlobLike {
    return {
      uploadData: async (data, options) => {
        if (this.failure) throw this.failure;
        this.uploads.push({ name, conditions: options?.conditions });
        if (options?.conditions?.ifNoneMatch === '*' && this.blobs.has(name)) {
          throw Object.assign(new Error('The specified blob already exists.'), {
            statusCode: 409,
            code: 'BlobAlreadyExists',
          });
        }
        this.blobs.set(name, {
          bytes: Buffer.from(data),
          contentType: options?.blobHTTPHeaders?.blobContentType,
          metadata: { ...options?.metadata },
        });
        return {};
      },
      download: async () => {
        if (this.failure) throw this.failure;
        const blob = this.blobs.get(name);
        if (!blob)
          throw Object.assign(new Error('not found'), { statusCode: 404, code: 'BlobNotFound' });
        return {
          readableStreamBody: Readable.from([blob.bytes.subarray(0, 3), blob.bytes.subarray(3)]),
          contentType: blob.contentType,
          metadata: blob.metadata,
        };
      },
      exists: async () => this.blobs.has(name),
      deleteIfExists: async () => ({ succeeded: this.blobs.delete(name) }),
    };
  }
  async exists(): Promise<boolean> {
    if (this.failure) throw this.failure;
    return this.containerExists;
  }
}

describe('AzureBlobObjectStore (injected fake container; NOT validated against a live account or Azurite)', () => {
  it('states honestly what has and has not been validated', () => {
    expect(AZURE_BLOB_VALIDATION_NOTE).toMatch(/not against a live storage account or Azurite/);
  });

  it('round-trips an object, records the content hash and hides it from callers', async () => {
    const container = new FakeContainer();
    const store = new AzureBlobObjectStore(container);
    const bytes = text('{"synthetic":true}');
    expect(
      await store.put(KEY, bytes, {
        contentType: 'application/json',
        metadata: { Case_Id: 'case_alpha' },
      }),
    ).toEqual({
      key: KEY,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      created: true,
    });
    expect(container.blobs.get(KEY)?.metadata).toEqual({
      case_id: 'case_alpha',
      cg_sha256: sha256Hex(bytes),
    });
    expect(container.uploads[0]?.conditions).toEqual({ ifNoneMatch: '*' });

    const stored = await store.get(KEY);
    expect(stored).toMatchObject({
      contentType: 'application/json',
      metadata: { case_id: 'case_alpha' },
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    expect(Buffer.from(stored?.bytes ?? []).toString()).toBe('{"synthetic":true}');
    expect(await store.exists(KEY)).toBe(true);
    expect(await store.get('tenant_x/case/missing.json')).toBeNull();
  });

  it('is idempotent for identical content and refuses to replace different content', async () => {
    const container = new FakeContainer();
    const store = new AzureBlobObjectStore(container);
    await store.put(KEY, text('original'), JSON_TYPE);
    expect(await store.put(KEY, text('original'), JSON_TYPE)).toMatchObject({ created: false });
    await expect(store.put(KEY, text('tampered'), JSON_TYPE)).rejects.toBeInstanceOf(ConflictError);
    expect(container.blobs.get(KEY)?.bytes.toString()).toBe('original');

    await store.put(KEY, text('replacement'), { ...JSON_TYPE, overwrite: true });
    expect(container.uploads.at(-1)?.conditions).toBeUndefined();
    expect(container.blobs.get(KEY)?.bytes.toString()).toBe('replacement');
  });

  it('deletes, enforces key rules and size limits, and propagates unexpected failures', async () => {
    const container = new FakeContainer();
    const store = new AzureBlobObjectStore(container, { maxObjectBytes: 8 });
    await store.put(KEY, text('12345678'), JSON_TYPE);
    expect(await store.delete(KEY)).toBe(true);
    expect(await store.delete(KEY)).toBe(false);
    await expect(store.put(KEY, text('123456789'), JSON_TYPE)).rejects.toBeInstanceOf(
      ObjectTooLargeError,
    );
    await expect(store.get('../x')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(store.put('a/../b', text('x'), JSON_TYPE)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );

    // A blob larger than the limit is refused while reading, not buffered without bound.
    container.blobs.set(KEY, {
      bytes: Buffer.from('123456789012'),
      contentType: 'application/json',
      metadata: {},
    });
    await expect(store.get(KEY)).rejects.toBeInstanceOf(ObjectTooLargeError);

    container.failure = Object.assign(new Error('AuthorizationFailure'), { statusCode: 403 });
    await expect(store.put(KEY, text('x'), JSON_TYPE)).rejects.toThrow('AuthorizationFailure');
    await expect(store.get(KEY)).rejects.toThrow('AuthorizationFailure');
  });

  it('reports health without leaking details', async () => {
    const container = new FakeContainer();
    const store = new AzureBlobObjectStore(container);
    expect(await store.health()).toMatchObject({ ok: true });
    container.containerExists = false;
    expect(await store.health()).toMatchObject({
      ok: false,
      detail: expect.stringContaining('does not exist') as string,
    });
    container.failure = Object.assign(
      new Error('https://account.blob.core.windows.net?sig=SECRET'),
      { statusCode: 403 },
    );
    const failing = await store.health();
    expect(failing).toMatchObject({ ok: false, detail: 'Blob storage check failed (HTTP 403)' });
    expect(failing.detail).not.toContain('SECRET');
  });
});

describe('createObjectStore', () => {
  it('builds the local store and an Azure store from an injected container client', async () => {
    const local = await createObjectStore({
      provider: 'local',
      localDir: await scratch('factory'),
    });
    expect(local.kind).toBe('local');
    const azure = await createObjectStore({
      provider: 'azure-blob',
      account: 'cgstorage01',
      container: 'cases',
      containerClient: new FakeContainer(),
    });
    expect(azure.kind).toBe('azure-blob');
  });

  it('rejects unsafe or malformed Azure configuration (no connection strings, https only)', async () => {
    const base = { provider: 'azure-blob' as const, account: 'cgstorage01', container: 'cases' };
    await expect(
      createObjectStore({ ...base, account: 'DefaultEndpointsProtocol=https;AccountKey=abc' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(createObjectStore({ ...base, account: 'ab' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(createObjectStore({ ...base, container: 'Bad_Container' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      createObjectStore({ ...base, endpoint: 'http://insecure.example' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
