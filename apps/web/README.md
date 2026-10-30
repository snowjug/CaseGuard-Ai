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
  30 s timeout plus caller abort, retries only idempotent requests (`maxRetries` on a call overrides the
  count; `0` opts out; a `Retry-After` above 5 seconds is never slept through, the 429 is thrown at once so
  the page can show its own countdown), parses RFC 9457 Problem Details into
  `ApiError { status, code, correlationId, issues }`, and validates the response with the route's Zod
  schema (always in dev/test; off in production unless `NEXT_PUBLIC_API_VALIDATION=sample|always`).
- Errors: `ApiError` carries `status`, `code`, `reason`, `correlationId`, `issues` and getters such as
  `isForbidden`, `isNotFound`, `isUnavailable` (API unreachable) and `isRetryable`; `describeError(error)`
  gives plain language. Show them with the standard `QueryErrorState` (message, correlation id, Retry).
  `reason` is a stable token that refines `code` (`job_active`, `not_a_demo_tenant`, `entra_managed`,
  `case_export_disabled`, `engine_budget`, ...; the full list is in `docs/API.md`, "Reason tokens"): branch
  on `code` and `reason`, never on the message wording (`hasReason(error, reason, code?)` and
  `retryAdvice(error)` are in `lib/api/reason.ts`); show the API's own sentence only as the fallback for a
  refusal that carries no reason (for example a 403 for a missing permission).
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
  Shortcuts never fire while typing or while a modal is open unless they opt in. Shortcuts typed with a
  character on its own (`isSingleKeyShortcut`: `/`, `?`, `n`, `g c`) can be turned off (WCAG 2.1.4):
  `useSingleKeyShortcuts()` / `useSingleKeyToggle()` (`lib/shortcuts`) is the "Single-key shortcuts"
  setting, on by default and remembered in `localStorage` under `cg-single-key-shortcuts` (`on` / `off`).
  It is a switch in the `?` dialog and the palette command "Turn single-key shortcuts off/on", the change
  is announced by a toast, and while it is off only chords with Ctrl/Cmd/Alt (`mod+k`) and named keys
  work; the dialog, the palette hints and the search box then stop advertising the keys that no longer work.
- `useToast()`: `success | info | warning | error | undoable`. Fluent announces toasts in its polite
  (assertive for errors) live regions, and the visible toasts are mounted inside a named
  "Notifications" landmark so no content sits outside a landmark; while presenting they sit above the
  presenter strip.
- `usePresentation()`, `usePresenterStep()`, `usePresenterHighlight(href)`: presentation mode
  (`?present=1|0`, remembered per tab); the presenter strip shows the next `demo.state` step.
- `useActiveCase()`: the active case (URL case on case pages, else the `cg-case` cookie).
- Command palette (`Ctrl/Cmd+K`) and global search (`/`) are mounted by the header. Add commands in
  `lib/command-palette/commands.ts` (`buildPageCommands` lists the pages and sections the 12 `Go to`
  destinations do not reach, such as the Governance sections).
- `useNavBadges()` (`lib/nav-badges.ts`): the figures on the side navigation (case count, open quality
  warnings, demo progress, a System Health marker). They come from `cases.list`, `demo.state` and
  `system.health`. A route is only requested when the role holds its permission (`case:read`,
  `telemetry:read`), none of them is a heavy or metered route, and the last two are re-read once a minute
  while the tab is visible and not at all while it is hidden (`refetchIntervalInBackground: false`; the
  presenter strip's 15 s read of `demo.state` follows the same rules). While a request loads, fails or is
  refused the item simply has no badge, and nothing is invented.
- `PermissionGate` / `PermissionNeeded` (`components/common`): identity, loading and error states, then a
  plain "you do not have access" explanation (no request is made) before the page content.
  `ScrollTable` is a `DataTable` that keeps a minimum width inside a labelled, focusable scroll region,
  so a table scrolls on a phone instead of squeezing its columns.
- `useRoleSwitch()` (`lib/presentation`): switches to a synthetic persona of the same tenant that holds
  a step's role (the presenter strip and the Demo Guide use it); other tenants' personas are never offered.
- Page shortcuts appear in the `?` dialog while you are on the page: `n` opens the next step on the Demo
  Guide, `[` and `]` move between Governance sections, `r` refreshes System Health.
- The presenter strip publishes its height as `--cg-presenter-height`, and the shell pads the page by it,
  so content is never hidden behind it.

### Cases, ingestion, Timeline and Evidence Ledger

- **Cases** (`features/cases`, `/cases` and `/cases/[caseId]`): the list pages with a cursor (`useApiPages` in
  `lib/api/pages.ts`). `cases.list` has no total, no synthetic or workload filter and no sort, so those apply to
  the cases loaded so far and the page says so. The overview shows the digital twin (`twin.get`, with `asOf`), the
  analysis job (`JobProgress`) and a link to every case page. A case that was never analysed answers 409
  `conflict` with `reason: not_analysed` on every artefact view; `isNotAnalysedError`
  (`components/case/NotAnalysedState.tsx`) recognises that token and nothing else, and the pages then offer to start
  the analysis. Deleting a case while a job runs answers `job_active` (`DeleteCaseButton`).
- **Ingestion wizard** (`features/ingestion`, `/cases/new`): source, review (`ingestion.preview*` runs the same
  pipeline as the create), confirm, create (one `Idempotency-Key` per attempt), job progress. `ingest-errors.ts`
  explains each refusal by the API's `code` and `reason`: 409 `reference_in_use` and `request_in_progress`, 422
  `idempotency_conflict`, and 422 `unsafe_content` with `file_refused` (an upload) or `redaction_incomplete` (a
  custom redaction pattern could not be applied). An `unsafe_content` without a reason keeps a generic message that
  assumes neither cause. The only wording it reads is what no token carries: the name of a taken reference and the
  labels of the redaction patterns, and, in a preview (its issues have no `reason`), the `case.reference` sentence
  and the `After redaction:` prefix; the `redaction` issue path identifies the refusal. When the analysis
  finishes the wizard says so and moves the focus to **Open the case**; it never navigates by itself (a person
  who is still reading is not moved on, WCAG 2.2.1). In a failure notice (`ProblemView`) only the statement of
  the problem is a live region, and it never changes: the Try again button counts down outside it, and one
  static sentence announces the wait and one the end of it.
- **Timeline and Evidence Ledger** (`features/timeline`, `features/evidence`): long lists are windowed
  (`useWindowVirtualizer` in `lib/virtual-list.tsx`; a short list renders in full) and load the next page near
  the end. A page that failed is never asked for again by itself: `useNearEnd` keeps one observer for as long as
  it is enabled and calls the latest callback (a rebuilt observer reports at once, which repeated the failed
  request in a loop), the automatic loads (the delay, repeat and fork flags, the search for a claim named in the
  address, the event instants of the time cursor) stop at the first failure, and Retry asks once per press. A
  decision on a claim is never copied into the cache by hand: the ledger is reloaded and each window answers for
  itself, so an earlier window keeps the classification it had and says that the decision is recorded but not
  shown there.
- **Earlier views** (`components/case/as-of.tsx`, used by every case page): the API meters cold engine passes,
  and one pass serves every instant between two events. So the time cursor snaps to event instants
  (`useAsOfCursor`; the instants come from the unmetered whole-record timeline), sends one request when a drag
  stops (250 ms idle, superseded requests are aborted), does not retry a metered read (`asOfCall` sets
  `maxRetries: 0`) and keeps a window it already has (`asOfFresh`). A read of a moment never serves the answer of
  another moment while it loads (`keepWithinBoundary`, `lib/api/boundary-placeholder.ts`, instead of
  `keepPreviousData`): the page shows its loading state, `AsOfPanel` says "Looking up what was known at ...", and
  the time cursor and the panel beside it stay mounted so a keyboard user keeps their place; only a refetch or a
  filter change within the SAME moment keeps what is on screen. A 429 with `reason: engine_budget` is a calm
  notice with the `Retry-After` countdown and a Retry button (`AsOfLimited`, `isRateLimited`), never an error
  page; the notice is not a live region (its button ticks every second), a hidden static sentence announces the
  wait once and the end of it once. A page states the instant the server cut the evidence at (the `asOf` of the
  response) and the count of later events withheld, never the instant that was asked for, and says that reviewer
  decisions recorded later are not shown (`LaterDecisionsNote`). Confidence ranges of an earlier view are derived
  from the visible events, so they are not comparable number for number with the whole record's.

### Governance, System Health and Demo Guide

- **Governance** (`features/governance`, `/governance?tab=`): versioned sections (model, scoring,
  retention, redaction, feature flags, export controls) save with `expectedVersion` and a change note;
  per-field errors come from the API's 422 and a 409 "someone else saved first" offers to load the latest
  version. Each section says whether anything enforces it or whether it is _recorded only_. Roles
  (administrators), the audit log with chain verification, reviewer decisions and export are guarded by
  permission; in Entra mode roles belong to Entra and the API answers 409 (`reason: entra_managed`) to
  `governance.assignRoles`. A refused role change or export is explained by the API's `code` and
  `reason` (`entra_managed`, `last_administrator`, `case_export_disabled`, `audit_export_disabled`,
  `record_cap_exceeded`), see `refusals.ts`; an export the controls forbid points to the Export controls
  card (or to an administrator) and reloads the controls. The audit log and the reviewer decisions load
  the next page near the end of the list (`use-auto-load.ts`) only while the query is idle and healthy: after
  a failed request nothing is asked for again by itself and Retry repeats the request that failed (the page,
  or the refresh). Text clipped for display never ends inside an emoji (`clipText`, `lib/text.ts`).
  Every control that nothing enforces says so in its own help text, in one sentence that starts with
  "Recorded only:" (the retention periods and the legal hold, the feature flags, "Require a reason" and
  "Redact before model calls").
- **System Health** (`features/system`): every dependency with the simulated stand-ins labelled, and the
  plain statement that Azure OpenAI, Entra ID, Blob Storage, AI Search and Monitor were validated against
  mocks only. Secrets are masked by the API and are never shown.
- **Demo Guide** (`features/demo`): the 13 steps from `demo.state`, with progress derived by the API from
  stored data. Seed and reset are administrator-only (`demo:manage`) and answer 409 with a `reason`
  (`not_a_demo_tenant`, `job_active`, `personas_unavailable`), which `lib/presentation/demo-errors.ts`
  turns into the sentence the confirmation dialog shows.

### Hypothesis Arena and Counterfactual Lab

- **Hypothesis Arena** (`features/hypotheses`, `/cases/[caseId]/hypotheses`): every read of the page carries the
  same `asOf` (the time cursor of `components/case/as-of.tsx`), so the confidence chart, the hypotheses, the forks,
  the actions and the ranking describe one moment, and none ever shows the answer of another
  (`keepWithinBoundary`): the page says which moment it is looking up meanwhile (`LookingUp` in
  `features/reasoning`, or `AsOfPanel` while its own counts load). The action ranking (`ActionValuePanel`) lists the
  reviewer overrides the response carries (`reviewerOverrides`, newest decision first). An earlier view lists only
  the overrides decided, and about a moment, by its end and says how many it cannot show (`withheldOverrides`, a
  count and never content). The machine rank of an override is shown only when the override is about the ranking on
  screen, the one machine rank the response carries. A reviewer can also override a rank on an earlier ranking (it
  costs one metered pass: a 429 `engine_budget` is explained and nothing was recorded); the whole-record list in the
  response replaces the cached one at once (`usePrimeWholeRecordRanking`) and every other ranking is read again. The
  last event of a resolved case has nothing left to rank (every score is 0): the panel says so and, for the whole
  record, shows the ranking just before the earliest meaningful decision fork instead (`useDecisionPoint`; the
  cursor and the address are untouched). Zero scores are never presented as a recommendation.
- **Counterfactual Lab** (`features/counterfactual`, `/cases/[caseId]/counterfactual`): the fork selector, the
  temporal boundary and leak check, the simulated paths against the recorded one, the evidence behind each step
  (read at the decision instant), the reviewer's accept or reject, a hindsight panel kept apart and loaded only on
  request, and the shared Investigation Graph from `graph.get` (a graph stays on screen only for the same case,
  moment and simulated path). Refusals are told apart by `ApiError.code` and `reason`, never by wording
  (`version_conflict`, `separation_of_duties`, `job_active`: `features/reasoning/errors.ts`). Generating paths and
  extracting a SkillDNA show the shared `JobProgress`.

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
  `NextResponse.rewrite`s `/api/*`, `/livez`, `/healthz` and `/readyz` to it, so the method, body and
  headers (including `x-request-id`, `x-correlation-id`, `Idempotency-Key`, auth) reach the API
  unchanged, apart from `x-cg-client-ip` (next bullet), and the API's response, including its
  `x-request-id`, comes back **without a CSP or nonce**. The value must be
  an absolute http(s) origin (`http://api:4000`: no path, credentials, query or fragment). It is
  validated once per value; when it is missing or invalid **in production** every forwarded request
  gets a `502` `application/problem+json` (`code: upstream_not_configured`, which the UI explains and
  does not retry) and one error is logged. Outside production a missing value means
  `http://localhost:4000`. If the API is unreachable Next answers `500`, which the client reports as
  "The CaseGuard API is not reachable". Next buffers a proxied request body up to 10 MB
  (`experimental.proxyClientMaxBodySize`); the API's own limits (`BODY_LIMIT_BYTES`,
  `UPLOAD_MAX_BYTES`) are lower by default.
- **The caller's address for the API's rate limiter (`x-cg-client-ip`).** The API sits behind this web
  tier, so every forwarded request reaches it from the web replica's address and a per-client rate
  limit would put all visitors of a replica in one bucket. The proxy therefore tells the API which
  address _our own ingress_ reported: it always removes any `x-cg-client-ip` the browser sent (a
  caller can never choose its own bucket), then sets the header from the **right-most** entry of
  `x-forwarded-for`, because the ingress appends the connection it accepted and everything to its
  left was supplied by the client. A port or IPv6 brackets are stripped (`203.0.113.7:54321`,
  `[2001:db8::7]:443`) and only a literal IPv4/IPv6 address is accepted (no zone id, host name or
  `unknown`). If the last entry is not an address, no header is set and the entries to its left are
  deliberately not consulted, so the API falls back to the address it sees on the socket. Before the
  proxy runs, Next fills `x-forwarded-for` with the socket address when a request has none, so in
  local development the header carries the loopback address of the connection. The API believes the
  header only when it runs with `TRUST_CLIENT_IP_HEADER=true`: enable that only when the web
  container is reachable solely through that ingress, otherwise a client could pick its own address
  by sending `x-forwarded-for` itself. Mechanically the proxy passes the complete upstream header set
  through `NextResponse.rewrite(url, { request: { headers } })`, which Next applies to external
  destinations (and to WebSocket upgrades) and which removes every header that is not listed, so
  keep the copy of the incoming headers if you change `upstreamHeaders` in `src/lib/api-forward.ts`.
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
- All 12 destinations exist. A link to a case, skill or other record that no longer exists (for example
  after a demo reset) leads to the not-found page, which says so.
- Governance sections: the retention periods, the legal hold and the feature flags are stored and audited
  but nothing enforces them yet (the page labels them _recorded only_, and so does each control's help
  text); in the export controls only the allow flags and the record cap are applied (a reason is always
  required and only JSON is produced), and "Redact before model calls" in the redaction section is not
  read by anything. The session's feature set comes from the deployment configuration, not from the
  governed feature flags.
- Next adds `x-middleware-rewrite: <API_INTERNAL_URL>/api/...` to the response of every forwarded API
  call (it does so for any rewrite to an external URL), so browsers can read the internal API origin.
  Remove it at the ingress if that matters; avoiding it in the app would mean forwarding with a route
  handler instead of a rewrite.
