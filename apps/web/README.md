# @caseguard/web

The CaseGuard AI web application: Next.js 16 (App Router) + React 19 + Fluent UI 9, with the
**Evidence Constellation** design language from `packages/ui`. This package holds the _foundation_
(shell, client infrastructure, Command Center, dev-only design lab). Every other page follows the
conventions below, so read this before adding one.

> The UI consumes the typed route registry in `@caseguard/schemas` (`ROUTES`). It never calls models
> directly, never invents data and never ships mock data in a production path.

## Run and verify

Run from this folder unless noted. On Windows use `pnpm.cmd`.

| Task                  | Command                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Dev server            | `pnpm dev` (http://localhost:3000; the API is forwarded from `API_INTERNAL_URL`, default http://localhost:4000) |
| Type check            | `pnpm exec tsc --noEmit -p tsconfig.json`                                                                       |
| Unit/component tests  | `pnpm exec vitest run` (watch: `pnpm exec vitest`)                                                              |
| Lint (repo root)      | `pnpm exec eslint packages/ui apps/web`                                                                         |
| Format (repo root)    | `pnpm exec prettier --write packages/ui apps/web`                                                               |
| Production build      | `pnpm --filter @caseguard/web build` (writes `.next/standalone`)                                                |
| Design lab (dev only) | http://localhost:3000/design-lab (returns 404 when `NODE_ENV=production`)                                       |

Before you hand a page over, run: type check, tests, lint, prettier, the production build, then look
at it in a browser (light and dark, 1440x900 and 390x844) and run axe on it (see
[Verifying a page in a browser](#verifying-a-page-in-a-browser)).

## Folder structure

```
src/
  app/                     Routes only: thin server components that render a feature component
    layout.tsx             Root layout (server): reads cg-theme / cg-case cookies, mounts <Providers>
    providers.tsx          Every app-wide provider, in dependency order
    (shell)/               Route group with header + nav + breadcrumbs + footer. ALL product pages go here
      layout.tsx  loading.tsx  error.tsx  not-found.tsx  page.tsx (Command Center)
    design-lab/            Dev-only gallery of every ui component (notFound() in production)
    error.tsx  global-error.tsx  not-found.tsx
  features/<feature>/      Everything one page needs: page component, panels, skeleton, tests
    command-center/        The reference implementation: copy its structure
    design-lab/            Static sample data used only by the lab
  components/
    shell/                 Header, SideNav/NavDrawer, Breadcrumbs, Notices (honesty bar, footer), PresenterStrip
    common/                Page-state building blocks: QueryBoundary, QueryErrorState, IdentityRequired,
                           PageSkeleton, NotFoundState, RouteError, CaseSelect, LinkButton
  lib/
    api/                   callApi client, useApiQuery / useApiMutation / useJob, query keys, errors
    auth/                  AuthProvider interface, DevPersonaAuth, EntraAuth, useSession(), can(), <GatedAction>
    command-palette/  global-search/  shortcuts/  toast/  presentation/
    url-state.ts           Typed, shareable URL query state (filters, asOf, selection, tab)
    format.ts              UTC date/time/duration/number formatting (re-exported from @caseguard/ui)
    nav.ts  deep-links.ts  labels.ts  breadcrumbs.tsx  active-case.tsx  shell-ui.tsx
    env.ts  csp.ts  api-forward.ts   NEXT_PUBLIC_* parsing; CSP builder; runtime API forwarding
  proxy.ts                 Next 16 `proxy` (replaces middleware): runtime /api forwarding + per-request nonce CSP
  instrumentation-client.ts  Runs first in the browser; switches Zod's JIT off so the CSP stays eval-free
test/                      Vitest setup, `renderApp` harness, fake API, fixtures, next/navigation fake
```

Rules of thumb:

- `src/app/**/page.tsx` stays tiny: set `metadata`, read `params`/`searchParams` (they are Promises in
  Next 16), render one `features/<feature>/…Page` component.
- Page logic lives in `features/<feature>/`. Share only what at least two features need through
  `components/common` or `lib`; share visual building blocks through `packages/ui`.
- Server components must **not** import the `@caseguard/ui` barrel (it evaluates Fluent client code).
  Server code that needs theme helpers uses `@caseguard/ui/server`.
- Client components start with `'use client'`. Pages that call hooks are client components.
- No `any`. Imports from schemas are the contract: if a shape is missing, ask for a schema change
  instead of redefining it locally.

## Naming

- Files: `PascalCase.tsx` for components, `camelCase.ts` / `kebab-case.ts` for modules, `*.test.ts(x)` beside the code.
- Feature entry: `<Name>Page.tsx` exporting `<Name>Page`; sub-panels `<Thing>Panel.tsx`; skeleton `Skeleton.tsx`.
- Test titles carry the requirement id, for example `[FR-CC-02] Command Center states`.
- Query-string keys are short and shared: `sel`, `asOf`, `tab`, `case`, `present` (see URL state).
- Deep links: `/cases/<id>/<section>?sel=<itemId>&asOf=<UTC instant>`; build them with `lib/deep-links.ts`.

## How to add a page

1. **Route** - add `src/app/(shell)/<path>/page.tsx`:

   ```tsx
   import type { Metadata } from 'next';
   import { EvidenceLedgerPage } from '../../../../../features/evidence/EvidenceLedgerPage';

   export const metadata: Metadata = { title: 'Evidence Ledger' };

   export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
     const { caseId } = await params;
     return <EvidenceLedgerPage caseId={caseId} />;
   }
   ```

   The title becomes `Evidence Ledger · CaseGuard AI`. The shell adds breadcrumbs from the URL; for a
   dynamic segment call `useBreadcrumbLabel('case:<id>', 'CASE-0001')` once the label is known. The
   nav entry, `g <key>` shortcut and palette command already exist in `lib/nav.ts` (`NAV_ITEMS`).

2. **Data hook** - fetch with the typed hooks; the route id fixes params, query and response types:

   ```tsx
   'use client';
   import { keepPreviousData } from '@tanstack/react-query';
   import { useApiQuery } from '../../lib/api/hooks';

   const [asOf] = useAsOfState();
   const query = useApiQuery(
     'evidence.list',
     { params: { caseId }, query: asOf ? { asOf } : {} }, // optional fields are omitted, never `undefined`
     { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
   );
   ```

   Writes use `useApiMutation('<routeId>', { invalidate: ['<route that is now stale>'] })`; idempotent
   routes get an `Idempotency-Key` automatically and non-idempotent writes are never retried. Long
   operations return a job: poll with `useJob(jobId, { onTerminal })`.

3. **States** - wrap the main query in `QueryBoundary` so every page behaves the same:

   ```tsx
   <QueryBoundary
     query={query}
     subject="The evidence ledger"
     skeleton={<LedgerSkeleton />}                       // same layout as the loaded page
     isEmpty={(data) => data.items.length === 0}
     empty={<EmptyState title="No evidence yet" description="…" action={…} />}
   >
     {(data, { isRefreshing }) => <Ledger data={data} dimmed={isRefreshing} />}
   </QueryBoundary>
   ```

   It renders, in order: identity required (not an error), skeleton, error with **Retry** (403 and
   missing identity offer no retry), empty state, then the data. Secondary queries on the page use
   `<LoadingSkeleton>` / `<ErrorState onRetry>` from `@caseguard/ui` inside their own panel so one
   failing panel never blanks the page.

4. **URL state** - everything a person might share lives in the URL (never in component state):

   ```tsx
   const [asOf, setAsOf] = useAsOfState(); // ?asOf=<UTC ISO instant> (null = no limit)
   const [selected, select] = useSelectionState(); // ?sel=<id>, pushes history so Back closes the panel
   const [tab, setTab] = useTabState(['all', 'gaps'] as const, 'all'); // ?tab=
   const [filters, update] = useUrlStates({
     status: codecs.enumOf(STATUSES, 'all'),
     q: codecs.string(),
   });
   ```

   Codecs are total (hostile input falls back to the default) and defaults are omitted so URLs stay
   short. Updates use the History API: no full reload, no server round trip.

5. **Permissions** - deny by default through `useSession()`:

   ```tsx
   const { can } = useSession();
   <GatedAction permission="case:ingest">
     <Button onClick={load}>Load the synthetic sample</Button>
   </GatedAction>;
   ```

   `GatedAction` keeps the control focusable and explains _why_ it is disabled in a tooltip (the role
   and the missing permission). Use `<Can permission="…" fallback={…}>` to hide whole regions. The
   API enforces permissions too; the UI gate is a courtesy, never the control.

6. **Honesty rules** (non-negotiable, from the spec):
   - Every number is rendered exactly as the API returns it. Unknown is `-` plus "Not enough data";
     never `0`, never a guess. Estimates show their range and an **Estimated** badge.
   - Synthetic data carries the **Synthetic** badge; simulated paths and provider output carry
     **Simulated**; model confidence uses the model-estimate notice ("not statistical truth").
   - Evidence, hypothesis, productive and unsupported are never distinguished by colour alone:
     `StatusBadge` pairs colour with an icon, a label and a pattern.
   - Coaching language only: never rank, rate or discipline individuals.
   - Show UTC with the zone (`formatDateTimeUtc`, `formatDuration` from `lib/format`).

7. **Tests** - one `*.test.tsx` beside the feature using the harness (below). Cover loaded, loading,
   empty, error + Retry, forbidden, URL state, gating and `expectNoAxeViolations`.

8. **Design lab** - if you add a reusable visual, add it to `features/design-lab/DesignLab.tsx` with
   static props so it can be screenshotted and axe-checked in both themes.

### Accessibility checklist (every page)

- [ ] One `h1` (the `PageHeader` title); sections use `h2`, cards `h3`; no skipped levels.
- [ ] Landmarks come from the shell (`banner`, `navigation`, `main`, `contentinfo`); do not add another `main`.
- [ ] Everything works by keyboard: logical tab order, visible focus ring, no focus traps, `Esc` closes
      overlays and focus returns to the opener (Fluent does this for the trigger it renders; for an
      overlay opened from elsewhere remember and restore the opener, as `lib/shell-ui.tsx` does).
- [ ] Controls have names (visible text first; `aria-label` only for icon-only controls) and the
      accessible name contains the visible text.
- [ ] Charts/graphs are `role="img"` with a summary and a text/table alternative (the `ui` charts do this).
- [ ] State is never colour-only; touch targets are at least 24x24 px (prefer 32 px or more).
- [ ] Contrast: only use `cg.*` tokens from `@caseguard/ui` (every pair is tested at WCAG AA in both themes).
- [ ] Motion respects `prefers-reduced-motion` (use the `motion-safe` utility / `useReducedMotion`).
- [ ] Loading and result announcements use polite live regions (`role="status"`); errors use `role="alert"`.
- [ ] 390 px wide: no horizontal page scroll, tables scroll inside a labelled, focusable region.
- [ ] `expectNoAxeViolations` passes in tests and Playwright + axe passes on the running page.

## Client infrastructure reference

### API (`lib/api`)

- `callApi(routeId, { params, query, body, signal, idempotencyKey })` is the typed client behind
  `useApiQuery` / `useApiMutation` (get it with `useApiClient()`; tests inject a fake through
  `ApiClientProvider`). It is typed from `ROUTES` through `RouteParams` / `RouteQuery` / `RouteBody` /
  `RouteResponse`. It builds the path and
  query string, adds `x-correlation-id`, the active identity's headers and `Idempotency-Key`, applies a
  30 s timeout plus caller abort, retries only idempotent requests, parses RFC 9457 Problem Details into
  `ApiError { status, code, correlationId, issues }`, and validates the response with the route's Zod
  schema (always in dev/test; off in production unless `NEXT_PUBLIC_API_VALIDATION=sample|always`).
- Errors: `ApiError` carries `status`, `code`, `correlationId`, `issues` and getters such as
  `isForbidden`, `isNotFound`, `isUnavailable` (API unreachable) and `isRetryable`; `describeError(error)`
  gives plain language. Show them with the standard `QueryErrorState` (message, correlation id, Retry).
- Cache keys are partitioned by identity, so switching persona never shows another persona's data.
  After a persona change or demo reset call `invalidateAll(queryClient, identityKey)`.

### Identity (`lib/auth`)

- `AuthProvider` interface: `status`, `identityKey`, `getAuthHeaders()`, `signIn/signOut`.
- `DevPersonaAuth` (default, `NEXT_PUBLIC_AUTH_MODE=dev`): persona picker fed by `dev.personas`;
  sends `x-cg-persona`; always badged **Development identity**; hidden in presentation mode.
- `EntraAuth` (`NEXT_PUBLIC_AUTH_MODE=entra`): MSAL React redirect flow configured from
  `NEXT_PUBLIC_ENTRA_CLIENT_ID`, `NEXT_PUBLIC_ENTRA_AUTHORITY`, `NEXT_PUBLIC_ENTRA_API_SCOPE`.
  **Implemented and unit-tested against a mocked MSAL instance only; it has not been validated against
  a live tenant.**
- `useSession()` is backed by `session.me` and exposes `permissions` and `can(permission)`.

### Shell services

- `useShortcut({ id, keys, description, group, handler })`: `g c` sequences, `/`, `?`, `mod+k`.
  Shortcuts never fire while typing or while a modal is open unless they opt in.
- `useToast()`: `success | info | warning | error | undoable`. Toasts live in a polite region.
- `usePresentation()`, `usePresenterStep()`, `usePresenterHighlight(href)`: presentation mode
  (`?present=1|0`, remembered per tab); the presenter strip shows the next `demo.state` step.
- `useActiveCase()`: the active case (URL case on case pages, else the `cg-case` cookie).
- Command palette (`Ctrl/Cmd+K`) and global search (`/`) are mounted by the header. Add commands in
  `lib/command-palette/commands.ts`.

## Adding a component to `packages/ui`

1. Create `packages/ui/src/<group>/<Name>.tsx` (`primitives`, `charts`, `graph`, ...). Style with
   Griffel `makeStyles` and `cg.*` tokens only (no raw hex), no data fetching, no app imports.
2. Document every prop with JSDoc and export the component and its props type from
   `packages/ui/src/index.ts` (server-safe helpers go to `src/server.ts`).
3. Make it accessible by construction: roles/names, keyboard, focus ring, reduced motion, a
   non-colour cue for state.
4. Add `<Name>.test.tsx` (Testing Library + `axe-core`), and a lab entry in
   `features/design-lab/DesignLab.tsx`.
5. If you add a new colour pairing, add it to `packages/ui/src/theme/contrast.ts`; the contrast test
   asserts WCAG AA (4.5:1 text, 3:1 UI) in both themes.

## Testing

- Vitest + Testing Library in jsdom. `test/harness.tsx` exports `renderApp(ui, { api, persona, mode,
initialCaseId })` (same providers as the app), `fakeApi(handlers)` (unhandled routes fail loudly) and
  `expectNoAxeViolations(container)`. `test/fixtures.ts` builds schema-valid objects (validated with the
  real Zod schemas), `test/next-navigation.ts` is a history-backed fake of `next/navigation`
  (`navigateTo('/?case=case_2')`).
- jsdom has no layout, so contrast is covered by the token tests and by the browser scan.
- Two environment shims live in `test/setup.ts`: Fluent's Tabster marks modal dialogs `aria-hidden`
  until real focus moves (jsdom never does), and Node 25+ defines a global `localStorage` that is
  `undefined` without `--localstorage-file` (`test/storage.ts` installs an in-memory one).

### Verifying a page in a browser

The API may not be running. Either run it (`pnpm dev:api` from the repo root) or intercept `/api/v1/**`
with Playwright `context.route` and fulfil schema-valid fixtures **in the script only** (never in app code).
Take screenshots with `chromium.launch({ channel: 'msedge' })` from `@playwright/test`, scan with
`@axe-core/playwright`, and exclude Fluent's focus-trap sentinels (`.exclude('[data-tabster-dummy]')`),
which axe flags as hidden-but-focusable although they are inert by design. In production builds
`next/link` prefetches every nav destination, so use `waitUntil: 'load'` (not `'networkidle'`) until all
destinations exist.

## Configuration and security

| Variable                                                    | Where              | Purpose                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_INTERNAL_URL`                                          | server, at runtime | API origin that `src/proxy.ts` forwards `/api/*`, `/livez`, `/healthz`, `/readyz` to. Required in production; defaults to `http://localhost:4000` otherwise |
| `NEXT_PUBLIC_AUTH_MODE`                                     | browser            | `dev` (default) or `entra`                                                                                                                                  |
| `NEXT_PUBLIC_APP_ENV`                                       | browser            | label in the honesty bar (default `local`)                                                                                                                  |
| `NEXT_PUBLIC_ENTRA_CLIENT_ID` / `_AUTHORITY` / `_API_SCOPE` | browser            | Entra sign-in; the authority is added to CSP `connect-src`                                                                                                  |
| `NEXT_PUBLIC_API_VALIDATION`                                | browser            | `always` / `sample` / `off` (default `always` in dev, `off` in production)                                                                                  |

- **API forwarding happens at runtime, in `src/proxy.ts`** (logic in `src/lib/api-forward.ts`), not in
  `next.config.ts` `rewrites()`: rewrites are frozen at build time, but the image is built once and
  configured per environment. The proxy reads `process.env.API_INTERNAL_URL` on every request and
  `NextResponse.rewrite`s `/api/*`, `/livez`, `/healthz` and `/readyz` to it, so the method, headers
  (including `x-request-id`, `x-correlation-id`, `Idempotency-Key`, auth) and body reach the API
  untouched and the API's response comes back untouched, **without a CSP or nonce**. The value must be
  an absolute http(s) origin (`http://api:4000`: no path, credentials, query or fragment). It is
  validated once per value; when it is missing or invalid **in production** every forwarded request
  gets a `502` `application/problem+json` (`code: upstream_not_configured`, which the UI explains and
  does not retry) and one error is logged. Outside production a missing value means
  `http://localhost:4000`. If the API is unreachable Next answers `500`, which the client reports as
  "The CaseGuard API is not reachable". Next buffers a proxied request body up to 10 MB
  (`experimental.proxyClientMaxBodySize`); the API's own limits (`BODY_LIMIT_BYTES`,
  `UPLOAD_MAX_BYTES`) are lower by default.
- `src/proxy.ts` also sets, for page requests, a per-request nonce and the CSP (`script-src 'self'
'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `connect-src 'self'` plus the Entra authority).
  `next.config.ts` adds `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and COOP.
  `style-src` keeps `'unsafe-inline'` because Fluent/Griffel injects style rules at runtime; scripts
  stay nonce-only. `upgrade-insecure-requests` is added only when the request arrived over https (or
  `x-forwarded-proto: https`), so a plain-http LAN demo still loads.
- Because the nonce is per request, pages render dynamically (the root layout reads cookies).
- The browser only ever talks to its own origin; it never needs the API's address or CORS.
- `output: 'standalone'` with `outputFileTracingRoot` at the monorepo root; the container runs
  `apps/web/server.js` from `.next/standalone`.

## Known limitations

- Entra sign-in is not validated against a live tenant (mocked MSAL only).
- No live API existed when this foundation was written: states and layouts are verified with typed
  fixtures in tests and with intercepted responses in a real browser.
- Destinations other than the Command Center are added by later page work; until they exist their nav
  links lead to the not-found page.
