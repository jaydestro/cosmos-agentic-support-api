# Azure proof (real Azure, 2026-11-01)

> **Evidence label: AZURE.** Everything here ran against real Azure resources in resource group `rg-resolve-proof`,
> region **East US**, subscription "Cosmos DB Backend Testing". Emulator evidence is kept apart in
> [emulator-cosmos-design.md](emulator-cosmos-design.md). Subscription ids, client ids and tokens are not published.

## What was deployed

`infra/main.bicep` through `az deployment group create` (deployment `resolve-proof-api`, state **Succeeded**), then the
packaged app through `az functionapp deployment source config-zip` ("Deployment was successful").

| Item | Read-back |
|---|---|
| Hosting | Function app `kind=functionapp,linux`, plan SKU `FC1` (Flex Consumption), runtime `node` **24**, 2,048 MiB, max 40 instances, HTTP concurrency 16, `alwaysReady: []` (none) |
| Cosmos DB | `kind=GlobalDocumentDB`, capability `EnableServerless` only, one location (East US), `publicNetworkAccess: Disabled`, `disableLocalAuth: true`, Periodic backup, no throughput set on database or any of the four containers (`reference`, `cases`, `provider`, `leases`) |
| Private link | Private endpoint connection `Approved`; private DNS zone `privatelink.documents.azure.com` linked to the VNet with `A` records `10.42.2.4` and `10.42.2.5` |
| Identity | Two user-assigned managed identities (app, seeder) with five container-scoped native data-plane roles; the deployment contained no Azure RBAC role assignment |
| Ingress | HTTPS only, public; `GET /api/health` and `/api/ready` return `200 {"status":"ok"}` from the internet (readiness pings Cosmos DB through the private endpoint, so the host reaches it with its managed identity) |

Note on "no throughput": for a serverless account ARM still returns a read-only placeholder from
`az cosmosdb sql container throughput show` (a fixed `5000` with minimum `400` and no autoscale). No template property sets it and the
account has no provisioned capacity; the capability list is the authoritative read-back.

## Choices and honest deviations

1. **Region: East US.** The resource group was created there, Flex Consumption and Node 24 were confirmed there, and
   `isSubscriptionRegionAccessAllowedForRegular` was true for Cosmos DB. This is a decision made without a user prompt.
2. **Numeric limits (unchanged from the code, chosen for safe usage):** 3 active investigations and 25 cases per UTC day per tenant;
   maximum 40 Flex instances; Log Analytics ingestion cap 1 GB/day (a cap, not a bill limit); live model **not configured**
   (`AGENT_MODE=demo`), so there is no model spend.
3. **Supporting-service keys fallback (deviation).** The deploying identity (`jagord@microsoft.com`) has Contributor but ARM denies
   `Microsoft.Authorization/*/Write`, so the storage and Application Insights role assignments of the default
   `supportingAuth=identity` mode cannot be created. The template gained `supportingAuth=keys`, used here: the Functions host and
   deployment storage use a storage connection string and telemetry uses its connection string. The organisation policy
   *"Azure Storage Policy to disable local auth - Opt In"* denied the first validation; the storage account therefore carries that
   policy's documented opt-out tag `Az.Sec.DisableLocalAuth.Storage::Skip`. **This is a recorded policy exception on one storage
   account. It must be removed by redeploying with `supportingAuth=identity` after an administrator runs
   `infra/deployment-access.bicep`.** Cosmos DB access is managed identity in both modes and was not affected.
4. **No real Entra app registration (blocker).** `az ad app create` was refused: the tenant requires a `ServiceManagementReference`
   that this session does not have. `ENTRA_AUDIENCE` is an unregistered `api://` placeholder, so **no user-delegated Entra token for
   the API could be obtained**. The sign-in page is therefore reachable but real browser sign-in is **not proven**.
5. **Seeding and the end-to-end driver ran from inside the VNet** in an Azure Container Instance on the delegated `seed-runner`
   subnet (`tools/azure/run-in-vnet.ps1`), with both managed identities attached. The container receives code from an Azure Files
   share. The driver (`tools/azure/prove.ts`) calls the real handlers in-process with **synthetic principals** (no Entra), against the
   real Cosmos account, while the **deployed Functions host's change-feed trigger** does the investigation and the credit
   execution. That separates what Azure proved (Cosmos, identity, network, trigger, leases) from what stays unproven (Entra tokens).
6. **GitHub OIDC deployment was not used.** The deployment identity has no role grants (same RBAC limit), so deployment used the
   operator's own `az` session. `azure-proof.yml` remains prepared, not executed.

## Denials from outside the network (laptop, valid Entra token)

| Check | Result |
|---|---|
| Account host DNS from outside | CNAME chain to `...privatelink.documents.azure.com` then a **public** address (`52.191.41.131`) |
| Cosmos data plane with a valid `https://cosmos.azure.com` AAD token from the public internet | **HTTP 403** `Request originated from IP ... through public internet. This is blocked by your Cosmos DB account firewall settings.` |
| `GET /api/cases` with no token | **401** `unauthenticated` |
| `GET /api/cases` with a real Entra token for the wrong audience (Azure Resource Manager) | **401** `unauthenticated` |
| `GET /api/cases` with a malformed bearer | **401** |

The token denials are real Entra-issued tokens rejected by the API's validation. Role and tenant denials *with* a valid API-audience token
are **not proven** (item 4).

## Inside the network (container instance, app and seed managed identities)

Log of the proof run: [azure-proof-run.log](azure-proof-run.log) (the first seed run that created the documents is in
[azure-first-seed-run.log](azure-first-seed-run.log)). Headline results:

| Check | Result |
|---|---|
| Private DNS | `resolve-uppm5pw6szybo.documents.azure.com` resolves to **10.42.2.4** (private) |
| Cloud seed, run 1 | 56 documents created, read-back 56 checked / 0 missing / 0 mismatched |
| Cloud seed, run 2 (repeat) | 0 created, **56 unchanged**, 0 drift, read-back clean (non-destructive repeat) |
| Seed identity reads `cases` / `provider` | **403** / **403** (real Cosmos RBAC) |
| App identity deletes a provider record | **403** |
| App identity writes a `reference` document | **403** (the final run exits 0; the earlier run printed `HTTP 0` because the SDK error carries `statusCode`, fixed in `prove.ts`) |
| App identity reads reference data | positive: 46 documents for tenant `aurora`, 2.99 RU |
| App identity reads `leases` | positive: 2 lease documents (the deployed trigger holds them) |
| Case creation, identical idempotency-key replay | 202, 202 (same case) |
| Same key, different body | 409 |
| Other tenant reads the case | 404 |
| Representative approves | 403 |
| Investigation | performed by the deployed trigger; proposal v1 waits for a human, no compute held |
| Approval bound to a stale digest | 409 |
| Eight concurrent approvals (6 from one approver, 2 from another) | run A: 202 x6 and 409 x2; final run: 202 x2 and 409 x6. Timing decides which callers see the idempotent replay and which see the conflict; the result is the same: one decision, one credit |
| End state | case `credited`, 4,900 minor USD, simulated provider |
| **Provider ledger records for the case** | **1** |
| Second create of the same provider key | 409 (create-only deduplication) |
| Point read | 1.00 RU |
| Partition-scoped parameterized query (23 documents) | 3.86 RU |
| Tenant listing with `tenantId` filter and no partition key option | 2.96 to 3.03 RU; `listCases` handler 200 with 3 to 4 items |
| Replace with a stale ETag | 412 |
| Timeline page 1 | 5 items with a continuation token |

## A bug the emulator hid

The first Azure proof run failed at the tenant listing: `container.items.query(..., { partitionKey: ['aurora'] })` (a
**prefix** of the hierarchical key `[tenantId, caseId]`) answered **HTTP 400** "Partition key provided either doesn't
correspond to definition in the collection". The emulator accepted it, so all local tests passed. A probe on Azure compared variants:

| Variant | Azure result |
|---|---|
| `partitionKey: ['aurora']` | **HTTP 400** |
| no partition key option, `WHERE c.tenantId = @tenantId` | 2 rows, 2.96 RU |
| same with `maxItemCount: 5` | 2 rows, 2.96 RU |

`src/cases/store.ts` now passes no partition key option for tenant listings (`listCases`, `listWork`) and relies on the `tenantId`
filter. It would have broken `GET /cases` and operator work listing on Azure. After the fix the 130 service-backed tests still pass on
the emulator and `listCases` returned 200 on Azure.

## Metered usage and cost

| Quantity | Value | Source |
|---|---|---|
| Cosmos DB requests, window from first deployment to the final proof run (Azure Monitor, may lag) | 116,211 | Azure Monitor `TotalRequests` |
| Cosmos DB request units, same window | about 13,000 RU | Azure Monitor `TotalRequestUnits` |
| Of which a single proof run | well under 100 RU of explicit calls | the per-call RU lines above |
| Change-feed polling with no cases | about 46,000 requests per hour | metric trend while idle |
| Dollar cost | **not measured** | billing data had not posted; no estimate is presented as a measurement |

The finding for serverless: the trigger's lease and change-feed polling dominates request count even when idle. Each call is cheap, but it is
not free, and the private endpoint, storage, Application Insights and the Container Instance add hourly or per-GB charges
that are likewise **not measured**.

## Not proven on Azure

Real user-delegated Entra tokens and role/tenant denials with an API-audience token; real browser sign-in; Application Insights
correlation (not queried); GitHub OIDC deployment; live-model behaviour (not configured); deployment with
`supportingAuth=identity`.
