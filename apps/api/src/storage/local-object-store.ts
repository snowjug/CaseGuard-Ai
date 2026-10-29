import { randomBytes } from 'node:crypto';
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConflictError } from '../errors';
import { sha256Hex } from '../db/hash';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  LOCAL_METADATA_SUFFIX,
  ObjectTooLargeError,
  normalizePutOptions,
  validateObjectKey,
  type ObjectStore,
  type ObjectStoreHealth,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from './object-store';

interface Sidecar {
  contentType: string;
  metadata: Record<string, string>;
  sha256: string;
  sizeBytes: number;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Windows reports these when two renames (or a rename and a reader) hit the same file at once. */
function isContention(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isContention(error) || attempt >= 4) throw error;
      await delay(15 * (attempt + 1));
    }
  }
}

async function writeAtomically(path: string, data: Uint8Array | string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data);
    await renameWithRetry(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Directory-backed object store for local development and tests. A key maps to a file below the
 * root; the key rules (no `..`, no empty or hidden segments, restricted characters) plus a final
 * containment check keep every path inside the root.
 *
 * Notes: on case-insensitive file systems (Windows, macOS default) keys that differ only in case
 * address the same file, so tenant ids must be unique ignoring case. Put is create-only unless
 * `overwrite` is set; two concurrent first writes of DIFFERENT content for one key are not detected
 * (the later rename wins), which is acceptable for a development store with unique source keys.
 */
export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly maxObjectBytes: number;

  constructor(rootDir: string, options: { maxObjectBytes?: number } = {}) {
    this.root = resolve(rootDir);
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  private pathFor(key: string): string {
    const full = resolve(this.root, ...validateObjectKey(key).split('/'));
    const relation = relative(this.root, full);
    if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
      throw new Error('Resolved object path escapes the storage root');
    }
    return full;
  }

  private async readSidecar(path: string): Promise<Sidecar | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(`${path}${LOCAL_METADATA_SUFFIX}`, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.contentType !== 'string' || typeof record.sha256 !== 'string') return null;
      return {
        contentType: record.contentType,
        metadata:
          typeof record.metadata === 'object' && record.metadata !== null
            ? (record.metadata as Record<string, string>)
            : {},
        sha256: record.sha256,
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
      };
    } catch {
      // A missing, unreadable or corrupt sidecar only loses the content type and metadata; the
      // object bytes (and their recomputed hash) stay authoritative.
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult> {
    const path = this.pathFor(key);
    const { contentType, metadata } = normalizePutOptions(options);
    if (bytes.byteLength > this.maxObjectBytes) throw new ObjectTooLargeError(this.maxObjectBytes);
    const sha256 = sha256Hex(bytes);

    const existing = await this.statOrNull(path);
    if (existing) {
      const current = sha256Hex(await readFile(path));
      if (current === sha256) return { key, sizeBytes: bytes.byteLength, sha256, created: false };
      if (!options.overwrite) {
        throw new ConflictError('An object with different content already exists for this key');
      }
    }
    await mkdir(dirname(path), { recursive: true });
    const sidecar: Sidecar = { contentType, metadata, sha256, sizeBytes: bytes.byteLength };
    try {
      await writeAtomically(path, bytes);
    } catch (error) {
      // Two writers racing on one key: if the winner stored identical content this put is a repeat.
      if (isContention(error) && (await this.matches(path, sha256))) {
        return { key, sizeBytes: bytes.byteLength, sha256, created: false };
      }
      throw error;
    }
    await writeAtomically(`${path}${LOCAL_METADATA_SUFFIX}`, JSON.stringify(sidecar));
    return { key, sizeBytes: bytes.byteLength, sha256, created: true };
  }

  private async matches(path: string, sha256: string): Promise<boolean> {
    try {
      return sha256Hex(await readFile(path)) === sha256;
    } catch (error) {
      if (isMissing(error) || isContention(error)) return false;
      throw error;
    }
  }

  private async statOrNull(path: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(path);
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const sidecar = await this.readSidecar(path);
    return {
      key,
      bytes: new Uint8Array(bytes),
      contentType: sidecar?.contentType ?? null,
      metadata: sidecar?.metadata ?? {},
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    let removed = false;
    try {
      await unlink(path);
      removed = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await unlink(`${path}${LOCAL_METADATA_SUFFIX}`).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.statOrNull(this.pathFor(key))) !== null;
  }

  async health(): Promise<ObjectStoreHealth> {
    const started = performance.now();
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK);
      return {
        ok: true,
        detail: 'Local object directory is writable',
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      return {
        ok: false,
        detail: `Local object directory is not writable${typeof code === 'string' ? ` (${code})` : ''}`,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      };
    }
  }
}
