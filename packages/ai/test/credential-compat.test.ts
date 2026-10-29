import { describe, expect, it } from 'vitest';
import type { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '../src';

/**
 * Compile-time check (run by `tsc --noEmit`): the credentials from `@azure/identity` satisfy the
 * small injected `TokenCredential` interface, so the API layer can pass them straight in. Only
 * types are imported; no credential is created and nothing contacts a service.
 */
const accept = (credential: TokenCredential): TokenCredential => credential;
export const fromDefault = (credential: DefaultAzureCredential): TokenCredential =>
  accept(credential);
export const fromManagedIdentity = (credential: ManagedIdentityCredential): TokenCredential =>
  accept(credential);

describe('credential contract [NFR-SEC-03]', () => {
  it('[NFR-SEC-03] accepts any object with getToken(scope, { abortSignal }) and never needs a secret value', async () => {
    const credential: TokenCredential = {
      getToken: (scope, options) =>
        Promise.resolve(
          options?.abortSignal?.aborted
            ? null
            : { token: `token-for-${scope}`, expiresOnTimestamp: 1 },
        ),
    };
    await expect(accept(credential).getToken('scope-a')).resolves.toEqual({
      token: 'token-for-scope-a',
      expiresOnTimestamp: 1,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      credential.getToken('scope-a', { abortSignal: controller.signal }),
    ).resolves.toBeNull();
  });
});
