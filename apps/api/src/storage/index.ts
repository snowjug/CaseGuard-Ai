import { ValidationFailedError } from '../errors';
import { AzureBlobObjectStore, type BlobContainerLike } from './azure-blob-object-store';
import { LocalObjectStore } from './local-object-store';
import type { ObjectStore } from './object-store';

export {
  AZURE_BLOB_VALIDATION_NOTE,
  AzureBlobObjectStore,
  type BlobContainerLike,
  type BlockBlobLike,
} from './azure-blob-object-store';
export { LocalObjectStore } from './local-object-store';
export {
  OBJECT_KEY_PATTERN,
  ObjectTooLargeError,
  buildObjectKey,
  scopeObjectStoreToTenant,
  tenantOfKey,
  validateObjectKey,
  type ObjectStore,
  type ObjectStoreHealth,
  type PutOptions,
  type PutResult,
  type StoredObject,
} from './object-store';

export type ObjectStoreConfig =
  | { provider: 'local'; localDir: string; maxObjectBytes?: number | undefined }
  | {
      provider: 'azure-blob';
      /** Storage account name (3-24 lower-case letters and digits). */
      account: string;
      container: string;
      /** Override for sovereign clouds or private endpoints; must be https. */
      endpoint?: string | undefined;
      maxObjectBytes?: number | undefined;
      /** Test seam: a ready container client replaces credential and client creation. */
      containerClient?: BlobContainerLike | undefined;
    };

const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/;

/**
 * Builds the configured object store. Azure access always uses DefaultAzureCredential (managed
 * identity in Azure); there is no connection-string or account-key path. The Azure packages load
 * lazily so local development never pays for them.
 */
export async function createObjectStore(config: ObjectStoreConfig): Promise<ObjectStore> {
  if (config.provider === 'local') {
    return new LocalObjectStore(config.localDir, { maxObjectBytes: config.maxObjectBytes });
  }
  if (!ACCOUNT.test(config.account) || !CONTAINER.test(config.container)) {
    throw new ValidationFailedError('Invalid Azure Blob Storage configuration', [
      { path: 'storage', message: 'Check the storage account and container names' },
    ]);
  }
  if (config.containerClient) {
    return new AzureBlobObjectStore(config.containerClient, {
      maxObjectBytes: config.maxObjectBytes,
    });
  }
  const endpoint = config.endpoint ?? `https://${config.account}.blob.core.windows.net`;
  if (!endpoint.startsWith('https://')) {
    throw new ValidationFailedError('Invalid Azure Blob Storage configuration', [
      { path: 'endpoint', message: 'The blob endpoint must use https' },
    ]);
  }
  const [{ BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([
    import('@azure/storage-blob'),
    import('@azure/identity'),
  ]);
  const service = new BlobServiceClient(endpoint, new DefaultAzureCredential());
  return new AzureBlobObjectStore(service.getContainerClient(config.container), {
    maxObjectBytes: config.maxObjectBytes,
  });
}
