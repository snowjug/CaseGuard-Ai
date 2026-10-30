# Security policy

CaseGuard AI is a prototype built for a quality hackathon track. It handles **synthetic demo data only**, but it is written to be deployable, so security reports are taken seriously. This page describes what is supported, how to report a problem privately, and what you can expect.

## Supported versions

There are no tagged releases yet. Only the latest commit on the default branch receives security fixes; older commits, forks and unmerged branches do not.

| Version                        | Supported |
| ------------------------------ | --------- |
| Default branch (latest commit) | Yes       |
| Any other branch, tag or fork  | No        |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a vulnerability.**

1. Open a private report through GitHub: [Report a vulnerability](https://github.com/snowjug/CaseGuard-Ai/security/advisories/new) (Security tab, "Report a vulnerability"). This needs private vulnerability reporting to be enabled in the repository settings; if the link does not work, the owner has not enabled it yet.
2. If you cannot use that channel, open a minimal public issue that says only that you have a security report and asks for a private channel. Do not include technical details.

Please include: the affected component and commit, what you can do with the issue (impact), step-by-step reproduction on **your own instance**, and any suggested fix. Do not include real personal data or real credentials in a report.

## What to expect

These are targets from a small team of volunteers, not guarantees or contractual commitments:

| Step                                   | Target                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Acknowledge your report                | within 5 business days                                                 |
| Initial assessment (valid or not)      | within 10 business days                                                |
| Fix or mitigation for critical or high | aim for 30 to 60 days, sooner when exploitation is easy                |
| Public disclosure                      | coordinated with you; 90 days after the report unless agreed otherwise |

You will be told when a fix lands and, if you wish, credited in the advisory.

## Scope

In scope: the code, infrastructure templates (`infra/`), workflows (`.github/`) and container images built from this repository. Examples: authentication or tenant-isolation bypass, privilege escalation, injection, secret exposure, unsafe handling of uploaded or case content, weaknesses in the audit chain or the temporal-integrity guarantee, supply-chain weaknesses in the build.

Out of scope:

- Findings that need the **development persona login** (`AUTH_MODE=dev`): it intentionally has no real authentication, is for local and test only, and is refused when `APP_ENV` is `development`, `staging` or `production`. A way to enable it outside local and test **is** in scope.
- Vulnerabilities in third-party services or dependencies without a demonstrated impact here (report those upstream; see `docs/dependency-exceptions.json` for accepted risks).
- Volumetric denial of service, social engineering, physical attacks, and automated scanner output without a working proof of impact.
- Anything that requires access to someone else's Azure subscription, tenant or data.

The threat model is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md); known residual risks are listed there.

## Safe harbour

We want researchers to report problems and will not take action against anyone who acts in good faith: you test only instances that you own or run yourself, you avoid privacy violations and service disruption, you give us reasonable time to fix before disclosing, and you do not use or share data you should not have seen.

This is a statement of intent by the maintainers of an open-source prototype. It is **not** a legally binding promise, it does not authorise testing of systems that belong to anyone else (including GitHub, Microsoft Azure or any deployment you do not own), and it cannot bind third parties. If you are unsure whether something is covered, ask first through the private channel above.

## How the repository protects itself

Configured in the repository (some need settings that the owner must enable, see [docs/CI_CD.md](docs/CI_CD.md)): secret scanning in the pre-commit hook, in CI (own scanner and gitleaks) and, when enabled, GitHub push protection; CodeQL analysis; dependency review on pull requests; a dependency audit gate and Dependabot; least-privilege workflow permissions; OIDC instead of stored cloud credentials; no secrets in code, logs or examples.

If you find a credential in this repository, report it privately as above. Deleting it from the latest commit is not enough; it must be rotated.
