# Support

CaseGuard AI is an open-source prototype, maintained on a best-effort basis. There is no service-level agreement, no paid support and no support for production use. It is not a Microsoft product, and all demo data is synthetic.

## Where to look first

- [README](README.md) and the [docs](docs/): requirements, implementation plan, threat model, assumptions, deployment and CI/CD guides.
- [docs/runbooks](docs/runbooks/): what to do when the database, AI provider or search is unavailable.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup on Windows, macOS and Linux, and every command.
- `.env.example`: every configuration variable, with its safe local default.

## Getting help

| You want to...                    | Do this                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Report a bug                      | Open an issue with the **Bug report** form. Include steps to reproduce on synthetic data.                 |
| Ask a question or suggest an idea | Start a GitHub Discussion if the repository has them enabled; otherwise open a **Feature request** issue. |
| Report a security vulnerability   | **Do not use issues.** Follow [SECURITY.md](SECURITY.md).                                                 |
| Report a conduct problem          | Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).                                                          |
| Contribute a change               | Read [CONTRIBUTING.md](CONTRIBUTING.md) and open a pull request.                                          |

## What helps us help you

- The commit SHA, your OS, Node and pnpm versions, and whether you run `pnpm dev`, `docker compose` or an Azure deployment.
- The smallest synthetic reproduction you can make. Never paste real customer data, credentials, tenant ids or subscription ids.
- Output of `pnpm verify --only <step>` for the failing step, if the problem is a build or test failure.

## Not supported

Operating your own Azure deployment, Microsoft Entra configuration or billing questions; custom AI deployments; anything involving real customer data.
