/**
 * Paths handed to pino's `redact` option. This is the cheap second net behind the scrubber (which
 * already redacts credential-named keys at any depth, case-insensitively): top-level credential
 * fields, the usual header locations, and one wildcard level for the core fields.
 *
 * pino has no "any depth" operator and every extra wildcard level adds roughly 60 microseconds
 * per log line (measured with the bundled @pinojs/redact), so deeper levels are left to the scrubber.
 */
const TOP_LEVEL_FIELDS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'clientSecret',
  'client_secret',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'apiKey',
  'api_key',
  'connectionString',
  'privateKey',
  'accountKey',
  'sharedAccessKey',
  'authorization',
  'cookie',
];

/** One wildcard level: `*.password` also covers `payload.password`, `body.token`, `config.apiKey`. */
const WILDCARD_FIELDS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apiKey',
  'connectionString',
  'authorization',
  'cookie',
];

/** Node and Fastify lower-case incoming header names. */
const HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'ocp-apim-subscription-key',
];

const HEADER_CONTAINERS: readonly string[] = [
  'headers',
  'req.headers',
  'res.headers',
  'request.headers',
  'response.headers',
];

const BODY_PATHS: readonly string[] = ['req.body', 'request.body', 'res.body', 'response.body'];

function buildRedactPaths(): readonly string[] {
  const paths = new Set<string>(TOP_LEVEL_FIELDS);
  for (const field of WILDCARD_FIELDS) paths.add(`*.${field}`);
  for (const container of HEADER_CONTAINERS) {
    for (const header of HEADER_NAMES) paths.add(`${container}["${header}"]`);
  }
  for (const path of BODY_PATHS) paths.add(path);
  return [...paths];
}

/** Immutable list of pino redact paths. */
export const PINO_REDACT_PATHS: readonly string[] = Object.freeze(buildRedactPaths());
