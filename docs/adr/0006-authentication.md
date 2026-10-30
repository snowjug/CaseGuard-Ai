# ADR 0006: Authentication with Microsoft Entra ID JWTs; dev personas only outside production

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

Users sign in with their organisation account; the API must derive the tenant and role only from a validated
identity, never from the request (T1, T2). Local development and tests need identities without an identity
provider, but an accidentally enabled development login in production would be a critical flaw.

## Decision

- **Entra ID access tokens are validated by the API** (`AUTH_MODE=entra`): signature against the tenant's JWKS,
  issuer, audience and expiry (the `jose` library). The Entra tenant id maps to a CaseGuard tenant through
  `ENTRA_TENANT_MAP`; app roles map to RBAC roles through `ENTRA_ROLE_MAP`; permissions are deny-by-default.
- **Development personas** (`AUTH_MODE=dev`, header `x-cg-persona: <userId>` over synthetic users) exist for
  local, test and development only. Two independent switches must agree (`AUTH_MODE=dev` and `DEV_AUTH_ENABLED=true`), they
  are allowed only when `APP_ENV` is `local`, `test` or `development` (A-14), and the authenticator and
  start-up validation refuse to run otherwise. Production requires `entra` and `DEV_AUTH_ENABLED=false`.
- **BFF-less SPA token flow.** The browser app uses MSAL (`@azure/msal-browser`, `@azure/msal-react`) to sign in
  and acquire access tokens, and sends them as `Authorization: Bearer` through the same-origin `/api` proxy
  (ADR 0012). There is no server-side session and no ambient cookie authentication for state changes, which
  removes the CSRF surface (T13).

## Consequences

- Good: one validated identity source in Azure; no secrets in the browser (public client id, authority and
  scope only); the dev login cannot be enabled by one mistaken variable.
- Bad: the integration has been validated with locally generated keys only, **not against a live tenant**
  (A-15), and the setup steps are documented in `docs/ENTRA_ID_SETUP.md` for an operator to follow. Tokens live
  in browser storage managed by MSAL, so XSS remains the main threat (CSP, no `dangerouslySetInnerHTML`: T12).
- Bad: no back-channel logout or server-side revocation beyond token lifetime.

## Alternatives considered

- **Backend-for-frontend with a confidential client and session cookies:** keeps tokens out of the browser but
  adds a stateful tier, cookie and CSRF handling, and sticky sessions on scale-out.
- **Platform built-in authentication (Container Apps authentication):** convenient, but the API still needs
  claims and role mapping in code, and it is harder to test locally.
- **API keys or basic authentication:** no user identity, no role mapping, hard to rotate.
- **Another identity provider:** out of scope; the target environment is Microsoft-centric.
