# @caseguard/security

Security primitives shared by the API and the AI layer: RBAC, identity strategies, tenant guards, redaction, prompt-injection handling, upload and URL safety, hashing/ids and HTTP security headers. Everything here is pure or dependency-light and fully typed; clocks, randomness and key resolvers are injected so tests are deterministic.

```ts
import { redactText, createAuthenticator, validateUpload } from '@caseguard/security';
// Edge/web-safe subpaths (no Node-only imports):
import { ROLE_PERMISSIONS } from '@caseguard/security/rbac';
import { buildContentSecurityPolicy } from '@caseguard/security/headers';
```

| Module           | What it provides                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `errors`         | `SecurityError` family with `status`/`code` the API error handler maps; `AuthenticationError.reason` is for logs only           |
| `rbac`           | `ROLE_PERMISSIONS` (deny by default, frozen), `permissionsFor`, `hasPermission`, `requirePermission`, `requireDistinctApprover` |
| `tenant`         | `assertSameTenant`, `assertAllSameTenant` (missing tenant on either side is a violation)                                        |
| `auth/`          | `DevPersonaAuthenticator`, `EntraJwtAuthenticator`, `createAuthenticator`                                                       |
| `redaction/`     | `redactText`, `redactValue`, `createPseudonymState`, custom-pattern sandbox                                                     |
| `injection/`     | `detectPromptInjection`, `summarizeInjection`, `stripHiddenCharacters`, `wrapUntrustedContent`                                  |
| `files/`         | `validateUpload`, malware-scanner hook (`NoopMalwareScanner`, `EicarTestScanner`)                                               |
| `url-safety`     | `assertSafeOutboundUrl`, `isPrivateOrLoopbackHost`, `safeRelativeRedirect`                                                      |
| `hashing`, `ids` | `sha256Hex`, `canonicalJson`, `hashChain`, `newId`, `createMonotonicIdFactory`, `stableId`                                      |
| `headers`        | `buildContentSecurityPolicy`, `SECURITY_HEADERS`, `HSTS_HEADERS`, `API_CONTENT_SECURITY_POLICY`                                 |

## Decisions worth knowing

### Identity

- **Dev persona auth** (`x-cg-persona`) refuses construction unless `allowDev: true` _and_ the environment is `local`, `test` or `development`. `production`, `staging` and any unknown name are refused (fail closed). `createAuthenticator` additionally refuses `DEV_AUTH_ENABLED=true` in production-like environments even when `AUTH_MODE=entra` (NFR-SEC-03).
- **Entra tokens** are verified with `jose`: signature (injected key resolver, default remote JWKS), issuer, audience, `exp`/`nbf` with a 30 s tolerance (max 300 s), required `exp`, asymmetric algorithms only (default `RS256`; `none` and `HS*` can never be configured). `tid` must be in the tenant map, `oid` is the subject, and at least one `roles` claim value must map to a CaseGuard role.
- Failure statuses: 401 with the generic message `Authentication failed` for every credential problem (the precise `reason` is on the error object for logs/metrics); 403 `AuthorizationError` when the token is valid but no role maps; 503 `IdentityProviderUnavailableError` when the JWKS cannot be fetched.
- **Exactly one issuer is accepted.** When it is derived from the tenant id it is the v2 issuer (`https://login.microsoftonline.com/<tid>/v2.0`). An API app registration that still issues v1 tokens must set `ENTRA_ISSUER` to the v1 issuer (`deriveEntraEndpoints(tid).issuerV1`) or, preferably, set `requestedAccessTokenVersion: 2`.
- Entra validation is unit-tested with locally generated keys (and a loopback JWKS server). It has **not** been exercised against a live Entra tenant.

### Redaction

- Placeholders are stable (`[REDACTED:<category>]`). E-mail addresses, IPv4 addresses and phone numbers get numbered pseudonyms per distinct value within one `PseudonymState` (`[REDACTED:email_address#1]`), so analysis can still tell people apart. Use one state per case; never share one across tenants.
- **Synthetic-data exemption** (so demo evidence stays readable): e-mail addresses on `.invalid`, `.example`, `.test`, `.localhost`, `example.com`, `example.net`, `example.org` (and their sub-domains), and IPv4 addresses in RFC 1918 private ranges, loopback, link-local and the RFC 5737 documentation ranges are **not** redacted. Pass `redactReservedValues: true` to redact them too (used for operational diagnostics).
- Redaction is idempotent (a second call changes nothing and reports zero replacements), `findings` never contain matched values, and every built-in pattern is linear-time (1 MiB hostile inputs are covered by tests). Idempotency is enforced by construction: a rule can expose text an earlier rule had to skip (for example a key glued to an e-mail address becomes a standalone token once the address is replaced), so the rules are re-applied until a pass changes nothing (at most `MAX_REDACTION_PASSES`). Text that needed no change is scanned once; text with findings is scanned twice.
- A labelled value that embeds another detected secret is replaced only up to that embedded secret (`password=ab!<aws key>!tail` keeps `!tail`). This is accepted: the embedded secret and the leading part are gone, and extending a match across placeholders would make the result depend on rule order.
- Deep idempotency hunt (opt-in, about a minute): `REDACTION_FUZZ_RUNS=200000 pnpm exec vitest run test/redaction-property.test.ts`.
- Custom (administrator) patterns are untrusted: length ≤ 200, syntax checked, nested/ambiguous repetition, back-references and look-arounds rejected, probed against adversarial input, and every evaluation runs in a `node:vm` context with a wall-clock timeout that really interrupts the regex engine. Rejected patterns are skipped with a note in `result.notes`; a pattern that blows its budget at run time is disabled and reported. Custom patterns run whenever the list is non-empty, regardless of the `custom` category toggle.
- Not covered: IPv6 addresses, personal names, free-text identifiers (use custom patterns), credit-card or national-id numbers.
- `SECRET_REDACTION_CATEGORIES` is the credentials-only subset for logs and telemetry, where client IPs and user ids are operationally useful.

### Prompt injection

Detection is heuristic and **can be evaded** (paraphrase, other languages, homoglyphs); it flags obvious attempts for quarantine and review and complements the real controls: `wrapUntrustedContent` (content-bound, deterministic delimiters; look-alike delimiters and chat-template tokens are defused), a model with no tools, and schema/citation/policy validation. Support language such as "please ignore the previous error" is deliberately not flagged; ambiguous phrases are medium, unmistakable ones high.

### Uploads and malware

`validateUpload` decides from the bytes (signatures, NUL/control bytes, strict UTF-8, JSON syntax and depth) and never trusts the file name or Content-Type; it always returns a storage-safe `safeFileName`. **No malware scanner is bundled**: `NoopMalwareScanner` reports `not_scanned` and `EicarTestScanner` only recognises the EICAR test string.

### URLs

`assertSafeOutboundUrl` is a text-level SSRF guard (https only, no credentials, no IP literals, no local/private names, host allowlist, default port). It cannot see DNS resolution; do not follow redirects blindly.

## Tests

`pnpm exec vitest run` inside this package. Secret-shaped fixtures are assembled at runtime (`test/helpers/secrets.ts`) so no source file contains a credential-looking literal.
