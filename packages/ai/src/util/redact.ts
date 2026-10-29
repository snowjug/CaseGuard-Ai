interface SecretRule {
  name: string;
  pattern: RegExp;
}

/** Common secret shapes. Deliberately conservative: anything it masks is never needed for analysis. */
const SECRET_RULES: readonly SecretRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/gi },
  {
    name: 'azure_storage_key',
    pattern:
      /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*[A-Za-z0-9+/=%&;_-]{8,}/gi,
  },
  {
    name: 'connection_string',
    pattern:
      /\b(?:Server|Data Source|Endpoint|Host)\s*=\s*[^;\s]+;[^\n]{0,200}?(?:Password|Pwd|Key)\s*=\s*[^;\s]+/gi,
  },
  { name: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  {
    name: 'api_key_assignment',
    pattern:
      /\b(?:api[-_ ]?key|apikey|x-api-key|subscription[-_ ]?key)\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{8,}["']?/gi,
  },
  {
    name: 'password_assignment',
    pattern: /\b(?:password|passwd|pwd|client[-_ ]?secret)\s*[:=]\s*["']?[^\s"';,]{4,}["']?/gi,
  },
];

/** Masks common secret patterns in free text (defence in depth on top of ingestion redaction). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, `[REDACTED:${rule.name}]`);
  }
  return out;
}

/**
 * Builds a scrubber that also removes the exact secret values the caller holds (API keys, tokens),
 * so an upstream service echoing them back can never reach logs or errors.
 */
export function createSecretScrubber(secrets: readonly string[]): (text: string) => string {
  const exact = secrets.filter((s) => s.length >= 6);
  return (text) => {
    let out = text;
    for (const secret of exact) out = out.split(secret).join('[REDACTED]');
    return redactSecrets(out);
  };
}
