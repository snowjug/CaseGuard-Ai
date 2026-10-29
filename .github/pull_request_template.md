## Summary

<!-- What does this change and why? Link the issue or requirement (for example FR-CF-02, NFR-SEC-06). -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / tooling / CI
- [ ] Documentation
- [ ] Infrastructure (Bicep)

## Checklist

**Tests**

- [ ] I added or updated tests that fail without this change (requirement ids in test names where they exist).
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass locally (or CI is green).
- [ ] User-visible changes are covered by an end-to-end test, including an axe accessibility check where a page changed.

**Documentation**

- [ ] I updated the docs that describe this behaviour (README, runbooks, ADRs, `.env.example`, API docs).
- [ ] If this is an architecture decision, I added or updated an ADR in `docs/adr/`.

**Security**

- [ ] No secrets, tokens, tenant/subscription ids or real customer data are included (`pnpm secrets:scan` is clean).
- [ ] New inputs are validated at the boundary; tenant isolation and RBAC are enforced for new routes or queries.
- [ ] New dependencies were reviewed (maintenance, licence, `pnpm audit:deps`).

**Responsible AI** (delete if not applicable)

- [ ] Model output is still validated by deterministic code (schema, citations, policy) before anything is persisted.
- [ ] Estimates, simulations and synthetic data stay clearly labelled in the UI, API and docs.
- [ ] Nothing leaks information from after a decision time into earlier analysis (temporal integrity).
- [ ] No claim is made that an external integration works unless it was actually exercised.

**Synthetic data only**

- [ ] All sample data in this PR is synthetic and labelled as such.

**Screenshots** (UI changes)

<!-- Before / after, light and dark themes. Use the synthetic demo data. -->

## Notes for reviewers

<!-- Risks, follow-ups, anything you could not run locally (say so explicitly). -->
