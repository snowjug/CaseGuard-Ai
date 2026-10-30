# ADR 0012: Next.js App Router and Fluent UI v9 with a same-origin API proxy

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The web app has twelve destinations, themes, accessibility goals and an Entra sign-in. The API should not be
exposed to the internet directly (internal ingress in Azure), browsers must not need CORS exceptions, and the
Content Security Policy should stay strict. The audience works in a Microsoft-centric environment.

## Decision

- **Next.js 16 App Router** with React 19 and TypeScript, built as a **standalone** Node server
  (`output: 'standalone'`, tracing rooted at the monorepo) and shipped as a container (ADR 0010).
- **Fluent UI React Components v9** (`@fluentui/react-components`) for primitives, theming and accessibility,
  with the project's design tokens layered on top (`packages/ui`). Data fetching uses TanStack Query; forms use
  React Hook Form with the shared Zod schemas.
- **Same-origin API proxy.** The browser only calls `/api/*` on the web origin; the web server's `src/proxy.ts`
  (the Next.js 16 "proxy", formerly middleware) forwards `/api/*` and the health endpoints (`/livez`, `/healthz`,
  `/readyz`) at request time to the API at `API_INTERNAL_URL` (`lib/api-forward.ts`, `NextResponse.rewrite`). In Azure
  the API keeps internal ingress; locally and in compose the target is `http://localhost:4000` or `http://api:4000`.
  Sign-in uses MSAL and sends bearer tokens (ADR 0006).

## Consequences

- Good: no CORS surface for the browser, a tight `connect-src` in the CSP (the web origin plus the Entra
  authority), the API is not publicly reachable, and one URL for users; Fluent gives accessible components and a
  recognisable look; server-rendered shell with a small client bundle.
- Bad: `NEXT_PUBLIC_*` values are inlined at build time (an image is specific to its Entra registration; the
  Dockerfile takes them as build arguments and `docs/CI_CD.md` explains it). `API_INTERNAL_URL` is different: it
  is read on every request, so the API address is a runtime setting (a missing or invalid value is a 502
  `upstream_not_configured` problem in production). The proxy adds a hop and a timeout, so long operations should
  be asynchronous. The unauthenticated probes are reachable on the public web origin as a consequence.
- Bad: Next.js and Fluent move quickly; majors are handled through Dependabot pull requests and the end-to-end
  and accessibility suite.

## Alternatives considered

- **Browser calls the API directly:** needs CORS, public API ingress and a wider CSP.
- **`rewrites()` in `next.config.ts`:** simpler, but evaluated at build time, so `API_INTERNAL_URL` would be baked
  into the image and one image could not serve several environments. This was the first design and was replaced by
  the runtime `proxy.ts` forwarding.
- **Another UI kit (MUI, Chakra, shadcn/ui) or a SPA without Next.js:** weaker fit with the Microsoft design
  language, or more assembly for routing, rendering and accessibility.
- **Pages Router:** the App Router is the supported direction for new Next.js apps.
