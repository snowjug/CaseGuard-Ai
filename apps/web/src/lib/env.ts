import { AuthModeSchema, type AuthMode } from '@caseguard/schemas';

/** How strictly API responses are checked against the route's Zod schema. */
export type ValidationMode = 'always' | 'sample' | 'off';

export interface PublicEnv {
  authMode: AuthMode;
  appEnv: string;
  entra: {
    clientId: string | undefined;
    authority: string | undefined;
    apiScope: string | undefined;
  };
  validateResponses: ValidationMode;
}

type Source = Record<string, string | undefined>;

const blank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Parses the browser-visible configuration. Pure (takes the source explicitly) so it can be unit tested; the app
 * passes literal `process.env.NEXT_PUBLIC_*` reads because Next inlines only those exact expressions.
 *
 * Response validation: always in development/test, off in production unless `NEXT_PUBLIC_API_VALIDATION` asks for
 * `sample` (about one response in ten, logged, never fatal) or `always`.
 */
export function readPublicEnv(source: Source): PublicEnv {
  const authMode = AuthModeSchema.catch('dev').parse(blank(source.NEXT_PUBLIC_AUTH_MODE) ?? 'dev');
  const production = source.NODE_ENV === 'production';
  const requested = blank(source.NEXT_PUBLIC_API_VALIDATION);
  const validateResponses: ValidationMode =
    requested === 'always' || requested === 'sample' || requested === 'off'
      ? requested
      : production
        ? 'off'
        : 'always';
  return {
    authMode,
    appEnv: blank(source.NEXT_PUBLIC_APP_ENV) ?? 'local',
    entra: {
      clientId: blank(source.NEXT_PUBLIC_ENTRA_CLIENT_ID),
      authority: blank(source.NEXT_PUBLIC_ENTRA_AUTHORITY),
      apiScope: blank(source.NEXT_PUBLIC_ENTRA_API_SCOPE),
    },
    validateResponses,
  };
}

export const publicEnv: PublicEnv = readPublicEnv({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE,
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_ENTRA_CLIENT_ID: process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID,
  NEXT_PUBLIC_ENTRA_AUTHORITY: process.env.NEXT_PUBLIC_ENTRA_AUTHORITY,
  NEXT_PUBLIC_ENTRA_API_SCOPE: process.env.NEXT_PUBLIC_ENTRA_API_SCOPE,
  NEXT_PUBLIC_API_VALIDATION: process.env.NEXT_PUBLIC_API_VALIDATION,
});
