import type { RawEnv } from './raw-env';

/** Collects problems while building the configuration, so every problem is reported at once. */
export interface BuildContext {
  readonly raw: RawEnv;
  readonly env: 'local' | 'test' | 'development' | 'staging' | 'production';
  readonly localLike: boolean;
  readonly deployed: boolean;
  readonly production: boolean;
  fail(variable: string, message: string): void;
  warn(message: string): void;
}

/** True for a well-formed absolute URL using one of the given schemes. */
export function parseUrl(value: string, schemes: readonly string[]): URL | null {
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
