import { ConflictError } from '../errors';
import { sha256Hex } from '../db/hash';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  ObjectTooLargeError,
  SHA256_METADATA_NAME,
  normalizePutOptions,
  validateObjectKey,
  type ObjectStore,
  type ObjectStoreHealth,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from './object-store';

/**
 * Azure Blob Storage object store.
 *
 * VALIDATION STATUS: unit-tested against an injected fake container client only. It has NOT been run
 * against a live storage account or Azurite. Authentication is Microsoft Entra only (managed identity
 * or developer sign-in through DefaultAzureCredential): connection strings and account keys are
 * deliberately not supported.
 */
export const AZURE_BLOB_VALIDATION_NOTE =
  'Implemented with the Azure SDK and Microsoft Entra authentication; validated against a local fake ' +
  'client only, not against a live storage account or Azurite.';

/** The slice of a block blob client this store uses (the real SDK client satisfies it). */
export interface BlockBlobLike {
  uploadData(
    data: Buffer,
    options?: {
      blobHTTPHeaders?: { blobContentType?: string };
      metadata?: Record<string, string>;
      conditions?: { ifNoneMatch?: string };
    },
  ): Promise<unknown>;
  download(): Promise<{
    readableStreamBody?: NodeJS.ReadableStream | undefined;
    contentType?: string | undefined;
    metadata?: Record<string, string> | undefined;
  }>;
  exists(): Promise<boolean>;
  deleteIfExists(): Promise<{ succeeded: boolean }>;
}

export interface BlobContainerLike {
  getBlockBlobClient(blobName: string): BlockBlobLike;
  exists(): Promise<boolean>;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { statusCode?: unknown };
  return typeof record.statusCode === 'number' ? record.statusCode : null;
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown };
  return typeof record.code === 'string' ? record.code : null;
}

async function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > limit) throw new ObjectTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class AzureBlobObjectStore implements ObjectStore {
  readonly kind = 'azure-blob' as const;
  private readonly maxObjectBytes: number;

  constructor(
    private readonly container: BlobContainerLike,
    options: { maxObjectBytes?: number } = {},
  ) {
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult> {
    const name = validateObjectKey(key);
    const { contentType, metadata } = normalizePutOptions(options);
    if (bytes.byteLength > this.maxObjectBytes) throw new ObjectTooLargeError(this.maxObjectBytes);
    const sha256 = sha256Hex(bytes);
    const blob = this.container.getBlockBlobClient(name);
    try {
      await blob.uploadData(Buffer.from(bytes), {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: { ...metadata, [SHA256_METADATA_NAME]: sha256 },
        // Create-only unless the caller opted into replacing: stored sources are immutable.
        ...(options.overwrite ? {} : { conditions: { ifNoneMatch: '*' } }),
      });
      return { key, sizeBytes: bytes.byteLength, sha256, created: true };
    } catch (error) {
      const alreadyExists =
        statusOf(error) === 409 || statusOf(error) === 412 || codeOf(error) === 'BlobAlreadyExists';
      if (!alreadyExists) throw error;
      const current = await this.get(name);
      if (current?.sha256 === sha256)
        return { key, sizeBytes: bytes.byteLength, sha256, created: false };
      throw new ConflictError('An object with different content already exists for this key');
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const name = validateObjectKey(key);
    try {
      const response = await this.container.getBlockBlobClient(name).download();
      if (!response.readableStreamBody) return null;
      const bytes = await readAll(response.readableStreamBody, this.maxObjectBytes);
      const { [SHA256_METADATA_NAME]: recorded, ...metadata } = response.metadata ?? {};
      void recorded;
      return {
        key: name,
        bytes: new Uint8Array(bytes),
        contentType: response.contentType ?? null,
        metadata,
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    } catch (error) {
      if (statusOf(error) === 404 || codeOf(error) === 'BlobNotFound') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.container.getBlockBlobClient(validateObjectKey(key)).deleteIfExists();
    return result.succeeded;
  }

  async exists(key: string): Promise<boolean> {
    return this.container.getBlockBlobClient(validateObjectKey(key)).exists();
  }

  async health(): Promise<ObjectStoreHealth> {
    const started = performance.now();
    const latency = (): number => Math.round((performance.now() - started) * 100) / 100;
    try {
      const present = await this.container.exists();
      return present
        ? { ok: true, detail: 'Blob container reachable', latencyMs: latency() }
        : {
            ok: false,
            detail: 'Blob container does not exist or is not accessible',
            latencyMs: latency(),
          };
    } catch (error) {
      const status = statusOf(error);
      return {
        ok: false,
        detail: `Blob storage check failed${status === null ? '' : ` (HTTP ${status})`}`,
        latencyMs: latency(),
      };
    }
  }
}
