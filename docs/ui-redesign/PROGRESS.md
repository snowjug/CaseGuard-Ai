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

**Next**: Phase 1, `DESIGN.md` (inventory, confusion list, IA, blueprints, jargon table, tokens, motion, components).

**Decisions**

- Keep Next.js and Fluent UI as the behaviour layer; no Tailwind/shadcn/Radix (a second styling system would break the
  single source of truth for tokens). Tokens stay in `packages/ui/src/tokens` (palette -> Fluent theme + `--cg*`
  variables), the kit is built in `packages/ui`.
- Local profile for screenshots and e2e: `PW_CHANNEL=` (empty) to use the bundled Chromium, `PW_REUSE_SERVER=1` with the
  API (`e2e/support/serve-api.ts`) and web (`serve-web.ts`) started once.

**Open issues**

- The e2e baseline (desktop + mobile projects) is still running; its result is appended to `baseline.md`.
