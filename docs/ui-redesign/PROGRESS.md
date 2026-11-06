# UI redesign: progress log

Resume rule: read this file and `DESIGN.md` first, then continue from the last phase below. Never redo a finished phase.
Branch `ui/caseguard-redesign`, created from `build/intelligence-wave-2` @ `46a13ac4bc00bbb75c3ead7a528ac5b527dd4786`.

## 2026-11-06 - Phase 0: preflight, baseline, BEFORE screenshots

**Done**

- Preflight: clean tree, remote `origin` = `snowjug/CaseGuard-Ai`, worktrees `CaseGuard-wt-*` left untouched, `gh` switched
  to `snowjug` (restore with `gh auth switch -u t-atshukla_microsoft` at the very end, and if the work stops early).
- Stack detected: pnpm monorepo; `apps/web` = Next.js 16 App Router + React 19 + Fluent UI (Griffel `makeStyles`) +
  TanStack Query + react-hook-form; shared `packages/ui` (`@caseguard/ui`: tokens, Fluent theme, primitives, charts,
  graph); tests = Vitest + Testing Library + axe (unit), Playwright + axe (e2e).
- Baseline on the untouched branch recorded in `baseline.md`: typecheck, lint, format, 8,087 unit tests and build all
  pass. Nothing is failing, so every failure from now on is mine unless the e2e baseline says otherwise.
- BEFORE screenshots: 44 PNGs (19 screens + command palette, shortcuts, first visit; 1440x900 and 375x812; light) in
  `before/`, produced by `e2e/screenshots/ui-redesign.spec.ts` (gated behind `UI_SHOTS=1`).
- Five read-only audits of the shell, intake, review/quality, analysis pages and admin screens were done; their
  findings are the inventory in `DESIGN.md`.

**Next**: Phase 1 (done below), then Phase 2.

**Decisions**

- Keep Next.js and Fluent UI as the behaviour layer; no Tailwind/shadcn/Radix (a second styling system would break the
  single source of truth for tokens). Tokens stay in `packages/ui/src/tokens` (palette -> Fluent theme + `--cg*`
  variables), the kit is built in `packages/ui`.
- Local profile for screenshots and e2e: `PW_CHANNEL=` (empty) to use the bundled Chromium, `PW_REUSE_SERVER=1` with the
  API (`e2e/support/serve-api.ts`) and web (`serve-web.ts`) started once.

**Open issues**

- The e2e baseline (desktop + mobile projects) is still running; its result is appended to `baseline.md`.

## 2026-11-06 - Phase 1: audit and design spec

**Done**

- `DESIGN.md` written and committed before any UI code: stack adaptation, inventory of 19 screens plus global chrome,
  the 13 confusions seen in the BEFORE screenshots, the new IA, blueprints for every screen, plain-language table, token,
  motion and component tables, quality gates and the list of ideas that need backend work.
- Palette candidates were checked with the repo's own contrast functions before being written down: every pair of the
  existing `contrast.test.ts` rules passes in both themes (three solid/onSolid pairs needed a small adjustment).

**Next**: Phase 2, design system: deps (`motion`, `lucide-react`, `cmdk`, Geist), tokens and Fluent theme, `globals.css`
and its sync test, theme toggle, then the kit components with tests, then the icon and Button migrations.

**Decisions**

- Flow: Add a case -> See the review -> Fix what matters. Nav: Home, Cases, Quality, Skills, Advanced (+ `/advanced` hub).
- Case workspace tabs are real links: Review, Score, Evidence, What if, Timeline, More (Possible causes, Case details,
  Report). Routes are unchanged.
- The twelve tone names stay and are remapped to accent, neutrals and green/amber/red so call sites keep compiling.
- Honest labelling stays, but as badges with tooltips and one footer caption instead of stacked banners.

**Open issues**

- None open from the baseline: the e2e baseline is recorded in `baseline.md` (369 of 375 pass; the 2 failures are an
  artefact of the shared-server run setup, 4 are skipped by design).

## 2026-11-06 - Phase 2: design system

**Done** (commits `f0fe392`, `4a57260`, `4abd764`)

- Tokens: one violet accent plus green/amber/red for status only; dark `#131218 / #1b1b22 / #23232c`, a matching light
  theme; 8 px grid, radii 8/12/16/24, motion up to 300 ms, Geist (self-hosted, OFL) at 48/30/22/15/13. Single source is
  `packages/ui/src/tokens`; `globals.css` mirrors the static ones and `test/globals-css.test.ts` checks it (extended).
  Every pair of `contrast.test.ts` passes in both themes. Fluent theme maps to the same tokens.
- Kit in `packages/ui/src/kit` (Button/ButtonLink/IconButton, Badge, Card, BentoGrid, StatCard, Tabs/TabNav,
  SegmentedControl, Accordion, Dialog, Drawer, Tooltip, Field/Input/Select/Textarea, Skeleton, ThemeToggle, Logo) and
  `src/motion` (BlurFade, NumberTicker, AnimatedList, MotionProvider). 25 kit tests incl. keyboard, aria wiring, reduced
  motion and axe in both themes.
- Existing primitives restyled in place with the same APIs (Panel, PageHeader + `tabs` slot, MetricCard, badges,
  EmptyState, ErrorState, Notice, LoadingSkeleton, DataTable, CopyButton, HelpButton, ConfirmDialog); all of `packages/ui`
  now uses lucide icons. Kit gallery added to the dev-only design lab and reviewed in dark and light.
- Tests: `packages/ui` 239 pass; the 12 web tests that broke were label changes only ("Synthetic" is now "Demo data")
  and were updated with the same strength.

**Next**: Phase 3, shell and navigation (AppShell with five items, top bar, bottom bar, theme toggle, cmdk command
palette, toasts, page title and favicon), then Phase 4 screens one commit each.

**Decisions**

- Native `Input`/`Select`/`Textarea`/`Field` (not Fluent wrappers); card padding 16/24/32 (20 is not on the grid).
- "Retry" and "Estimated" keep their wording (plain English, about 260 test assertions use them); "Synthetic" became
  "Demo data" and "Correlation ID" became "Reference".
- `BadgeShell` stays as a deprecated wrapper over `Badge` until the screens that use it are redesigned, then it goes.
- The primary button's glint is one 300 ms pass on hover or focus (never a loop); the skeleton shimmer is the only
  repeating animation and ends with the request.
- File changes by script were avoided; edits are made with the edit tools.

**Open issues**

- `@fluentui/react-icons` is still imported by `apps/web` (migrated screen by screen); the dependency goes when the last
  import does. Fluent `Button` is still used in `apps/web` and moves to the kit `Button` with each screen.

## 2026-11-06 - Phase 3: shell and navigation

**Done** (commits `02e6629`, `6a0b3aa`, and the persona picker and theme label that follow)

- Shell: slim sidebar (208 px; icon rail under 1024 px; hidden under 768 px) with Home, Cases, Quality, Skills and
  Advanced, a top bar (search hint `Ctrl K` / `⌘ K`, demo data pill, development identity pill, theme), a bottom bar
  on a phone, an aurora wash behind the page, breadcrumbs only where depth exists (a case, a skill, Add a case, an
  Advanced view). The header case selector and the 13-item navigation are gone.
- Command palette rebuilt on cmdk: Actions (Add a case, Try a sample case), Go to, Cases, Preferences, Advanced,
  Account. Typing ranks every command (compact matches only) and appends the server search results (two characters,
  debounced, grouped, links checked with `safeInternalHref`). `/` and the search button open it. The old global search
  box is removed.
- New Advanced page: four view cards with live figures (demo progress, system status), appearance (theme, reduced
  motion), keyboard (single-key shortcuts, shortcut help) and presentation mode; Design lab link in development only.
- Persona picker, shortcut help, presenter strip and toasts restyled on the kit; favicon is the new shield mark; page
  description rewritten in plain language.
- Renderer fix: Griffel sorted media queries as text, so a 640 px rule overrode a 1024 px one on a desktop. The app now
  uses `createCaseGuardRenderer` (min-width ascending, max-width descending), with a test.
- Tests: shell, palette (27), nav model, badges, presenter, shortcuts, 404, Advanced and persona tests updated or added
  with the same strength; `contrast.test.ts` gained the text-on-accent-tint pairs used by selected rows.

**Next**: Phase 4, one commit per screen, starting with the case workspace chrome, Home, Cases and Add a case, then
Review (the hero screen). End-to-end specs that name old labels (headings, the drawer, "Theme: ...") are updated in the
tests phase, after the screens, so they are changed once.

**Decisions**

- Five navigation items only; the other nine destinations stay reachable from case tabs, the Advanced page and the
  palette (`g` shortcuts kept for all 14).
- The shell no longer polls the guided demo; only the Advanced page reads its progress.
- `Try a sample case` opens `/cases/new?mode=sample`; the page picks it up (UI only, no API change).
- cmdk selects the first row from inside an effect, which leaves `aria-activedescendant` and the scroll position one
  step behind after typing. The palette corrects both (`ActiveOptionSync`, scroll to top) and a test covers it.

**Open issues**

- jsdom cannot show the bottom bar (its media query is not evaluated), so unit tests read it from the DOM; Playwright
  covers it on a phone viewport.
