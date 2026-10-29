# Runbook: secret exposure response

For any suspected or confirmed exposure of a credential: a password, key, token, connection string, certificate, federated-credential configuration, or a file that contains them.

> Not exercised against a live deployment. See the [honesty note](README.md). **Rotate or revoke first, investigate second.** Never paste the exposed value into a ticket, chat or this document.

## What secrets exist in this system

By design there are few. Knowing what is **not** a secret speeds up triage:

| Item                                                              | Status                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL admin password and `database-url` (dev, password mode) | **Secret**, in Key Vault (`postgres-admin-password`, `database-url`). Does not exist in Entra-only mode (staging/prod)                                                        |
| Application Insights connection string                            | Low sensitivity (ingestion identifier) but treated as a secret; Key Vault secret `appinsights-connection-string`                                                              |
| Azure OpenAI API key                                              | **Disabled** on accounts created by the template (`disableLocalAuth`); `AZURE_OPENAI_API_KEY` exists only for local experiments or an existing account that still allows keys |
| Storage account keys / SAS                                        | Shared-key access is **disabled** on the storage account                                                                                                                      |
| Container registry credentials                                    | Admin user **disabled**; pulls use the managed identity                                                                                                                       |
| Search admin/query keys                                           | **Disabled** (`disableLocalAuth`); Entra roles only                                                                                                                           |
| GitHub deployment credentials                                     | OIDC federation: **no stored secret**; the trust relationship (repo, environment, subject) is the asset to protect                                                            |
| Entra client secrets                                              | **None by design** (SPA uses PKCE; API validates tokens); a created client secret is itself a policy violation                                                                |
| User access tokens                                                | Short-lived bearer tokens; exposure means session revocation                                                                                                                  |

## Symptoms and detection

- Secret scanning alert (GitHub secret scanning/push protection, or `pnpm secrets:scan`, or the pre-commit hook), a secret found in a log, ticket, screenshot or chat.
- Key Vault audit anomalies: unexpected callers, IPs or operations.

  ```kusto
  AzureDiagnostics
  | where TimeGenerated > ago(7d) and ResourceProvider == 'MICROSOFT.KEYVAULT' and Category == 'AuditEvent'
  | where OperationName in ('SecretGet', 'SecretList', 'SecretSet', 'SecretDelete')
  | summarize operations = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated) by OperationName, CallerIPAddress, ResultSignature
  | order by lastSeen desc
  ```

- Unexpected PostgreSQL connections (PostgreSQL logs: `connection authorized` from unknown addresses), unexpected storage or registry operations (`StorageBlobLogs`, `ContainerRegistryLoginEvents`), unexpected Entra sign-ins.
- Application logs containing secret-shaped values (a redaction failure - treat as an incident, T7).

## Immediate actions (first hour)

1. Name an incident owner and open a timeline. Limit who knows details to those who need to act.
2. **Contain by rotating or revoking** the exposed secret (table below). If you are unsure which secret, rotate all that could be affected.
3. Preserve evidence before it ages out: export relevant logs, note commit SHAs, workflow run ids, timestamps and who had access.
4. Stop further spread: delete the message/screenshot/ticket attachment (after preserving evidence), make the repository private if it was public.

## Rotation and revocation

| Secret                                         | How                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL admin password (dev)                | Re-run the deployment with a **new** `CASEGUARD_POSTGRES_ADMIN_PASSWORD` (or `deploy-dev -GeneratePostgresPassword`): the template updates the server password and **both** Key Vault secrets together. Then restart every active revision and the job so containers re-read the secret (`az containerapp revision restart ...`). Do not type the password on a command line. Staging/prod have none (Entra-only) |
| PostgreSQL access (any mode)                   | Review the Entra administrators (`az postgres flexible-server ad-admin list ...`); remove principals that should not have access; end suspicious sessions (`pg_terminate_backend`) with an administrator                                                                                                                                                                                                          |
| Key Vault secret value (other)                 | Set a new secret version, disable the old version (`az keyvault secret set-attributes --vault-name <kv> --name <name> --version <old> --enabled false`), restart revisions                                                                                                                                                                                                                                        |
| Azure OpenAI key (existing account with keys)  | `az cognitiveservices account keys regenerate --subscription $sub --resource-group <rg> --name <account> --key-name key1` (then `key2`); then disable key auth (`disableLocalAuth`) so it cannot recur                                                                                                                                                                                                            |
| Storage SAS / user-delegation key              | Revoke user-delegation keys: `az storage account revoke-delegation-keys --subscription $sub --resource-group $rg --name <storage>`; shared keys are disabled                                                                                                                                                                                                                                                      |
| Registry token or credential (if one was made) | Delete/regenerate it; the admin user must stay disabled                                                                                                                                                                                                                                                                                                                                                           |
| GitHub personal access token / app credential  | Revoke in GitHub; review the audit log and workflow runs for misuse; rotate any dependent secret                                                                                                                                                                                                                                                                                                                  |
| GitHub OIDC trust                              | If the repository or an environment was compromised: remove the federated credential from the deployment identity (`az ad app federated-credential delete` / `az identity federated-credential delete`), re-create it after the repository is secured, review role assignments of the identity                                                                                                                    |
| Entra client secret (should not exist)         | Delete it from the app registration; find out why it was created                                                                                                                                                                                                                                                                                                                                                  |
| User tokens / sessions                         | Revoke sign-in sessions for the affected users (Entra admin center > user > Revoke sessions); consider Conditional Access changes                                                                                                                                                                                                                                                                                 |
| Application Insights connection string         | Create a replacement component or disable local-auth ingestion; low impact, but update the Key Vault secret and restart revisions                                                                                                                                                                                                                                                                                 |

## Investigation

1. **Scope of exposure:** where was the value visible, for how long, to whom (public repo? chat? logs?). Was it a real value or a placeholder?
2. **Was it used?** Key Vault audit (above), PostgreSQL connection logs, Azure Activity Log for the subscription, Entra sign-in and audit logs, storage and registry logs, GitHub audit log. Look for activity from unknown IP addresses or identities after the exposure time.
3. **Data impact:** if misuse is possible, determine which tenants' data the credential could reach; PostgreSQL row-level security does not protect against an administrator credential.
4. **If a secret was committed to Git:** rotate first. Removing it from history (`git filter-repo`) is a separate, coordinated step with the repository owner; forks, clones and caches may still hold it, so treat it as burned regardless. Do not force-push shared branches without agreement.
5. **If it appeared in logs:** find the code path that logged it, fix and add a redaction test (log redaction paths and secret patterns), and purge or restrict the affected Log Analytics data per your policy.

## Recovery

- Confirm applications run on the new credential (revisions healthy, `/readyz` ok), and that automation (deployment pipeline) still works.
- Remove any emergency access you granted; re-enable anything you disabled.
- Complete notifications (security, privacy, customers) according to your obligations; keep the timeline.

## Verification

- The old secret fails (attempt a connection with it from an approved context), the new one works.
- Key Vault, PostgreSQL and storage logs show only expected principals after rotation.
- Secret scanning is clean and the scan of history shows nothing still valid.

## Follow-ups

- Post-incident review: how did it leak, why was it long-lived, what would have caught it sooner.
- Prefer elimination over rotation: Entra-only PostgreSQL, managed identities, federated deployment credentials.
- Add detective controls: Key Vault audit alerts, secret scanning with push protection, pre-commit scanning, log-redaction tests.
- Review Key Vault RBAC (who holds Secrets User/Officer) and the Entra administrators of PostgreSQL.
- Update this runbook with anything that was unclear or wrong during the response.
