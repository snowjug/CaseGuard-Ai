# Microsoft Entra ID setup

> **Not exercised against a live tenant.** The API validates Entra-issued JWTs and maps app roles to CaseGuard roles; this has only been unit-tested with locally generated keys (docs/ASSUMPTIONS.md A-15). These steps describe the intended configuration. Confirm the first sign-in end to end, and decode a real access token to verify the claims described here before relying on them. All identifiers in this document are placeholders (`00000000-0000-0000-0000-000000000000`); never commit real tenant, subscription or application ids.

Azure environments always run with `AUTH_MODE=entra` and `DEV_AUTH_ENABLED=false`. Persona login exists only for local development and tests.

## 1. What you create

| Object                                   | Purpose                                                                                                                        | Used by                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **API app registration** `CaseGuard API` | Defines the audience, the `access_as_user` scope and the five app roles; its enterprise application holds the role assignments | API (`ENTRA_*`)                                            |
| **SPA app registration** `CaseGuard Web` | Public client (PKCE) that signs users in and requests the API scope                                                            | web app (`NEXT_PUBLIC_*`)                                  |
| **Role assignments**                     | Users/groups assigned to app roles on the API's enterprise application                                                         | token `roles` claim                                        |
| **Deployment identity** (optional)       | GitHub OIDC federation for deploying infrastructure without long-lived secrets                                                 | CI/CD ([section 7](#7-github-actions-oidc-for-deployment)) |

## 2. App roles and how they map

Create these five app roles on the **API** registration (allowed member type: Users/Groups; value is what appears in the token). The values must match `ENTRA_ROLE_MAP`.

| App role value            | CaseGuard role  | What it grants (from `packages/security` `ROLE_PERMISSIONS`, as specified in the build contract)                                         |
| ------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CaseGuard.Engineer`      | `engineer`      | case read/ingest/analyze, counterfactual run, skill read/apply/extract, warning dismiss, quality and telemetry read                      |
| `CaseGuard.Reviewer`      | `reviewer`      | the engineer read set plus evidence/fork/counterfactual review, quality review, action-value override, skill review/validate, audit read |
| `CaseGuard.Manager`       | `manager`       | case read, quality read, analytics read, telemetry read, skill read                                                                      |
| `CaseGuard.SkillCurator`  | `skill_curator` | the skill lifecycle (extract, mutate, validate, review, approve, publish, retire, rollback) and case read                                |
| `CaseGuard.Administrator` | `administrator` | everything, including governance, role management, audit read, demo management, data export and case deletion                            |

Skill approval requires a **distinct approver** from the creator/requester, so assign skill-approving roles to at least two different people.

A signed-in user with no app role gets no permission (deny by default). Set **Assignment required = Yes** on the enterprise application so unassigned users cannot even obtain a token.

Default `ENTRA_ROLE_MAP` (also the default of the Bicep parameter `entraRoleMap`):

```json
{
  "CaseGuard.Engineer": "engineer",
  "CaseGuard.Reviewer": "reviewer",
  "CaseGuard.Manager": "manager",
  "CaseGuard.SkillCurator": "skill_curator",
  "CaseGuard.Administrator": "administrator"
}
```

## 3. API app registration

Portal: Microsoft Entra ID > App registrations > New registration.

1. **Name** `CaseGuard API`. **Supported account types**: _Accounts in this organizational directory only_ (single tenant) unless you deliberately serve several tenants (then see [section 6](#6-tenant-mapping-and-multi-tenant-use)). No redirect URI.
2. **Expose an API**: set the **Application ID URI** (the portal proposes `api://<client-id>`). Add a scope `access_as_user` (who can consent: admins and users; state: enabled).
3. **Manifest**: request v2 access tokens and define the roles. In the (Microsoft Graph based) manifest editor set `api.requestedAccessTokenVersion` to `2` (the legacy manifest calls it `accessTokenAcceptedVersion`) and add the roles. Generate a new GUID for every `id` (`[guid]::NewGuid()`):

   ```json
   {
     "api": { "requestedAccessTokenVersion": 2 },
     "appRoles": [
       {
         "id": "<new-guid>",
         "allowedMemberTypes": ["User"],
         "displayName": "CaseGuard Engineer",
         "description": "Technical support engineer: ingest and analyse cases.",
         "value": "CaseGuard.Engineer",
         "isEnabled": true
       }
     ]
   }
   ```

   Repeat the role object for `CaseGuard.Reviewer`, `CaseGuard.Manager`, `CaseGuard.SkillCurator` and `CaseGuard.Administrator`.

4. **Authorized client applications** (Expose an API): add the SPA's client id with the `access_as_user` scope to skip the consent prompt for your own users.
5. **Enterprise applications** > `CaseGuard API` > Properties: **Assignment required = Yes**. Then **Users and groups**: assign groups to the app roles (prefer groups over individual users).

## 4. SPA app registration

1. **Name** `CaseGuard Web`, single tenant, platform **Single-page application** (not _Web_): the app signs in with the authorization-code flow with PKCE and has **no client secret**. Do not enable implicit grant.
2. **Redirect URIs** (SPA platform):
   - the deployed web URL, `https://<web app name>.<environment default domain>/` (the `webUrl` output of the deployment; it exists only after stage 2 of [docs/DEPLOYMENT.md](DEPLOYMENT.md)). _Assumption:_ the web app uses the site root as the redirect target; confirm the exact path in the web app's MSAL configuration and register that path.
   - for local development against a real tenant only: `http://localhost:3000/` on a **separate dev registration**, never on the production one.
3. **API permissions** > Add > My APIs > `CaseGuard API` > delegated `access_as_user`. Grant admin consent if your tenant requires it.
4. Optionally add the front-channel logout URL of the web app.

## 5. Mapping to configuration

| Entra value                      | API environment variable                              | Web environment/build variable        | Bicep parameter                                          | Example (placeholder)                                               |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Directory (tenant) id            | `ENTRA_TENANT_ID`                                     | part of `NEXT_PUBLIC_ENTRA_AUTHORITY` | `entraTenantId`                                          | `00000000-0000-0000-0000-000000000000`                              |
| Token audience (`aud`)           | `ENTRA_AUDIENCE`                                      | -                                     | `entraApiAudience`                                       | v2 tokens: the API client id; v1 tokens: `api://<client-id>`        |
| Token issuer (`iss`)             | `ENTRA_ISSUER` (optional, derived from the tenant id) | -                                     | not set by the template                                  | v2: `https://login.microsoftonline.com/<tenant-id>/v2.0`            |
| Signing keys                     | `ENTRA_JWKS_URI` (optional, derived)                  | -                                     | not set by the template                                  | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys` |
| Entra tenant -> CaseGuard tenant | `ENTRA_TENANT_MAP`                                    | -                                     | `entraTenantMap`                                         | `{ "<tenant-id>": "tenant_contoso_support" }`                       |
| App role value -> CaseGuard role | `ENTRA_ROLE_MAP`                                      | -                                     | `entraRoleMap`                                           | see section 2                                                       |
| SPA client id                    | -                                                     | `NEXT_PUBLIC_ENTRA_CLIENT_ID`         | `entraWebClientId`                                       | `00000000-0000-0000-0000-000000000000`                              |
| Authority                        | -                                                     | `NEXT_PUBLIC_ENTRA_AUTHORITY`         | derived: `https://login.microsoftonline.com/<tenant-id>` | -                                                                   |
| API scope requested by the SPA   | -                                                     | `NEXT_PUBLIC_ENTRA_API_SCOPE`         | `entraApiScope`                                          | `api://<api-client-id>/access_as_user`                              |
| Auth mode                        | `AUTH_MODE=entra`                                     | `NEXT_PUBLIC_AUTH_MODE=entra`         | fixed                                                    | -                                                                   |

`NEXT_PUBLIC_*` values are baked into the web image at build time; the deploy script reads them from the stage-1 output `webBuildArguments`. Changing the Entra registration therefore means rebuilding the web image.

### Which audience and issuer?

The audience and issuer depend on the **access token version**, which is why step 3 of section 3 requests v2:

| Token version                                       | `iss`                                                | `aud`                                      |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| v2 (`requestedAccessTokenVersion` = 2, recommended) | `https://login.microsoftonline.com/<tenant-id>/v2.0` | the API's client id (a GUID)               |
| v1 (the default when unset)                         | `https://sts.windows.net/<tenant-id>/`               | the Application ID URI `api://<client-id>` |

Set `ENTRA_AUDIENCE` to exactly the `aud` your tokens carry. Do not guess: obtain a token for a test user and decode its payload locally (the payload is not secret to the signed-in user, but do not paste tokens into third-party sites or tickets):

```powershell
node -e "const t=require('fs').readFileSync(0,'utf8').trim().split('.')[1]; console.log(JSON.stringify(JSON.parse(Buffer.from(t,'base64url').toString()),null,2))"
# then paste the token on stdin and press Ctrl+Z (Windows) / Ctrl+D (Unix) and Enter
```

Check: `iss` matches your configuration, `aud` equals `ENTRA_AUDIENCE`, `tid` is a key of `ENTRA_TENANT_MAP`, `roles` lists the assigned app roles, `scp` contains `access_as_user`.

## 6. Tenant mapping and multi-tenant use

`ENTRA_TENANT_MAP` is the only place where an Entra tenant becomes a CaseGuard tenant: the tenant of a request is derived from the validated token's `tid`, never from the request body or query (docs/THREAT_MODEL.md T2). A token from a tenant that is not in the map must be rejected. The seeded demo tenants are `tenant_contoso_support` (demo) and `tenant_fabrikam_lab` (isolation tests); map your own Entra tenant to the demo tenant for a single-tenant demo:

```json
{ "00000000-0000-0000-0000-000000000000": "tenant_contoso_support" }
```

A multi-tenant app registration (accounts in any organizational directory) additionally needs one entry per allowed customer tenant and an admin-consent flow in each; keep the registration single-tenant unless you need this.

## 7. GitHub Actions OIDC for deployment

Goal: the deployment pipeline authenticates to Azure with a short-lived token minted from GitHub's OIDC identity. There is **no client secret, certificate or personal access token to store or rotate**.

1. **Create a deployment identity per environment** (do not share one across dev and prod). Either:
   - an Entra **app registration** + service principal (`CaseGuard Deploy (dev)`), or
   - a **user-assigned managed identity** (`az identity create`).
2. **Add a federated credential** to it for each GitHub environment that may deploy:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Audience: `api://AzureADTokenExchange`
   - Subject (exact match): `repo:<org>/<repo>:environment:<environment name>` (for example `repo:<org>/<repo>:environment:production`). Use `repo:<org>/<repo>:ref:refs/heads/main` only for non-protected automation, and never a `pull_request` subject on an identity that can write.

   ```powershell
   # app registration variant (credential.json holds name, issuer, subject, audiences)
   az ad app federated-credential create --id <deployment-app-object-id> --parameters credential.json
   # managed identity variant
   az identity federated-credential create --name github-production --identity-name <identity name> --resource-group <rg> --issuer https://token.actions.githubusercontent.com --subject repo:<org>/<repo>:environment:production --audiences api://AzureADTokenExchange
   ```

3. **Grant Azure roles** at the narrowest scope that works:
   - the **deploy** identity: Contributor on the subscription (the template creates the resource group) plus **Role Based Access Control Administrator** with a condition that allows assigning only AcrPull, Key Vault Secrets User, Storage Blob Data Contributor, Search Index Data Contributor and Cognitive Services OpenAI User (or User Access Administrator if your policy allows);
   - a separate **what-if** identity for pull-request/preview jobs: Reader plus a custom role that allows `Microsoft.Resources/deployments/whatIf/action`.
4. **Configure GitHub**: create the Environments (`dev`, `staging`, `production`) with required reviewers for production; store `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` as environment variables (they are identifiers, not secrets); never create an `AZURE_CLIENT_SECRET`.
5. **Workflow shape** (reference only; the real workflows live in `.github/workflows/` and use `azure/login@v3`):

   ```yaml
   permissions:
     id-token: write # lets the job request the OIDC token
     contents: read
   jobs:
     deploy:
       environment: production
       steps:
         - uses: azure/login@v3
           with:
             client-id: ${{ vars.AZURE_CLIENT_ID }}
             tenant-id: ${{ vars.AZURE_TENANT_ID }}
             subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
   ```

6. **Protect the trust relationship**: anyone who can change the workflow or approve the environment can deploy. Require code-owner review for `.github/workflows/**` and `infra/**`, restrict the environments to protected branches, and keep the production approvers separate from the authors.

The application itself uses **managed identity** at runtime; the only secrets in the system are the optional dev-mode PostgreSQL password (stored in Key Vault) and anything an operator adds there.

## 8. Troubleshooting sign-in

| Symptom                                  | Likely cause                                                                            | Check                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS50011` (reply URL mismatch)       | The web URL is not registered as a **SPA** redirect URI                                 | App registration > Authentication                                                                                           |
| `AADSTS65001` (consent required)         | The SPA lacks admin consent or the pre-authorization                                    | API permissions, "Authorized client applications"                                                                           |
| `AADSTS50105` (user not assigned)        | Assignment required and the user/group has no app role                                  | Enterprise application > Users and groups                                                                                   |
| API answers 401 to a valid-looking token | `iss` or `aud` mismatch (v1 vs v2 token), expired token, clock skew, JWKS not reachable | decode the token locally; compare with `ENTRA_ISSUER`/`ENTRA_AUDIENCE`                                                      |
| 401 only for one tenant                  | `tid` missing from `ENTRA_TENANT_MAP`                                                   | API log lines with `event` = `auth.failure` and `reason` = `unknown_tenant` (see [docs/OBSERVABILITY.md](OBSERVABILITY.md)) |
| 403 after sign-in                        | No app role in the token, or the role is not in `ENTRA_ROLE_MAP`                        | the `roles` claim                                                                                                           |
| Works locally, fails in Azure            | Local runs use persona login; Azure never does                                          | `AUTH_MODE` of the running revision                                                                                         |

See also: [docs/DEPLOYMENT.md](DEPLOYMENT.md), [docs/THREAT_MODEL.md](THREAT_MODEL.md), [docs/runbooks/secret-exposure-response.md](runbooks/secret-exposure-response.md).
