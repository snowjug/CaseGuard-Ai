# ADR 0001: Monorepo with pnpm workspaces and just-in-time TypeScript packages

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The product is one web app, one API and eight shared packages (schemas, domain, ai, security, config,
observability, ui, testing) that must evolve together: the Zod contracts in `packages/schemas` are consumed by
every other package, and a change to them must fail every consumer's typecheck at once. The team is small and
CI time is a scarce resource. The development machines may sit behind a corporate package feed.

## Decision

- **One repository, pnpm workspaces** (`apps/*`, `packages/*`), Node 24, `engine-strict`.
- **Just-in-time TypeScript packages.** Each package's `exports` points at `./src/index.ts`; there is no
  per-package build step. Consumers compile the sources: Next.js transpiles `@caseguard/ui` and
  `@caseguard/schemas`, `tsup` bundles every `@caseguard/*` package into the API (`noExternal`), Vitest and
  `tsx` run them directly. Each package still type-checks on its own (`tsc --noEmit`).
- **No Turborepo or Nx.** `pnpm -r --if-present` is enough at this size. Revisit when CI time is dominated by
  rebuilding unchanged packages.
- **Catalog pinning.** Versions shared by several packages (TypeScript 5.9.3, Zod, Vitest, `@types/node`, tsx,
  fast-check, React, pino, jose) are declared once in the `catalog` of `pnpm-workspace.yaml` and referenced as
  `catalog:`.
- **Toolchain majors chosen for compatibility, not novelty:** TypeScript 5.9, ESLint 9, Vitest 4. For example,
  `eslint-plugin-jsx-a11y` 6.10 declares a peer range of ESLint up to 9, and the lint rules for the accessible
  UI depend on it. Dependabot ignores these majors; moving to the next one is a deliberate change with an ADR
  update.
- **Lockfile sanitiser.** Some corporate feeds make pnpm record private `tarball:` URLs in `pnpm-lock.yaml`,
  which breaks installs outside that network. `scripts/sanitize-lockfile.mjs` strips them (integrity hashes
  stay), `.npmrc` deliberately sets no registry, and `pnpm audit:deps` fails if a private feed URL is committed.

## Consequences

- Good: one atomic change across contract and consumers, no publish/build ordering, fast local loop, a single
  dependency graph to audit.
- Bad: every consumer must be able to compile TypeScript from other packages (bundler `noExternal`, Next
  `transpilePackages`); a package cannot be published as-is; transitive third-party dependencies of the
  workspace packages must also be declared by the API (`apps/api/tsup.config.ts` fails the build otherwise).
- Bad: holding toolchain majors back needs a periodic, explicit review so the project does not drift behind.

## Alternatives considered

- **Per-package builds (tsc project references or tsup per package):** more moving parts and slower feedback for
  no benefit while everything ships together.
- **Turborepo or Nx:** useful remote caching, but extra configuration and a dependency for a graph this small.
- **npm or yarn workspaces:** weaker workspace filtering, catalogs and deploy support than pnpm.
- **Separate repositories:** contract changes would need coordinated releases.
