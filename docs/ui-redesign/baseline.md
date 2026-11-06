# Baseline (untouched branch)

Everything below was run once on `build/intelligence-wave-2` @ `46a13ac4bc00bbb75c3ead7a528ac5b527dd4786`, before any UI
change, on branch `ui/caseguard-redesign` (identical tree). A failure that also appears here is **pre-existing**.

## Environment

| Item            | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| OS              | Ubuntu 24.04.5 LTS (Linux 7.0.0-azure), 4 CPUs, 15 GB RAM                             |
| Node            | v24.22.2                                                                              |
| pnpm            | 10.34.7 (through `corepack pnpm`; the repo pins it with `packageManager`)             |
| Web stack       | Next.js 16.4.2 (Turbopack), React 19.3.1, Fluent UI 9.75.0 (Griffel), TanStack Query  |
| Browser for e2e | Playwright 1.64.1, bundled Chromium 1248 (`PW_CHANNEL=` empty; Edge is not installed) |
| Backend for e2e | API from sources (`tsx`), in-memory PGlite, deterministic AI provider, seeded demo    |

## Results

| Step                   | Command                          | Result                           | Time  |
| ---------------------- | -------------------------------- | -------------------------------- | ----- |
| Install                | `pnpm install --frozen-lockfile` | up to date                       | 2 s   |
| Typecheck              | `pnpm typecheck`                 | **pass**                         | 72 s  |
| Lint                   | `pnpm lint`                      | **pass**                         | 119 s |
| Format                 | `pnpm format:check`              | **pass**                         | 50 s  |
| Unit tests             | `pnpm test:unit`                 | **pass**: 309 files, 8,087 tests | 731 s |
| Build (all workspaces) | `pnpm build`                     | **pass**                         | 40 s  |

Nothing failed at baseline. The unit run prints `Not implemented: HTMLCanvasElement's getContext() method` many times:
that is jsdom noise from axe's colour-contrast rule, not a failure.

## Web bundle (static assets of the production build, all routes together)

Next 16 with Turbopack no longer prints per-route sizes, so the total of `apps/web/.next/static` is measured instead
(`node` script: sum of the files, gzip level 6).

| Asset | Files | Raw        | Gzip       |
| ----- | ----- | ---------- | ---------- |
| JS    | 69    | 3,453.1 KB | 1,031.7 KB |
| CSS   | 1     | 3.8 KB     | 1.4 KB     |

Fluent UI styles are generated at runtime (Griffel) and are therefore not part of the CSS total.

## End-to-end suite (Playwright `desktop` and `mobile` projects)

Run against the baseline production build (standalone server) and the seeded API. The result is appended to this file
under "E2E baseline result" when that run finishes.

## Screenshots

`docs/ui-redesign/before/` holds the BEFORE set: every screen at 1440x900 and 375x812 (light theme, the old default),
plus the command palette, the shortcuts dialog and the first visit without identity. They come from
`e2e/screenshots/ui-redesign.spec.ts`:

```
UI_SHOTS=1 UI_SHOTS_DIR=docs/ui-redesign/before UI_SHOTS_THEMES=light PW_CHANNEL= PW_REUSE_SERVER=1 \
  pnpm exec playwright test --project=screenshots e2e/screenshots/ui-redesign.spec.ts
```
