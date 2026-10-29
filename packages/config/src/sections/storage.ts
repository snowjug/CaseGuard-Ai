import { type BuildContext, parseUrl } from '../context';
import type { SearchConfig, StorageConfig } from '../types';

const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const BLOB_CONTAINER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/;

/** Object storage. Deployed environments must use Azure Blob: a container filesystem is ephemeral. */
export function buildStorage(ctx: BuildContext): StorageConfig {
  const { raw } = ctx;
  const provider = raw.STORAGE_PROVIDER ?? 'local';

  if (provider === 'local') {
    if (ctx.deployed) {
      ctx.fail('STORAGE_PROVIDER', "must be 'azure-blob' when APP_ENV is staging or production");
    }
    return { provider: 'local', localDir: raw.STORAGE_LOCAL_DIR ?? '.data/objects' };
  }

  const account = raw.AZURE_STORAGE_ACCOUNT;
  if (account === undefined || !STORAGE_ACCOUNT.test(account)) {
    ctx.fail(
      'AZURE_STORAGE_ACCOUNT',
      'is required for azure-blob: 3-24 lowercase letters and digits',
    );
  }
  const container = raw.AZURE_STORAGE_CONTAINER ?? 'cases';
  if (!BLOB_CONTAINER.test(container)) {
    ctx.fail('AZURE_STORAGE_CONTAINER', 'must be 3-63 lowercase letters, digits or single hyphens');
  }
  return { provider: 'azure-blob', account: account ?? '', container };
}

export function buildSearch(ctx: BuildContext): SearchConfig {
  const { raw } = ctx;
  const provider = raw.SEARCH_PROVIDER ?? 'lexical';
  if (provider === 'lexical') return { provider: 'lexical' };

  const endpoint = raw.AZURE_SEARCH_ENDPOINT;
  if (endpoint === undefined || !parseUrl(endpoint, ['https:'])) {
    ctx.fail('AZURE_SEARCH_ENDPOINT', 'is required for azure-ai-search and must be an https URL');
  }
  return {
    provider: 'azure-ai-search',
    endpoint: endpoint ?? '',
    index: raw.AZURE_SEARCH_INDEX ?? 'caseguard',
  };
}
