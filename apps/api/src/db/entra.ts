/**
 * Microsoft Entra authentication for Azure Database for PostgreSQL: a short-lived access token is
 * used as the connection password.
 *
 * STATUS: implemented and unit-tested against a fake token source only. It has NOT been validated
 * against a live Azure PostgreSQL server or a real managed identity.
 */
export const ENTRA_POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

export interface AccessToken {
  token: string;
  /** Epoch milliseconds at which the token stops being valid. */
  expiresOnTimestamp: number;
}

export interface AccessTokenSource {
  getToken(scope: string): Promise<AccessToken | null>;
}

const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Wraps a token source into the async `password` callback `pg` accepts. Tokens are cached until
 * shortly before expiry and concurrent connection attempts share one in-flight acquisition.
 */
export function createEntraPasswordProvider(
  source: AccessTokenSource,
  options: { now?: () => number; refreshSkewMs?: number } = {},
): () => Promise<string> {
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? REFRESH_SKEW_MS;
  let cached: AccessToken | null = null;
  let inflight: Promise<AccessToken> | null = null;

  const acquire = async (): Promise<AccessToken> => {
    const token = await source.getToken(ENTRA_POSTGRES_SCOPE);
    if (!token || token.token.length === 0) {
      throw new Error('Microsoft Entra did not return an access token for PostgreSQL');
    }
    cached = token;
    return token;
  };

  return async () => {
    if (cached && cached.expiresOnTimestamp - skew > now()) return cached.token;
    inflight ??= acquire().finally(() => {
      inflight = null;
    });
    return (await inflight).token;
  };
}

/** DefaultAzureCredential (managed identity in Azure, developer login locally), loaded lazily. */
export async function createDefaultEntraTokenSource(): Promise<AccessTokenSource> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const credential = new DefaultAzureCredential();
  return {
    async getToken(scope: string): Promise<AccessToken | null> {
      const token = await credential.getToken(scope);
      return token ? { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp } : null;
    },
  };
}
