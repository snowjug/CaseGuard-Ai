# Contributing to CaseGuard AI

Thank you for helping. CaseGuard AI is an evidence-grounded, counterfactual quality platform for technical support cases. **All data in this repository is synthetic**; keep it that way.

## Ground rules

1. **Synthetic data only.** Never commit real customer data, real names, tenants, tickets or logs. Sample data is generated and labelled `synthetic` (see [Synthetic data](#synthetic-data-only)).
2. **Honest labelling.** Anything estimated, simulated or synthetic is labelled as such in the UI, the API and the docs. Never claim an external integration (Azure OpenAI, Entra ID, AI Search, Blob, Application Insights) works unless it was actually exercised.
3. **Temporal integrity.** Analysis at time T may only use information available at or before T.
4. **LLM proposes, code disposes.** Probability math, safety policy, citation checks and persistence validation are deterministic code. Model output is never stored without schema, citation and policy validation.
5. **No secrets, no placeholders in critical paths.** See [Secrets](#secrets-and-the-scanner). No `TODO`, no fake data outside explicit demo/dev mode, no empty `catch`.
6. **Do not claim something passed unless you ran it.** Say "not run" and why.

## Set up

You need Git, **Node.js 24** (see `.node-version`) and **pnpm 10** (the exact version is pinned in `package.json` as `packageManager`; Corepack installs it). Docker, the Azure CLI and Bicep are optional.

| Platform | Node 24                                                                | pnpm                                                                 |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Windows  | `winget install OpenJS.NodeJS` or [fnm](https://github.com/Schniz/fnm) | `corepack enable` (elevated shell), or `npm install -g pnpm@10.34.7` |
| macOS    | `brew install node@24` or `fnm install 24`                             | `corepack enable`                                                    |
| Linux    | your distribution's NodeSource/nvm/fnm install of Node 24              | `corepack enable` (use `sudo` if Node is installed system-wide)      |

```sh
git clone https://github.com/snowjug/CaseGuard-Ai.git
cd CaseGuard-Ai
pnpm install          # also installs the git hooks (husky)
cp .env.example .env  # optional; defaults work, see the file for every setting
pnpm dev              # web on http://localhost:3000, API on http://localhost:4000
```

Windows notes: in PowerShell, `pnpm` may be blocked by the execution policy; use `pnpm.cmd` or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Use `copy .env.example .env` instead of `cp`.

`pnpm dev` starts the API and the web app together (`scripts/dev.mjs`) and prints the synthetic dev personas (send the header `x-cg-persona: <userId>`; accepted only when `APP_ENV` is `local` or `test`).

Everything in containers instead: `docker compose up --build` (PostgreSQL + API + web on loopback ports; DEV ONLY, see `docker-compose.yml`).

## Commands

| Command                                                  | What it does                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev` / `dev:api` / `dev:web`                       | Run the stack, or one app                                            |
| `pnpm build` / `pnpm typecheck`                          | Build / type-check every workspace                                   |
| `pnpm lint` / `pnpm lint:fix`                            | ESLint (type-aware)                                                  |
| `pnpm format` / `pnpm format:check`                      | Prettier write / check                                               |
| `pnpm test` / `test:unit` / `test:int` / `test:coverage` | Vitest: everything / without `*.int.test.ts` / only those / coverage |
| `pnpm test:e2e` / `screenshots`                          | Playwright end-to-end (with axe accessibility checks) / screenshots  |
| `pnpm demo:reset` / `pnpm demo:seed`                     | Reset and seed the synthetic demo data                               |
| `pnpm db:migrate`                                        | Apply SQL migrations to `DATABASE_URL`                               |
| `pnpm secrets:scan`                                      | Secret scan of tracked and untracked files                           |
| `pnpm audit:deps`                                        | Lockfile hygiene and known-vulnerability gate                        |
| `pnpm infra:validate`                                    | Bicep build, lint and parameter scan                                 |
| `pnpm docker:build`                                      | Build both images and validate `docker-compose.yml`                  |
| `pnpm verify`                                            | The whole loop above, with an honest PASSED / FAILED / NOT RUN table |

`pnpm verify` runs every gate as its own step and never marks a step passed unless its command exited 0. Exit code 3 from a tool means **NOT RUN** (for example no Docker daemon, no Bicep CLI, no network for the audit): it is reported as such and is never a pass. `pnpm verify --only lint,typecheck` runs a subset; a full run writes `docs/assets/VALIDATION_REPORT.md` with the environment (OS, Node, pnpm, date, commit).

## Branches, pull requests and reviews

- Branch from the default branch: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Keep pull requests small and focused; open a draft early. Fill in the PR template (tests, docs, security, responsible AI, synthetic data, screenshots).
- CI must be green: format, lint, typecheck, unit and integration tests (PostgreSQL 16), build, end-to-end and accessibility tests, secret scan, dependency audit, Bicep validation and container builds. Required checks, branch protection and CODEOWNERS are described in [docs/CI_CD.md](docs/CI_CD.md).
- Pull requests are squash-merged; the PR title becomes the commit message, so it must follow Conventional Commits.
- Security vulnerabilities are **not** reported through issues or pull requests: see [SECURITY.md](SECURITY.md).

## Conventional Commits

Format: `type(scope)!: description`, header at most 100 characters, imperative mood, a blank line before any body.

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes (examples): `api`, `web`, `schemas`, `domain`, `ai`, `security`, `config`, `observability`, `ui`, `testing`, `infra`, `ci`, `docs`, `deps`, `e2e`.
- A `!` or a `BREAKING CHANGE:` footer marks an incompatible change.

The `commit-msg` hook (`scripts/check-commit-msg.mjs`) enforces the header. The `pre-commit` hook formats staged files with Prettier (lint-staged) and runs the secret scanner on the staged content. CI re-runs both checks, so skipping hooks only delays the failure.

## Testing

- Vitest, colocated in `test/` or `src/**/*.test.ts`; name integration tests `*.int.test.ts`. They run on PGlite by default and on a real PostgreSQL when `TEST_DATABASE_URL` is set (CI does this).
- Put requirement ids in test names: `it('[FR-CF-02] never leaks the resolution into earlier analysis', ...)`. Test behaviour and risk, not trivia, and do not game coverage.
- Anything that influences analysis output takes an injected clock, id generator and RNG so tests are reproducible.
- User-visible changes get a Playwright test and, for new or changed pages, an axe accessibility check.

## Synthetic data only

- Sample case bundles and the knowledge pack live in `synthetic-data/` and carry `"synthetic": true`. Invent names, products and logs; never adapt a real case, and never paste real text "just to see".
- Secret-shaped strings (fake tokens, keys, connection strings) used to exercise redaction belong in `synthetic-data/` or in test fixtures, and must be obviously fake. Generate them at test time where you can.
- If you are unsure whether something is safe to commit, it is not: ask first.

## Secrets and the scanner

No real secret may enter the repository, including `.env` files (only `*.example` files are tracked). `scripts/scan-secrets.mjs` (pre-commit and CI) and gitleaks (CI, full history) look for private keys, cloud and SaaS tokens, Azure storage keys and connection strings, JWTs, credentials in URLs and high-entropy `secret/password/token/api key` assignments. Findings print only `file:line` and a rule id, never the value.

For a false positive, prefer the narrowest allowance and always give a reason:

- one line: add a comment `secretscan:allow <reason>` on that line, or `secretscan:allow-next-line <reason>` on the line before it;
- a whole file or directory: add an entry with a justification to `.secretscanignore` (`<glob> [rules=a,b]  # <reason>`).

If the value is real: remove it, rotate the credential, and tell the maintainers. Removing it from the latest commit does not make it safe.

## Dependencies

- Shared third-party versions are pinned once in the pnpm `catalog` (`pnpm-workspace.yaml`); reference them with `"catalog:"`.
- Toolchain majors (TypeScript, ESLint, Vitest) are deliberately held back; see [ADR 0001](docs/adr/0001-monorepo-strategy.md).
- Commit `pnpm-lock.yaml` with every dependency change. If your package feed records private tarball URLs in it, run `node scripts/sanitize-lockfile.mjs` before committing; `pnpm audit:deps` fails when the lockfile contains private feed URLs.
- Run `pnpm audit:deps` before adding or bumping a dependency. Time-boxed exceptions go in `docs/dependency-exceptions.json` with a justification and an expiry date.

## Adding a knowledge pack or a skill

**Knowledge pack** (the authored domain model that the deterministic provider reasons with):

1. Write the pack as JSON that satisfies `KnowledgePackSchema` in `packages/schemas/src/knowledge.ts`: an id like `kp.<slug>`, a semantic version, a mandatory disclaimer, hypotheses whose priors sum to 1 (including the catch-all `hyp.other`), signals with per-hypothesis likelihoods, actions, requirements, claim patterns, a lexicon and policies.
2. Every number is an **illustrative estimate authored for the demo** (assumption A-06). Say so in the disclaimer; never present it as measured data or vendor guidance.
3. Validate it with `validateKnowledgePackReferences` (unknown ids, duplicate ids, priors that do not sum to 1) in a test, add at least one synthetic case that exercises it, and keep the temporal-integrity tests green.
4. Document what the pack cannot do (the deterministic provider is rule-based and only strong on bundled packs).

**Skill (SkillDNA):** skills are not hand-written files. They are extracted from a validated case and move through a governed lifecycle (`discovered`, `draft`, `simulation_tested`, `expert_reviewed`, `pilot`, `validated`, `published`, `deprecated`, `retired`). Approval needs a **distinct approver** (never the creator), changes use optimistic locking, nothing auto-publishes, and every transition is audited. To add a seed skill for the demo, extend the synthetic data and the extraction tests rather than inserting rows by hand. See [ADR 0009](docs/adr/0009-skilldna-governance.md).

## Documentation and decisions

Update the docs that describe your change. Architecture decisions are recorded as ADRs in `docs/adr/` (copy `0000-template.md`, keep it short and truthful, status `Proposed` until accepted).

## License

The license is pending the owner's decision; see [LICENSE](LICENSE). Until a license is chosen, do not assume any rights beyond viewing the code, and do not submit code you cannot license to the project.
