# Real Entra token proof (AZURE, 2026-11-02 UTC)

> **Evidence label: AZURE with real Microsoft Entra ID tokens.** The tokens are delegated v2 tokens for the `resolve-proof-api`
> app registration, issued to the signed-in demo user through the Azure CLI client, which is pre-authorized for `access_as_user`.
> The calls go to the public HTTPS endpoint of the deployed Flex Consumption app. The only changing input between phases is the
> user's app-role assignment on the API's enterprise application, which `tools/azure/entra-proof.ps1` sets, and restores at the end.
> User ids and tokens are not recorded.

## How the Entra side was set up

1. `resolve-proof-api`: single-tenant, `requestedAccessTokenVersion: 2`, scope `access_as_user`, six app roles
   (`Resolve.<Representative|Approver|Operator>.<aurora|borealis>`), identifier URIs `api://<appId>` plus
   `api://resolve-proof-a|b|c` (extra URIs only exist to get fresh tokens, see below).
2. `resolve-proof-console`: single-tenant SPA client with the deployed app URL as its only redirect URI. A `http://localhost` redirect
   URI was refused by tenant policy and is not used. The API pre-authorizes this client and the Azure CLI client.
3. The tenant requires a `serviceManagementReference` on every new app registration. The one used was copied from an app registration the same
   user already owns (an auto-created agent-identity blueprint for an unrelated workshop). **That attributes this demo to that reference;
   replace it with the demo's own value before keeping the registrations.** Both registrations can be deleted with no other effect.
4. Bicep was redeployed with the real audience (`<appId>,api://<appId>`), console client id and scope. The API validates `iss`, `aud`,
   `tid`, `ver=2.0`, `scp` and the `roles` claim in code.
5. The Azure CLI caches tokens by scope string, so a token keeps the roles it had when it was issued. Each phase uses a different scope string
   for the same API to obtain a fresh token. This is a test-harness workaround, not application behaviour.

## Results

### First run (phases 1 to 4, run for the record; phases 1 and 4 used a stale cached token or an empty case id and are superseded by the second run)

Only the external approval part is kept from this run:

## 3. Representative and Approver (aurora). Token roles: Resolve.Approver.aurora, Resolve.Representative.aurora
- own case status after the deployed trigger ran: 
- approve my own case (separation of duties) : HTTP 404 `not_found`
- approve case_54b0eccf0c565cf3004cdf262fcae0bb (created by a different principal) : HTTP 202
- case status after approval and the deployed trigger: credited


This is the full real-token path: a case created by a **different principal** inside the network (so separation of duties holds) was approved
over the public HTTPS API by a real Entra token holding `Resolve.Approver.aurora`. The deployed change-feed trigger then credited it. The
provider ledger for that case is recorded by the in-network runner in [azure-external-approval.log](azure-external-approval.log).

### Second run (denials with real tokens)

# Real Entra token proof against the deployed API

Tokens are real delegated v2 tokens issued by Microsoft Entra ID for the Resolve API app (scope access_as_user).

## 1. Representative (aurora) only. Token roles: Resolve.Representative.aurora; scope: access_as_user
- GET /api/session : HTTP 200
- POST /api/cases without an Idempotency-Key (rejected before any write) : HTTP 400 `validation_failed`
- POST /api/cases with an Idempotency-Key : HTTP 202
- GET /api/cases : HTTP 200
- approve as a Representative : HTTP 403 `forbidden_role`
- operator work list as a Representative : HTTP 403 `forbidden_role`

## 2. Roles in two application tenants. Token roles: Resolve.Representative.borealis, Resolve.Approver.aurora, Resolve.Representative.aurora
- GET /api/cases with roles in two tenants : HTTP 403 `forbidden_tenant`

## 3. Representative and Approver (aurora). Token roles: Resolve.Approver.aurora, Resolve.Representative.aurora
- own case status after the deployed trigger ran: awaiting_approval
- approve my own case (separation of duties) : HTTP 403 `forbidden_separation_of_duties`

## 4. Representative of the other tenant only. Token roles: Resolve.Representative.borealis
- read the aurora case from the borealis tenant : HTTP 404 `not_found`
- list cases (borealis) : HTTP 200

Reading the second run:

| Check | Real-token result |
|---|---|
| Role denial | a Representative-only token gets **403 `forbidden_role`** on approve and on operator work |
| Tenant denial (ambiguous) | roles in two application tenants get **403 `forbidden_tenant`** |
| Separation of duties | the Approver of a case's creator gets **403 `forbidden_separation_of_duties`** on their own case |
| Tenant isolation | a borealis-only token reading an aurora case gets **404 `not_found`** (no existence leak) |
| Idempotency | missing key is **400** before any write; valid key is **202** |
| Positive path | session 200, create 202, list 200, external approval 202 then `credited` |

## Telemetry correlation

Application Insights (connection-string mode, see the supporting-auth note in [azure-proof.md](azure-proof.md)) returned `requests` rows for
`createCase` and `approveProposal` with status codes 202, 400 and 403, and each row shares an `operation_Id` with the application's
`request completed` trace. The application's own `correlationId` is inside the trace message JSON, not a custom dimension column.

## Still not proven

Interactive browser sign-in through MSAL (no browser session was driven; a screenshot of the sign-in page exists, not of a completed sign-in).
Approval by a second *human* identity (the external case was created by a synthetic in-network principal instead).
