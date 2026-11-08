# ADR 0013: A token-driven UI kit on Fluent UI, with Motion, lucide and cmdk

- Status: Proposed (accepted when the pull request "CaseGuard AI UI redesign" is merged)
- Date: 2026-11-06
- Deciders: project owner, who commissioned the redesign; the work is recorded in `docs/ui-redesign/`

## Context

ADR 0012 chose Next.js and Fluent UI v9, with the project's tokens layered on top. The first interface worked but was
hard to read: a thirteen-item navigation, labels such as "evidence ledger", and screens that opened on tables instead
of a result. The redesign (`docs/ui-redesign/DESIGN.md`) needs a calm, finished look in a dark and a light theme, a
result-first layout, a command palette, restrained motion and one icon set, without a second styling system and with
every colour, space and radius defined once.

## Decision

- **Keep Next.js and Fluent UI v9** as the behaviour and accessibility layer (menus, popovers, dialogs, drawers, toasts,
  tooltips, switches). No framework migration.
- **Tokens are defined once** in `packages/ui/src/tokens` (one TypeScript palette that produces the CSS variables and the
  Fluent theme). Components use the typed `cg.*` references and Fluent `tokens.*` only; `design-tokens.test.ts` fails on a
  colour literal outside the token files, a stylesheet colour that is not in the palette, and a fixed gap, padding,
  margin or corner radius (UI-TOKENS-01 to 03).
- **A small kit in `packages/ui/src/kit`** (Button, Card, Badge, Tabs, Dialog, Drawer, Accordion, Skeleton, StatCard,
  RelativeTime and others) and the primitives beside it (PageHeader, DataTable, EmptyState, ErrorState and others) are
  the visual layer, written with Griffel `makeStyles` on top of Fluent.
- **Four additions:** `motion` (MIT; one `MotionProvider` that switches animation off when the system or the in-app
  setting asks for reduced motion), `lucide-react` (ISC; the only icon set), `cmdk` (MIT; the command palette) and Geist
  and Geist Mono through `@fontsource-variable` (SIL OFL 1.1; self-hosted).
- **Overlays and identity wait for the client.** A dialog or drawer that a link opens, and the signed-in or first-visit
  state, render only once `useHydrated()` is true, so the server HTML and the first client render are the same.

## Consequences

- Good: one styling system, one place for each token, enforced by a test; both themes come from the same palette and the
  theme is resolved on the server from a cookie, so the wrong theme never flashes; the existing end-to-end and axe suites
  keep covering the behaviour layer.
- Bad: the JavaScript of all routes together grows by about 10 per cent (3,453 to 3,809 KB raw, 1,032 to 1,153 KB gzip,
  measured on the production build); Fluent controls are still used directly in places (menus, popovers, checkboxes and
  a few small buttons), so two button implementations coexist; four "shorten and expand" text components from separate
  features have not been merged. Fluent and Motion move quickly; major versions go through Dependabot as before.

## Alternatives considered

- **Tailwind, shadcn/ui and Radix:** a second styling system next to Griffel would split the tokens in two and mean
  rewriting the behaviour layer that the tests already cover.
- **Keep the Fluent look and only fix layout:** does not give the depth, the result-first screens or the motion asked for.
- **General Sans:** the Fontshare licence is not clearly compatible with committing the font files to a repository.
- **21st.dev CLI or MCP:** not used (not required, and its free tier is limited); every component is written by hand.

## Notes

Spec and log: `docs/ui-redesign/DESIGN.md`, `docs/ui-redesign/PROGRESS.md`. Code: `packages/ui/src/kit`,
`packages/ui/src/tokens`, `apps/web/src/design-tokens.test.ts`. Revisit when the kit needs a component Fluent cannot
supply, or when the bundle size becomes a problem on slow connections.
