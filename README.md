# Resolve

Resolve is a public, serverless **sample** for synthetic SaaS billing disputes. A support
representative submits a case. An agent investigates invoices and a versioned credit policy,
proposes a cited credit (or reports a finding), and then **waits for an authorized human**.
After approval, deterministic code issues exactly one **simulated** credit.

> **Simulated credits only.** There are no real payments and no real customer data. Every
> account, invoice, policy and person in this repository is fictional. This is a working
> sample, not a production certification.

The authoritative requirements live in [.github/copilot-instructions.md](.github/copilot-instructions.md).
This README holds the short plan, the decisions made along the way, the actual layout, the
versions in use, and the commands that have actually been executed.

## Status

| Stage | Scope | Status |
|---|---|---|
| P01 | Preflight and plan | **done** (this file; evidence below) |
| P02 | Foundation: contract, scaffold, config, auth, client/reference, fixtures, guarded seeder | **done** (emulator-backed; see "Verified commands") |
| P03 | Investigation: cases, evidence reads, bounded runs, cited proposals, approval wait | **done** (emulator-backed; see "Verified commands") |
| P04 | Decisions and execution: approve/reject/revise, outbox, provider, recovery | **done** (emulator-backed; see "Verified commands") |
| P05 | Browser console and bounded live-model adapter | **local implementation verified**; real Entra/model checks blocked pending configuration and paid-run approval |
| P06 | Shared local/CI checks and GitHub Actions gates | Prior full local gate passed; **actual GitHub check now fails on the newly published development-dependency advisory** |
| P07 | Deployment: Bicep vs azd comparison, validation, private networking, OIDC | Bicep compiles; 4 local policy checks pass; **cloud validation/deployment/acceptance blocked pending approvals and configuration** |
| P08 | Repository assistance (GitHub Agentic Workflows) and completion | 2 bounded workflows compiled/validated; reviewer workflow registered but skipped by the approval gate; **actual agent execution remains blocked** |

An unexecuted check is **blocked, not passed**. Working branch:
`feat/resolve-serverless-sample`. Merge, deployment and testing were requested on
2026-10-31; the implementation is committed and pushed as
[draft PR #1](https://github.com/jaydestro/cosmos-agentic-support-api/pull/1).
It is not merged and no Azure provisioning has occurred.
Sanitized delivery evidence is kept in [docs/blog-outcomes.md](docs/blog-outcomes.md).

The complete local gate passed on 2026-10-30 (see P06). The publication/deployment
approval form could not obtain a user response; that is **not authorization**.
No commit, push, merge, paid provisioning, live-model call, GitHub workflow run,
deployment-region selection or license change was performed. P07/P08 remain
externally blocked rather than being marked complete.

**2026-10-31 audit update:** a subsequently published minimatch advisory now fails
the full audit (one moderate advisory across 13 development-dependency entries).
Production-only audit remains clean. Patch availability and any explicit,
temporary exception must be resolved before treating publication checks as passed;
the dated zero-vulnerability result below remains historical, not current.
The [first GitHub check](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41230031305)
ran and failed at that audit after passing all 2,066 unit tests. This is not
reported as a successful CI or deployment run.

## Short plan

1. **Contract first.** `contracts/openapi.yaml` (OpenAPI 3.1) is authored before any handler.
   A typed client, request/response validation and an interactive reference are generated from it.
2. **Cosmos DB for NoSQL, serverless, one region.** No throughput is set on any database or
   container (including `leases`). Hierarchical partition key `[/tenantId, /caseId]` keeps every
   case-scoped transaction inside one logical partition.
3. **Azure Functions v4 (TypeScript) on Flex Consumption.** HTTP functions authenticate Entra
   tokens in code. A Cosmos DB-triggered function executes the outbox at least once.
4. **Agent investigates, code decides.** The model sees only allowlisted read tools and a
   `submit_proposal` tool. Code enforces evidence rules and credit limits. The model can never
   approve or execute a credit.
5. **Human approval releases compute.** The pending proposal is a persisted document; nothing
   runs while it waits. Decisions are bound to proposal and policy versions and revalidated at
   execution.
6. **One effect.** The simulated provider has stable idempotency keys and result lookup. The
   executor reconciles provider state before acknowledging locally and before any second attempt.

## Decisions

All of these were resolved autonomously for P01 and are open to review. Numeric limits are
**proposals**: the deterministic demo mode may use them because it costs nothing, but they must
be agreed before any paid live-model run or Azure provisioning.

### Identity, roles and separation of duties

- Entra **app roles** carry the application tenant: `Resolve.Representative.<tenant>`,
  `Resolve.Approver.<tenant>`, `Resolve.Operator.<tenant>` with tenant keys `aurora` and
  `borealis` (fictional). Role values stay under 120 characters and use only `.`, letters and
  digits, which Entra allows. Application tenants share one Entra directory.
- A principal whose roles name zero or more than one application tenant is rejected (403).
- Tokens are validated in code: signature (JWKS), `iss`, `aud`, `exp`/`nbf`, `tid`, `ver`,
  `oid`, and `scp` containing `access_as_user`. App-only tokens are rejected.
  Function keys, CORS, identity headers and model output never authorize anything.
- **Representative:** submit, list and read cases of their own tenant.
- **Approver:** approve or reject proposals of their own tenant. **Maker-checker rule:** an
  approver may not decide a case they created.
- **Operator:** inspect and recover work of their own tenant (requeue poison or recoverable
  work, resume budget-exhausted runs with an explicit allowance). An operator cannot approve,
  reject or create credits, and recovery never skips authorization or revalidation.
- Revision requests (after a rejection, expiry or stale version) may be made by a representative
  or approver of the tenant. A revision creates proposal version N+1 that needs fresh approval.

### Idempotency (case creation)

- **Scope:** `(tenantId, representative oid, Idempotency-Key)`. Keys are 16-64 characters of
  `[A-Za-z0-9._~-]`.
- The case id is derived deterministically from that scope, so the case, the idempotency
  record (with the stored original response), the first timeline item and the
  `investigation.start` outbox item are written in **one transactional batch** in one logical
  partition.
- Identical input replays the original `202` with `Idempotency-Replayed: true`. The same key
  with a different canonical-JSON SHA-256 returns `409`. A losing concurrent create re-reads
  and re-evaluates instead of failing blindly.
- **Retention:** the idempotency record lives exactly as long as the case document, so replay
  works for the case's lifetime. The sample never deletes cases. The documented operator purge
  procedure (90-day sample retention) removes a whole case partition, which also removes its
  key. Only ephemeral documents (admission counters) use item TTL.

### Approval expiry and time accounting

- A pending proposal expires **72 hours** after it is submitted (`APPROVAL_TTL_SECONDS`; Azure
  accepts 1-168 hours, local/CI accepts 2 seconds upward so expiry can be tested). Expiry is
  evaluated from `approvalExpiresAt` on every read and decision attempt,
  so no timer or sweeper is needed. An expired proposal cannot be approved; a revision request
  produces a fresh proposal.
- Approval wait time is **not** active time. The run's active-time budget only counts time
  spent executing steps.

### Execution limits (proposed; gated before paid execution)

| Limit | Value |
|---|---|
| Steps per run | 8 |
| Tool calls per run | 12 |
| Model calls per run (live) | 8 |
| Tokens per run (live) | 30,000 |
| Cost per run (live) | USD 0.25 (dated pricing table; unknown price means the run is blocked) |
| Retries per call / per run | 2 / 4 |
| Active time per run | 90 s |
| Resume | at most 2 explicit allowance grants, each no larger than the base limits |
| Revisions per case | 3 |
| Approval expiry | 72 h |
| Concurrent active runs per tenant | 3 |
| New cases per tenant per UTC day | 25 |
| Live-model cost per tenant per UTC day | USD 2.00 |
| Outbox attempts | 5, in-invocation backoff 1 s, 2 s, 4 s, 8 s, then `poison` |
| Outbox claim lease | 120 s (must outlast the 90 s active-time cap; asserted by a unit test) |
| Request body | 16 KiB; description 4,000 characters |
| Page size | 20 default, 50 max (timeline 50 / 100) |

Allowances are reserved with an ETag-conditional write **before** each call and persisted in the
run document. Exhaustion stops the run before the next call. Resume needs an authorized
operator and a recorded grant; usage is never reset. Usage events mark each figure as
`measured`, `estimated`, `unknown` or `not_applicable` (deterministic demo). Unknown is not zero.

**Local and CI test stack.** The shared integration stack runs many cases through the same two
fictional tenants, so it raises only the two admission limits, to 100 concurrent runs and 1,000
new cases per UTC day (`RESOLVE_LIMIT_TENANT_CONCURRENT_RUNS`,
`RESOLVE_LIMIT_TENANT_CASES_PER_UTC_DAY`). The configuration accepts such a raise only when
`RESOLVE_ENV` is `local` or `ci`, and never above those caps. Every dimension that carries cost
(model calls, tokens, cost, live cost per day) can only be lowered, and all overrides are refused
on `azure`. Refusal at the admission limits is proven at the store and handler level, not over
HTTP in the shared stack.

### Data layout (Cosmos DB, serverless)

| Container | Partition key | Contents |
|---|---|---|
| `reference` | `/tenantId` | seeded accounts, invoices, versioned credit policies (written only by the guarded seeder) |
| `cases` | `[/tenantId, /caseId]` (hierarchical) | case, idempotency record, run + usage counters, usage events, proposals, decisions, timeline items, outbox work, credit results, and the per-tenant admission counter |
| `provider` | `/tenantId` | ledger of the simulated credit provider (document id = the provider idempotency key). Kept apart from `cases` because the provider is an external system and no transaction may span it |
| `leases` | `/id` | change feed leases for the outbox trigger (provisioned empty; created without throughput) |

`infra/containers.json` is the **single source** of these definitions: the local provisioner
reads it today and Bicep will load it with `loadJsonContent` in P07.

- Every document has `type` and `schemaVersion`. Ids avoid `/ \ ? #`.
- A single singleton `CosmosClient` per process; all queries are parameterized and tenant-scoped.
- Lists use **keyset pagination** on a synthetic `sortKey` (`<ISO time, ms>~<id>`, so ordering is
  total and stable) or on `seq` for timelines, with `SELECT TOP @top` (`limit + 1` to learn
  whether another page exists) and opaque base64url cursor tokens. The API `continuationToken`
  is that cursor. The emulator ignored `maxItemCount` for `ORDER BY` queries, so page size is
  enforced in the query, not by the SDK.
- **Verified on the emulator (SDK 4.10.1), not on Azure.** `items.batch` accepts hierarchical
  partition keys. A create conflict returns `207 [424, 409]` and a stale `ifMatch` returns
  `207 [412, 424]`, each rolling the whole batch back; the SDK refuses a batch of more than 100
  operations before sending it, and results are mapped by operation index. Prefix-key queries
  (`partitionKey: [tenantId]`) work with `ORDER BY` and `SELECT TOP @top`, but `maxItemCount: 1`
  with `fetchNext()` returned both rows and no continuation token, so prefix queries never use SDK
  continuation tokens.
- **Tenant admission.** One counter document per tenant, in its own partition
  `[tenantId, '_tenant']`, holds the UTC day's case count, the live cost so far and one slot per
  active run (`<caseId>:<runId>`). It is a different logical partition from the case, so it is a
  separate conditional write: a slot is taken before the case is written, expires after 10
  minutes if nothing releases it, is released when the run reaches a terminal state, and is given
  back if the create then fails. Contention is retried up to 6 times, then answered `429
  tenant_admission_busy`.
- Case listing is a hierarchical-prefix query (`[tenantId]`, `type = 'case'`) ordered by the single
  property `sortKey DESC`. Every list query pairs a filter with a single-property `ORDER BY`, which
  the default range index serves, so **no composite index is declared** (the skill's
  `index-composite` rule is about multi-property `ORDER BY`). A composite such as
  `(accountId, sortKey desc)` for invoice listing might lower RU cost; that is an **unmeasured
  optimization to evaluate in Azure**, not a requirement. The `cases` indexing policy excludes only
  free-text and snapshot paths that are never filtered or sorted (`description`, `revisionReason`,
  `explanation`, `decision/reason`, `summary`, `data/*`, `snapshot/*`); an `ORDER BY` on an
  excluded path would fail, so new queries must be checked against that list. **The emulator does
  not enforce index policies**, so index behaviour and RU cost are validated in Azure, not locally.
- Timeline and usage items are separate documents, so no history is embedded in a case document.
  Ordinary documents are not tamper-proof; the audit trail is append-only by convention and
  conditional writes, not by cryptographic guarantee.

### Outbox and recovery

- Decision, state transition and outbox item are committed in **one batch in one logical
  partition**; the external provider is never part of a transaction.
- The Cosmos DB trigger filters `type = 'outbox'` in code (the trigger delivers all changes). A
  handler claims an item with an ETag-conditional update and a lease (120 s), runs bounded
  retries with persisted attempt counters, and ends in `completed`, a scheduled retry, or
  `poison`.
- **Verified against Core Tools 4.15.2:** when a trigger invocation throws, the batch is logged as
  failed and the change feed **is not redelivered**. The Cosmos DB outbox document, not the
  trigger, is therefore the source of truth: the processor never throws on a handled failure,
  it records the attempt and the next-due time on the item. Retries are bounded by
  `maxAttempts` (5) with the backoff above; only waits under 10 s are slept in-process.
- A crash while holding a claim is recovered by the expired claim lease. An item whose lease
  expired and that nobody re-triggered is listed as *recoverable* for the operator (see
  "Decisions, execution and recovery"). There is no timer sweeper, and host-level Functions retry
  policies are not relied on. The gap is real: a claimed item with a live lease is left alone and
  nothing delivers it again once the lease lapses, until an operator requeues it (proven on the
  real stack).
- Lease takeover after a hard kill of the host took about 50-60 s with the default trigger
  timings on the local stack; the stack tunes them lower (see below). The trigger polls even when
  idle: at the default 5 s feed poll that is 17,280 polls per day per lease, each charged some
  RUs. The real RU figure is **unmeasured** (the emulator does not model RUs), so idle polling is
  a standing cost to measure in Azure and to list in the operating-cost section.

### Agent and tools

- Tool allowlist: `get_account`, `list_invoices`, `get_invoice`, `get_policy`, `submit_proposal`
  (a credit proposal or a finding). Arguments are schema-validated; case text and retrieved
  text are treated as untrusted data.
- Code classifies the evidence as consistent, missing or contradictory. Missing or
  contradictory evidence produces a **finding**, never an invented credit.
- **Kernel.** `src/agent/adjudicate.ts` is the one place that decides what the evidence and the
  policy allow. It is pure and total, and every sentence of the explanation it produces is built
  from identifiers and numbers, never from invoice line text or the case description. The most it
  accepts as a credit is the lowest of the clause cap, the eligible amount (the clause's optional
  `creditRateBasisPoints` applied; absent means the full amount) and the requested amount. A credit
  must cite every invoice it rests on (at most 10 references). A finding cites the clause that
  governed it.
- **Guard.** `src/agent/guard.ts` accepts a proposal only if it fits what the kernel derives from
  the same retrieved evidence, whoever proposed it: it never trusts the proposer's amount, policy
  reference, invoice references or assessment. The investigator's own note is stored beside the
  code-written facts, clipped, never instead of them.
- **Proposals.** A credit proposal is `pending_approval` and expires 72 hours after submission. A
  finding is `reported`, has no amount and no expiry, and needs no approval. The proposal digest
  (canonical-JSON SHA-256, including the case id) is what a decision binds to, with the policy
  version.
- **Budget.** `src/agent/budget.ts` reserves the allowance before every call and settles it
  afterwards. A failed or ambiguous call is charged at its reservation (unknown is not zero). A
  call may overshoot a limit once (a soft limit); the overshoot is recorded and the next
  reservation fails. Counters only increase. Every exhaustion reason stops the run as
  `budget_exhausted`, and only an authorized, recorded allowance can continue it (see
  "Decisions, execution and recovery").
- **Demo investigator.** Deterministic and free. Its plan is: the account, the policy, each cited
  invoice (or, for a duplicate charge that cites fewer than two, the newest invoices of the
  account), then one proposal, at most eight calls. Each call counts as a step, and token and cost
  usage is recorded as `not_applicable`. The guard checks it exactly as it would check a model.
- **Runner.** The `investigation.start` outbox work reads everything from the stored case, so a
  redelivered or post-crash invocation starts from stored state. Each call is two atomic batches
  (reserve, then settle). The accepted proposal is stored in the same batch that completes the
  run and releases the tenant's admission slot, so the pending proposal is durable in the write
  that releases the compute. A crash leaves at most one `reserved` event, which the next attempt
  settles as `ambiguous`; that budget is never refunded, so a restarted run may legitimately stop
  as `budget_exhausted` and need an operator resume. A write that loses a race fails the work item
  with `run_conflict` and the outbox retries it from a fresh read.
- Deterministic demo mode and live mode share the dispatcher and budget layer. Live mode is
  blocked (and says so: `live_not_approved` or `live_not_configured`) unless explicitly configured
  and approved. It never falls back to demo. The P05 adapter is described below.

### Decisions, execution and recovery

- **Who decides.** Only an `Approver` of the case's tenant approves or rejects, and an approver
  may **not** decide a case they created (maker-checker: `403 forbidden_separation_of_duties`).
  An `Operator` can neither approve, reject nor create a credit. A decision names the proposal
  `digest` and `policyVersion` the approver saw. The checks run in a fixed order and each refusal
  has a stable code (listed in the contract): separation of duties; an existing decision (an
  identical repeat by the same approver replays the stored decision, anything else is
  `proposal_already_decided`); the proposal's status; a stale version; expiry
  (`approval_expired`); the digest; the policy version; and, **for approvals only**, that the
  cited policy version is still the one in effect (`policy_version_changed`). A rejection issues
  nothing, so it skips that last check: requiring it would strand a stale proposal until its
  window lapsed. The approval `comment` and the rejection reason are stored as the decision's
  `reason`.
- **Atomic decision.** An approval commits, in one batch in the case's partition, the case
  (`approved`), the proposal, the `decision_approved` and `execution_queued` timeline items and
  the `credit.execute` outbox item. A rejection commits the case (`rejected`), the proposal and
  a `decision_rejected` timeline item. When a competing write wins the ETag race the request
  re-reads and retries a bounded number of times, then answers `409 concurrent_update`.
- **Revision.** A `rejected`, `expired` or `finding_reported` case can be revised by a
  representative or an approver: run `N+1` investigates again, its proposal is version `N+1` and
  needs **fresh approval**. The reason is stored as untrusted data, never authorization or evidence.
  At most 3 revisions per case (4 runs). A revision request is **not idempotent**: repeating one
  that succeeded is refused because the case is no longer revisable. `proposal_superseded` is a
  defensive refusal; no code path sets a proposal to `superseded` today.
- **Execution** (`src/credits/execute.ts`) is the only code that records a credit. The
  `credit.execute` item is claimed with a lease; the stored decision and the proposal digest must
  match what was approved; the guard that accepted the proposal runs again on current reference
  data, for the policy version the approver saw (a newer version that became effective later does
  not void an approval already given); the provider is **looked up first** under the stable key
  `credit-<caseId>-v<version>`, and a credit found there is only acknowledged, never issued again;
  otherwise it is issued. One batch then records the credit result, marks the proposal `executed`
  and the case `credited`, appends `credit_executed` (or `credit_reconciled`) and completes the
  outbox item. The provider is never part of that transaction. An unavailable provider is retried
  with backoff; a conflicting provider record or a failed revalidation is permanent and ends in
  `poison`. Revalidation re-reads the case's account, the invoices the case names and the proposal
  cites, and the cited policy version. Evidence the proposal does not cite is **not** re-read, and
  a proposal cites at most 10 invoices.
- **Provider** (`src/credits/provider.ts`). A simulated ledger in its own `provider` container:
  the document id is the idempotency key, writes are create-only, and a lookup by key returns the
  stored credit. The same key never yields a second credit; a key that holds a different credit is
  a conflict. A fault plan armed per case lets tests make the provider `unavailable` (fails before
  recording) or `lose_response` (records the credit, then fails: how a provider that took effect
  looks to a caller that never saw the answer). Each use is claimed with an ETag-conditional
  write, and claiming fails open after 3 lost races. `PROVIDER_FAULTS_ENABLED` is local/CI only;
  configuration refuses it when `RESOLVE_ENV=azure`.
- **Poison.** When work becomes poison the case moves to `needs_attention` (from `approved`,
  `queued` or `investigating`) and a `work_poisoned` item is appended to the timeline. The hook
  runs after the outbox item is marked poison.
- **Operator work.** `GET /operator/work?state=` lists the operator's own tenant, newest first:
  `waiting` (a pending proposal that has not expired), `failed` (a run that failed or was
  blocked), `budget_exhausted`, and the outbox states `poison`, `recoverable` and `completed`. It
  is one query per state, `SELECT TOP @top ... ORDER BY c.workKey DESC`, scoped to the tenant's
  hierarchical prefix. `workKey` is `<createdAt>~<caseId>~<docId>`: immutable, unique and kept
  across resumes, so a single-property `ORDER BY` serves every state and no composite index is
  declared. *Recoverable* means an outbox item whose claim lease lapsed, or that stayed pending
  more than 5 minutes after it was due. Inspecting an item that is in none of these states is
  `404`; recovering one that exists is `409 recovery_not_applicable`.
- **Recovery** (`POST /operator/work/{workId}/recover`, operator only, a reason is always
  recorded in the timeline).
  - `requeue` re-arms a `poison` or `recoverable` outbox item. `attempts` goes back to 0 (the
    dead-letter redrive convention) and `lastError` is kept. The case is restored from
    `needs_attention` when the kind maps (`credit.execute` to `approved`, `investigation.start`
    to `queued`). Execution still revalidates and reconciles, so a completed credit is never
    repeated.
  - `resume` continues a `budget_exhausted` run, only the latest run of its case, with an explicit
    `allowance`. At most 2 grants per run (`409 resume_grants_exhausted`). The allowance must name
    the limit the run stopped at; each granted value is capped at the base limit and is **added**
    to the run's own limits. Nothing is reset: usage history and counters carry over, and the
    plan plays again from its start, so a resumed run re-issues its first calls and can
    legitimately use up a grant. Retry limits are never raised, so a run that stopped on retries
    accepts any allowance dimension. A resume queues the run again, so it takes one of the
    tenant's concurrent-run slots (`429 tenant_concurrency_limit` when none is free; a refusal
    takes no slot).
  - A `failed` or `blocked` run is a dead end by contract: it is listed, but it has no recovery
    action and a recover request is `409`.
  - Recoveries and revisions are **not idempotent**: a repeat is refused once the first has taken
    effect. Two simultaneous resumes converge on one grant, but two that share a millisecond can
    both report `202` for the one grant that was committed, and a requeue whose response was lost
    reports `409`.
- **Human-entered text.** Reasons (rejection, revision, recovery) are stored in timeline `data`
  as entered, are untrusted wherever they are shown or given to the agent, and are never logged.

## Layout

```text
.github/copilot-instructions.md  the authoritative requirements
.github/workflows/              deterministic checks, protected Azure proof, agentic Markdown and generated locks
.github/aw/actions-lock.json    compiler-generated repository workflow action pins
contracts/
  openapi.yaml                   OpenAPI 3.1 contract, authored first; linted with Redocly
  generated/openapi.d.ts         persistent generated types; contract:check keeps them in sync
  client/index.ts                typed client (openapi-fetch) for the console and tests
src/
  index.ts                       Functions entry point (HTTP, static and trigger registrations)
  config/                        environment parsing, numeric limits, trigger tuning, allowed hosts
  contract/                      loads the contract at start-up and builds the validators
  http/                          request pipeline, problem+json errors, cursors, readiness, static assets, route table
  auth/                          token validation (Entra, or the local test IdP), principals, roles
  domain/                        pure rules: canonical JSON and digests, ids, time, money, text clipping, policy-version derivation
  data/                          Cosmos client handles, document shapes, reference reads, error mapping
  cases/                         case aggregate documents, the case store (atomic batches), tenant admission, case creation, decisions, revisions, operator work and recovery
  agent/                         adjudication/guard, restricted tools, persisted budgets, demo/live investigators and model adapter
  credits/                       the simulated credit provider and the executor that records a credit
  outbox/                        outbox documents, claim/retry transitions, processor, handlers
  handlers/                      one handler per contract operation (see "Current API coverage")
  functions/                     Azure Functions v4 adapters: HTTP, static web, Cosmos DB trigger
  telemetry/                     redacting structured logger, per-request RU metering
  services.ts                    the service graph, built once per process
web/                             authenticated responsive console, operator recovery, usage/timeline feeds and Swagger UI reference
tools/
  build/                         server build (tsc), console bundle (esbuild), deployable package staging
  contract/                      type generation from the contract
  seed/                          guarded seeder and the fictional fixtures
infra/containers.json            shared Cosmos DB database/container definitions
infra/main.bicep                 Flex, serverless Cosmos DB, private networking, identities, roles, storage and telemetry
tests/
  unit/                          node:test unit tests; no services needed
  integration/                   tests against the real Functions host and the Cosmos DB emulator
  e2e/                           real desktop/mobile Chrome journeys, allowance resume and poison requeue
  infra/                         compiled-template and protected-deployment invariants
  safety/                        real scanner and breaking-change detector positive/negative checks
  support/                       stack lifecycle and host-restart control channel, test identity provider, trigger proxy,
                                 in-memory case store, credit provider and handler harness (unit), shared HTTP case, credit
                                 and operator flow helpers (integration)
```

### Current API coverage

All 24 operations of the contract are implemented, registered and validated by the request
pipeline: the system and evidence operations (health, readiness, session, accounts, invoices,
policies), the case operations (create, list, get, timeline, runs, run, usage, proposals,
proposal), the decisions (`approveProposal`, `rejectProposal`), `requestRevision`,
`getCreditResult` and the operator operations (`listOperatorWork`, `getOperatorWorkItem`,
`recoverWorkItem`), all tenant-scoped and paginated where they list. None answers
`501 not_implemented` any more; `tests/unit/handlers.test.ts` pins that the handler table and the
contract name exactly the same 24 operations.

## Versions

Checked 2026-10-29; Identity, Core Tools, compiler and safety pins rechecked 2026-10-30.

| Component | Decision |
|---|---|
| Node.js | **24.22.2** for the project (GA, supported by Functions and Flex). The host's Node 26 is not a supported Functions runtime and is not used. |
| Functions | runtime 4.x, Node programming model v4 (`@azure/functions` 4.17.0), extension bundle `[4.*, 5.0.0)` |
| Cosmos SDK | `@azure/cosmos` 4.10.1 (Node >= 22) |
| Identity | `@azure/identity` 4.14.1, `jose` 6.2.13 |
| TypeScript | **5.9.3**, not the newer 7.x: `typescript-eslint` 8.72.0 requires `typescript >=4.8.4 <6.1.0` and `openapi-typescript` 7.13.0 requires `^5.x`, so 5.9.3 is the newest version both accept. Node 24 runs `.ts` by type stripping, so the compiler options are `erasableSyntaxOnly` and `verbatimModuleSyntax` (no enums, namespaces or constructor parameter properties; explicit `.ts` import extensions) |
| Emulator | `mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator` tag `vnext-EN20261019` at digest `sha256:db53613dae19d0a3d5ad50688d14aa6e957af082dafea56b52e1bd3a6b3f1406` |
| Azurite | `mcr.microsoft.com/azure-storage/azurite:3.35.0` at digest `sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37` |
| Core Tools | 4.16.0 checksum-verified isolated executable and CI pin; global 4.15.2 unchanged |
| Bicep | `az bicep` 0.39.26 installed (0.48.1 available) |
| GitHub Agentic Workflows | `gh aw` v1.0.1 |

Dependencies are locked with `package-lock.json` and pinned exactly where behaviour matters.

## Local test infrastructure

The Linux Cosmos DB emulator and Azurite run in containers (pinned digests, ports published on
`127.0.0.1` only). Functions Core Tools 4.15.2 runs on the host and serves the **built package**
from `.artifacts/package/`, so an integration run always exercises the same artifact that would
be deployed. One lifecycle serves local and CI: `tests/support/stack.ts`, driven by
`tests/support/cli.ts`.

```text
npm run stack:run -- [--no-seed] [--timeout <seconds>] -- <command> [args...]
npm run stack:up                 foreground stack for manual work (keeps running until stopped)
npm run stack:down -- --all      remove anything a crashed or killed run left behind
npm run stack:status
```

`run` starts the stack, exports `RESOLVE_STACK_ID`, `_URL`, `_IDP_URL`, `_COSMOS_ENDPOINT`,
`_COSMOS_KEY`, `_DATABASE`, `_DIAGNOSTICS` and `_HOST_LOG` (the Functions host's console output) to
the command, plus `RESOLVE_STACK_CONTROL_URL` and `RESOLVE_STACK_CONTROL_TOKEN` for host restarts
(below), then removes everything it owns. The stack seeds the fictional reference data before the
command starts; with `--no-seed` there are no accounts, so every case creation is refused as
`unknown_account`.
Exit codes: `0` ok, `2` usage, `3` start-up failed, `4` timeout (default 900 s), `5` the Functions
host exited during the run, `130` interrupted; otherwise the command's own exit code. On failure,
container and host logs (the last 30,000 host lines) are saved under `.artifacts/diagnostics/<stack id>/`. Cleanup only ever
touches containers labelled `resolve.owner`, so unrelated containers on the machine are left alone.

What was found while proving host, emulator, trigger and leases together (JS SDK 4.10.1,
vNext emulator, Core Tools 4.15.2 on Windows):

- The emulator is gateway-only and **does not enforce authentication**. It does not model RUs,
  index policies or serverless capacity either, so none of those can be validated locally.
  Readiness is `GET /ready` on its health port (15-20 s after start). `ENABLE_TELEMETRY=false` is
  required because the default is on. The stack generates a random emulator key per run.
- Hierarchical partition keys, ETag preconditions (412), create-only conflicts (409), transactional
  batches, patch, item TTL, leases containers without throughput, and change feed reads behave as
  designed through the JS SDK.
- **Certificate trust.** The Functions host is a .NET process. On Windows it did not trust the
  emulator's HTTPS certificate for the Cosmos DB trigger connection, and pinning the certificate
  chain through `NODE_EXTRA_CA_CERTS` only helps Node. The local stack therefore runs the emulator
  in **HTTP mode, reachable only on loopback**. TLS verification is never disabled anywhere, and
  no `NODE_TLS_REJECT_UNAUTHORIZED=0` exists. Azure always uses TLS; certificate behaviour is
  **not** covered by emulator tests.
- **Emulator defect.** The .NET SDK in the host asks for binary-encoded query results, and the
  emulator's binary encoding of lease queries is defective. Only the trigger connection goes
  through a small loopback proxy that rewrites the serialization-format request header to JSON
  text; the application's own SDK connects directly. The defect is **not filed upstream**: filing
  is external publication and needs approval.
- **Host start.** The host is started from environment variables only (no `local.settings.json`),
  with `AzureWebJobsStorage` pointing at Azurite (required for non-HTTP triggers). The trigger is
  tuned for tests with `TRIGGER_FEED_POLL_MS=500`, `TRIGGER_LEASE_ACQUIRE_MS=2000`,
  `TRIGGER_LEASE_EXPIRATION_MS=15000` and `TRIGGER_LEASE_RENEW_MS=4000`. The application reads them
    once, when the trigger is registered; invalid values (outside 200-600000 ms, or renew/acquire not
    lower than expiration) stop start-up, and unset values leave the platform defaults.
- **Request bodies need `Content-Length`.** Core Tools 4.15.2 forwards a request body to the worker
  only when the declared length is greater than zero, so a chunked request arrives empty. The API
  therefore answers `411 length_required` for any body-bearing operation without a
  `Content-Length`; this is covered by a test against the real host. The behaviour of the Flex
  Consumption front end for chunked or HTTP/2 requests is **unverified**. The 16 KiB cap is
  enforced by the application with a bounded read; lowering the host's own buffering limit is
  unverified.
- **Start-up cost (local Windows only).** Touching a freshly staged `node_modules` is slow on the
  first load (one run took about 36 s for the first worker load; `npm ci` of the production
  dependencies took 1-3 minutes). The staged production tree is about 13,700 files (about 54 MiB).
  Bundling the server with esbuild might shorten cold starts, but this is **unmeasured on Flex**,
  so no saving is claimed.
- **Host restart.** A test can kill the Functions host without warning and start it again on the
  same port with the same settings, as a crash would (`restartHost()` in
  `tests/support/control.ts`). The test process does not own the host, so it asks the process that
  does through a loopback-only control server protected by a random per-run token; without that
  channel the helper fails loudly instead of skipping. An intentional kill is not reported as a
  host crash (exit code `5`), and each restart appends a marker line to the host log. The killed
  host's trigger leases must expire (15 s on this stack) before the new host's trigger resumes, so
  tests wait for that rather than assuming it; the restart test took about 19 s end to end here.
  Node runs test files as parallel processes against the one shared stack, so a restart would break
  another file mid-request: `npm run test:integration` therefore passes `--test-concurrency=1`.
- **Restart with lower limits.** A restart may carry `{ settings: { RESOLVE_LIMIT_RUN_STEPS: '3' } }`
  (third argument of `restartHost`). That replaces the host's `RESOLVE_LIMIT_*` overrides: `{}`
  restores the defaults, and leaving `settings` out keeps the current ones. The control server
  accepts nothing else: keys must match `RESOLVE_LIMIT_<NAME>`, values are digit strings, at most
  16 entries, and the body is capped at 4096 bytes. The application only ever *lowers* run limits
  from the environment and refuses every override when `RESOLVE_ENV=azure`. A run snapshots its
  limits when its case is created, so only cases created after the restart see the lower limit.
  `tests/integration/budget-resume.test.ts` uses this to make demo runs stop at a 3-step budget
  and resets the host afterwards.
- **node:test pitfall (Node 24.22.2).** Two top-level `before` hooks in one file *start
  concurrently*; they do not run one after the other. A second hook that depends on the first (here:
  creating cases after a settings restart) therefore raced it, and the cases were created on the old
  host. Setup that must be ordered lives in one hook. This was a test-structure bug, not a
  production bug.
- Other containers on this machine (`resolve-test-*`) belong to an earlier, discarded attempt and
  were never touched. Unrelated `amazing_bardeen`, `condescending_poitras` and
  `hardcore_gagarin` containers were also left untouched.

## Cosmos DB agent skill

The user directed that the **globally installed** skills be used, so the skill is **not**
copied under `.github/skills/cosmosdb-best-practices/` (this deviates from the P01 text of the
instructions). Provenance of the copy that was consulted:

- Path: `~/.agents/skills/cosmosdb-best-practices/`
- Source: `AzureCosmosDB/cosmosdb-agent-kit`, `skills/cosmosdb-best-practices/SKILL.md`
- Folder hash: `811c5176d61977eda86671be5e82409763dcecd3` (updated 2026-10-29 in the global
  lock file), metadata version `1.0.0`, license MIT, 142 rule files.

Rules actually opened so far: `sdk-emulator-ssl`, `tooling-emulator-setup`,
`partition-hierarchical`, `throughput-serverless`, `sdk-etag-concurrency`, `query-pagination`,
`query-top-literal`, `index-composite`, `index-exclude-unused`, `index-path-syntax`,
`partition-20gb-limit`, `model-id-constraints`, `model-type-discriminator`,
`model-schema-versioning`, `sdk-retry-429`, `query-avoid-cross-partition`.
Where a rule and the requirements disagree the requirements win: `sdk-emulator-ssl` suggests
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which is rejected here. `query-pagination` prefers SDK
continuation tokens, but the emulator ignores `maxItemCount` for `ORDER BY`, hence keyset
cursors. The `TOP @n` form was verified on the emulator. Note that `query-top-literal` contradicts
itself in the copy consulted: the title in `SKILL.md` says "Use literal integers for TOP, never
parameters", while the body of the rule is "Parameterize TOP Values Safely" and recommends
`TOP @top`. The code follows the body (a parameter, never string-built SQL).

How the rules read in P04: `model-schema-versioning` (every persisted document carries
`schemaVersion`, set when it is written; see "Schema evolution" below), `sdk-retry-429` (the SDK
retries a throttled request after the server's `Retry-After`; this is configured once in
`src/data/cosmos.ts`, and a request that still fails after the bounded retries becomes
`503 dependency_unavailable` with `Retry-After` instead of a generic 500), and
`query-avoid-cross-partition` (the two query helpers in `src/` always pass an explicit partition
key: a case query uses `[tenantId, caseId]`, a tenant listing uses the hierarchical prefix
`[tenantId]`, and a reference-data query uses `tenantId`).

## Verified commands

Node 24 (see `.node-version`); the machine's default Node 26 is not a supported Functions
runtime. Executed on Windows on 2026-10-29 and 2026-10-30. "Emulator" evidence is **not** Azure evidence.

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | fresh install from the current lockfile on 2026-10-30: 191 packages installed, 192 audited, zero vulnerabilities, exit 0 |
| `npm run contract:lint` | Redocly: the contract is valid |
| `npm run contract:generate` / `npm run contract:check` | generated types are deterministic and in sync |
| `npm run typecheck` | server, tests, tools and web: exit 0 |
| `npm run lint` | ESLint (type-checked rules): exit 0 |
| `npm run build` | `tsc` server build plus esbuild console bundle and the Swagger UI reference: exit 0 |
| `npm run package` | stages `.artifacts/package` with production dependencies only (51.7 MiB after the Identity patch): exit 0 |
| `npm run test:unit` / `npm test` | 2,066 tests passed, including CI and generated-workflow policy checks |
| `npm run test:integration` | 129 passed through `npm run test:service`, Core Tools 4.16.0, one file at a time against the real host, emulator and Azurite |
| `npm run seed -- --target emulator --endpoint http://127.0.0.1:8081 --dry-run` | validates 56 fixtures and the target guards; writes nothing (needs `COSMOS_KEY` set to the emulator key) |
| `npm run stack:status`, `npm run stack:down -- --all` | report and clean up stacks |

`npm run test:integration` provisions the stack, so it starts the containers itself; it leaves
nothing behind (checked after each run). Real seeding is exercised inside the integration suite:
first seed, a repeat that changes nothing, read-back through an independent client, and drift
detection that exits with code 2 without overwriting.

What the integration tests prove today, against the emulator:

- health and readiness are anonymous, minimal and uncached; correlation ids are echoed or replaced;
- the authentication and role matrix, including the negatives: no token (bare bearer challenge),
  not a JWT, expired, wrong audience, wrong issuer, a v1.0 token, an application token, a token
  without the delegated scope, a user with no role, a user whose roles span two tenants, a forged
  identity header, a function key, `?code=`, and a cross-origin browser call (refused before
  authentication, with no CORS grant);
- tenant scoping and pagination of accounts, invoices and policies;
- the static console and API reference, the exact contract served at `/reference/openapi.yaml`,
  the content security policy, traversal attempts and `405` with `Allow`;
- request handling in front of the handlers: role gate, `Idempotency-Key` format, `415`/`400`
  for bodies that are not JSON or are off-contract, `413` by declared length, and `411` for
  chunked uploads instead of silently treating them as empty;
- the Cosmos DB trigger completing a diagnostic outbox item exactly once, ignoring a non-outbox
  document, and rejecting a duplicate create (`409`);
- seeding and provisioning as described above. The provisioning test reads the stored offers and
  shows that **no throughput was set**; that is *not* proof of a serverless account, which only
  Azure can show;
- the case store contract (17 tests, run against both the in-memory twin that the handler-level
  unit tests use and the real store on the emulator): atomic batches that leave nothing behind
  when one operation fails, create-only and ETag-conditional writes with exactly one winner among
  concurrent writers, tenant isolation, keyset-paged listings, status filtering that treats a
  lapsed approval as expired, timeline, usage, run and proposal reads, and outbox work carried in
  the same batch as the change that caused it;
- case creation and the investigation through the real host and the trigger (23 tests):
  `202` only after the case, its run and its queued work are stored; an identical request replays
  the original answer, the same key with different input is `409`, and the key is scoped to the
  tenant and the caller; five racing identical requests create one case, one run and one
  investigation; the demo investigator proposes the cited credit, reports missing and
  contradictory evidence as findings with no credit, treats hostile case text as data, and serves a
  second tenant from its own evidence in its own currency; usage is recorded as `not_applicable`
  within the limits; the timeline pages in order; a case of another tenant is answered exactly like
  an unknown case; the idempotency key and the case text appear in no stored document and no host
  log line;
- a hard restart of the Functions host while a proposal waits for approval (1 test): the pending
  proposal is byte for byte the one stored, none of the case's documents is written again, and the
  new host's trigger and leases investigate a new case;
- decisions through the real host (11 tests): an approval credits **once** and the effect appears
  everywhere it belongs (decision, proposal, credit result, case, timeline and provider ledger);
  repeated and concurrent approvals become one decision and one credit; of two competing decisions
  exactly one wins and the credit agrees with the winner; the refusals (wrong role, another
  tenant, stale digest, other policy version, unknown version, a malformed body, a finding that
  was never offered for approval) write nothing; the person who created a case cannot decide it,
  and someone else can; a rejection records its reason, credits nothing and keeps the reason out
  of the host log; a revision needs a fresh approval and credits only what was approved; revisions
  stop after three; an approval that is not decided in time is refused every time, recorded as
  expired once, and can be revised;
- credit execution against the simulated provider (8 tests): a credit the provider already holds
  is adopted instead of issued again, and one that does not match stops the work until an operator
  fixes the ledger and requeues it; a provider that does not answer is retried with backoff and
  then issues one credit, or is given up on after five attempts and requeued for exactly one
  credit; a credit whose answer was lost is found, not issued again; a finished credit delivered
  again records nothing new; on a real container the provider holds one credit however many
  callers use the same key at once and keeps one tenant's ledger out of another's lookups;
- operator work (13 tests): listings page newest first without repeating or skipping an item and
  keep their place while newer work arrives; a waiting approval is described but cannot be decided
  by an operator, and stops being listed once its time has run out; completed work, work given
  up on (with the reason) and a failed run (with no recovery offered) are listed in their own
  states only; an item whose claim ran out is listed as recoverable and a requeue creates nothing
  new; an operator sees only the work of their own tenant, another tenant's work is answered
  exactly like work that does not exist, everyone else is refused, and every parameter and recovery
  body is validated before any work is touched;
- budget exhaustion and resume (6 tests): a run stops before the next call that would pass its step
  allowance, keeps what it did and proposes nothing; the operator sees it as budget exhausted with
  only a resume on offer; a refused resume changes nothing; an allowed resume carries every counter
  over, plays the plan again and still waits for a person to approve; grants stop at two per run
  and each is added to the limits the run already has; four simultaneous resumes spend one grant
  and start one run.

**Not executed (blocked or not yet built):** the breaking-change
check (needs a published baseline contract), GitHub Actions runs (P06), any Azure verification,
**cloud seeding** (it needs a dedicated identity and approved private-network access, so it
cannot run from this machine), and every live-model run. Each remains *blocked*, not passed.

**Not proven on the real stack:** a host kill **in the middle of a run**. The only real-stack
restart test covers a pending approval. Restart-safe counters (an ambiguous call settled as
unknown, active time after a crash) are proven only against the in-memory case store, in
`tests/unit/budget.test.ts` and `tests/unit/runner.test.ts`; the emulator-backed store passes the
same store contract, but no test kills the host while a run is spending its allowance.

## Browser and bounded live model (P05)

Verified on 2026-10-30 with Node 24.22.2, Chrome 155, Functions Core Tools 4.15.2,
the Linux Cosmos DB emulator and Azurite. These are local results, not Azure certification:

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run contract:check` | exit 0 |
| `npm run test:unit` | 2,062 passed, none failed or skipped |
| `npm run build`, `npm run package` | exit 0; production package 54.5 MiB |
| `npm run stack:run -- --timeout 2700 -- node --test --test-concurrency=1 "tests/integration/**/*.test.ts"` | 129 passed, none failed or skipped |
| `npm run stack:run -- --timeout 1200 -- node --test --test-concurrency=1 "tests/e2e/**/*.test.ts"` | 41 passed across five suites, none failed or skipped |

One attempt failed before tests when Core Tools exited with `Value cannot be null.
(Parameter 'provider')`. The fresh-stack retry passed; the failure is recorded, not
counted as a pass. The first recovery browser run also caught an overly broad test
selector matching both a work id and its `-g1` suffix. Exact work-id matching fixes it.

### Console

- `web/src/` implements sign-in, tenant-scoped cases, submission, progress, evidence,
  decisions, revision, ordered paginated timeline/usage, credit results and operator
  recovery. All credits and demo/live modes are explicitly labelled.
- Unauthenticated `/config.json` contains non-secret browser configuration and is
  `no-store`. Entra mode uses bundled MSAL Browser redirect authentication; register
  the console origin as a SPA redirect URI. Set `CONSOLE_ENTRA_CLIENT_ID` and optionally
  `CONSOLE_API_SCOPE` (otherwise the API's delegated `access_as_user` scope).
  Real Entra redirect sign-in remains unexecuted without app registrations.
- The persona selector exists only with the local/CI test identity provider. Its CORS
  and CSP allowance are restricted to that configuration; Azure refuses test-IdP mode.
  A leftover OAuth fragment is removed before hash routing.
- The roughly 363 KB JavaScript bundle includes MSAL; CSS is roughly 13 KB.
  Browser dependencies are locked to MSAL Browser 5.27.0 and playwright-core 1.64.1.
  Scripts/styles are self-hosted under the actual CSP, never `bypassCSP`. There is
  no inline-script or `unsafe-eval` allowance. `waitForFunction` string predicates
  were refused by CSP, so tests poll from Node. The browser watcher also detects
  actual CSP violations, page errors, unexpected network failures and 401/403/5xx.
- Navigation focuses the heading, while a plain initial load preserves the first Tab
  stop (the skip link). Cancelling recovery returns focus to its opener. Form errors
  are associated with fields, announced, and focus the first invalid field.
  Operator-only sign-ins cannot decide proposals.
- The mobile suite uses actual touch input at 390 px and checks reflow at 320 px.
  It verifies the controls the stylesheet intends to be 44 px (including small
  buttons on coarse pointers), overflow and basic accessible names/landmarks.
  Instrument self-tests prove these checks catch injected defects. This is not a
  comprehensive WCAG audit or a claim that every link meets a 44 px requirement.
- Usage events can change from reserved to settled without changing sequence number.
  `planFeedUpdate`, `revisionOf` and redraw update those entries in place. Unit
  mutation tests and the real-browser journey prove a stale reserved entry is replaced.
  Character limits count Unicode code points consistently with the contract/server.
- Browser suites cover maker-checker separation, replay/conflict, both tenants,
  paging, reference rendering, validation, rejection/revision/fresh approval,
  exactly one provider effect, budget resume without lost usage, poison requeue,
  stale recovery conflicts, and non-operator denial. Outbox cards are labelled
  "Background work", not incorrectly "Credit execution" for investigation starts.

### Live adapter and usage

- The Azure OpenAI v1 Chat Completions adapter uses only allowlisted tools and bounded
  requests/responses, with redirects refused. `LIVE_MODEL_AUTH=entra` is the default;
  `none` is permitted only for loopback test servers outside Azure.
- Required settings when configured: `LIVE_MODEL_ENDPOINT`, `LIVE_MODEL_DEPLOYMENT`,
  `LIVE_MODEL_INPUT_USD_PER_MILLION_TOKENS`,
  `LIVE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS`, `LIVE_MODEL_PRICING_AS_OF`.
  There are no assumed free prices. `LIVE_MODEL_APPROVED` defaults to false.
  Optional settings include `LIVE_MODEL_TOKEN_SCOPE`, `LIVE_MODEL_MAX_OUTPUT_TOKENS`
  and `LIVE_MODEL_TIMEOUT_MS`. The default token scope is
  `https://cognitiveservices.azure.com/.default`; compatibility must be verified
  against the chosen deployment before paid execution.
- Run allowances and the tenant-day cost cap are reserved before calls. Failed or
  ambiguous calls retain their reservation; crash over-reservation is conservative.
  Counters survive retry/resume and are never reset. Input estimates are byte-based,
  not measured tokenizer output. Pricing assumptions must be dated and approved.
- Fake/scripted model tests prove adapter and tool-loop behavior only. The browser
  blocked/live-mode test rewrites a session response; it does not call a live model.
  Real model calls, MSAL sign-in and Azure identity/network/hosting checks are
  **blocked, not passed**.
- Runtime usage is persisted separately from coding-agent usage and future Actions/
  repository-agent usage. Coding-agent monetary/token totals are unavailable here
  and therefore **unknown**, not zero. No measured Azure costs or savings are claimed.

## Shared checks and CI (P06)

- `npm test` runs the unit suite. `npm run check` runs contract lint/generated-client
  drift, both typechecks, lint, units, dependency audit, build and production packaging.
  The shared command executed successfully.
- `npm run test:service` runs integration and browser suites with **separate fresh
  stacks**, serial files, bounded deadlines, failure diagnostics and owned cleanup:
  **129 integration + 41 browser checks passed** with Core Tools 4.16.0.
  `npm run check:all` composes static, infrastructure, compiler, scanner, safety
  and service gates. The complete command passed on 2026-10-30, exit 0:
  **2,066 unit, 129 integration, 41 browser, 4 infrastructure and 2 detector tests**,
  none failed or skipped; both workflow locks matched compiler output. A subsequent
  fresh `npm ci --ignore-scripts` and `npm run check` also passed.
- `.github/workflows/checks.yml` uses those same commands, read-only permissions,
  immutable action commits, checked Core Tools archive SHA-256, Node from
  `.node-version`, cancelled superseded runs and a 30-minute job deadline.
  It never uploads diagnostics, uses `pull_request_target`, or receives Azure secrets.
  Actual GitHub execution is **blocked until publication is approved**, not passed.
- `npm audit` finally became reachable and identified GHSA-xcx6-jx8p-x3h5 in
  transitive MSAL Node. The exact Azure Identity pin was patched to 4.14.1;
  the lock resolves MSAL Node 7.1.2. **The subsequent audit reports zero vulnerabilities.**
  This replaces the earlier unidentified two-high finding, not a bypass of the audit.
- `npm run scan:secrets` uses digest-pinned Gitleaks 8.30.1 with redacted output,
  scans Git history and explicit source roots (never `.local/`, dependencies or
  scratch output), and passes. `.gitleaks.toml` permits only exact synthetic
  idempotency keys and an intentionally malformed cursor in named test files.
  Initial scan findings were those fixtures, not credentials. The scanner negative
  test generates a nonfunctional credential-shaped probe and verifies rejection.
- `npm run test:safety` passes two real-container detector tests: unchanged API
  contracts pass, deleting `POST /cases` fails, and the secret probe fails.
  `npm run contract:breaking -- --base <full-commit-SHA>` compares the actual
  baseline with digest-pinned oasdiff 1.35.0, with warning/error changes fatal.
  Initial publication has no baseline: the command exits 2 and reports **blocked**;
  CI emits an explicit warning for this case. Detector validation is not proof
  of compatibility with an unpublished API.
- Core Tools 4.15.2 and 4.16.0 both intermittently exited during worker startup
  with `Value cannot be null. (Parameter 'provider')`. No automatic pass/retry
  fallback was added. `--verbose` preserves diagnostic context; a fresh complete
  service run passed. This remains an observed local tool instability, not a
  claim that the release upgrade fixed its cause. The system installation was
  not modified; use `RESOLVE_FUNC` for a checked isolated executable.
- Publication still requires manual privacy review of source, generated output,
  history and metadata and an owner decision about the missing repository license.
  Automated secret scanning does not replace that review.

## Deployment preparation and Azure proof gate (P07)

**No Azure resources have been provisioned and no region has been selected.** The
template requires explicit location, Entra tenant/API audience, SPA client and
delegated scope parameters; no credentials or subscription identifiers are stored.

| Choice | Evidence and decision |
|---|---|
| Direct Bicep + official Azure Functions action | `infra/main.bicep` lints/builds with Bicep 0.39.26. The pinned Functions action explicitly supports `sku: flexconsumption`, prebuilt packages and OneDeploy. Selected. |
| azd 1.37.2 | Installed, but this topology has not been validated end to end through azd. Not claimed unsupported; not selected or scaffolded as a second deployment system. |

`npm run infra:check` compiles the template to ignored `infra/main.json`.
`npm run test:infra` passes four checks over the compiled template and deployment
workflow. These are **static policy checks**, not provider validation or Azure proof.
The first compile caught a role-assignment loop dependent on runtime identity
properties; the loop now uses deployment-time role/container identifiers.

The template declares:

- FC1 Linux Flex Consumption, Node 24, 2,048 MiB, at most 40 on-demand instances,
  HTTP concurrency 16, and **empty always-ready configuration**. The admission
  limits in the application remain 3 active runs and 25 cases/day per tenant.
- One `EnableServerless` Cosmos DB account in one region; no database/container
  throughput or autoscale properties, including leases. The shared
  `infra/containers.json` defines all four containers, partitions, indexes and TTL.
- Public HTTPS Functions ingress, a delegated `Microsoft.App/environments`
  integration subnet, separate private-endpoint subnet, Cosmos SQL private endpoint
  and `privatelink.documents.azure.com` link; Cosmos public access and local keys
  are disabled. The sample address space is `10.42.0.0/16`; check conflicts before
  connecting it to any existing network.
- Separate app and seed user-assigned managed identities. The app reads reference
  data, writes cases, creates/reads provider records, and manages lease items through
  container-scoped native Cosmos roles. The seeder can only create/read/query
  reference data, not approve, execute, replace fixtures or access cases/provider.
  SDK queries require **both** `executeQuery` and `readChangeFeed`; the roles
  include both, following the native RBAC reference.
- Identity-only host/deployment blob storage with shared keys and public blobs
  disabled. Its authenticated HTTPS endpoints remain public; the Cosmos endpoint
  is private. The app's host uses Blob Data Owner for blob-based host coordination.
- Workspace-backed Application Insights with AAD ingestion, no local authentication,
  30-day retention and a 1 GB/day workspace ingestion cap. Caps may overshoot and are
  not hard bill limits. Native host telemetry carries invocation context and the
  application logs correlation IDs; actual cloud correlation must be checked.
  OpenTelemetry host-mode interoperability is not claimed or enabled without proof.
- Optional access to an **existing**, separately approved Azure OpenAI account in
  the resource group, with OpenAI User assigned to the app identity and explicit
  endpoint/deployment/dated prices. Nothing provisions a paid model deployment;
  live approval defaults false. Empty model account means explicitly labelled demo.
- Periodic, locally redundant backup, four-hour interval and eight-hour retention.
  No multi-region recovery or production RPO/RTO guarantee is claimed.

The read-only Azure CLI capability probe on 2026-10-30 listed Flex regions and
confirmed Node 24 in East US. This is not a deployment-region selection, quota
reservation, Cosmos regional compatibility proof, or authorization to provision.

`.github/workflows/azure-proof.yml` is manual, main-only and OIDC-only. It requires
an explicit paid-limit confirmation, `AZURE_COST_ESTIMATE_APPROVED=true`, and an
`azure-demo` environment with independent reviewers and self-review disabled.
Preview and provisioning are separate protected jobs so the what-if can be reviewed
before the second approval. The provisioner requires narrowly scoped, explicitly
bootstrapped resource/role-assignment authority for the dedicated resource group;
the application and seeder never receive deployment permissions.

Configure non-secret environment variables `AZURE_LOCATION`, `AZURE_RESOURCE_GROUP`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_DEPLOY_CLIENT_ID`,
`ENTRA_API_AUDIENCE`, `CONSOLE_ENTRA_CLIENT_ID`, `CONSOLE_API_SCOPE` only after
approval. The deploy identity's federated subject is
`repo:jaydestro/cosmos-agentic-support-api:environment:azure-demo`; restrict it to
that protected environment and never use a client secret or publish profile.

**Required before enabling paid deployment:**

1. Owner approves publication/commit/push/merge, the subscription/resource group/
   region, numeric limits and a dated regional cost estimate. Configure real Entra
   app roles/scope/SPA redirect URIs and assign distinct representative/approver users.
2. Verify regional Flex and Cosmos serverless/private-link compatibility, provider
   registrations and current quota; validate the real parameters and review the
   ARM what-if. Template compilation cannot establish these.
3. Budget for consumed Cosmos RUs/storage and idle change-feed leases; Functions
   execution/host storage; private endpoint hours/data and DNS; model inference;
   telemetry ingestion/retention; Actions and repository-agent compute/credits.
   The private endpoint can cost money while compute is idle. No price estimate
   is valid here until an approved region and usage assumptions are supplied.
4. Approve an isolated private-network seed runner, attach **only** the generated
   seed identity, and run the existing guarded cloud seeder with `SEED_CLIENT_ID`,
   `SEED_PRINCIPAL_ID`, `--target cloud` and exact `--confirm-account`. GitHub
   OIDC does not create network reachability. Repeat it and inspect independent
   read-back; never seed at startup or add a public reset/seed endpoint.
5. After provisioning, separately prove: actual token/role/tenant denials;
   private DNS resolving to private addresses; positive app managed-identity data
   and lease operations through the real Cosmos trigger; outside-network denial
   even with an otherwise authorized token; FC1/zero-always-ready/serverless/no-RU
   configuration; safe cloud seed repeats; simulated provider ledger/result
   reconciliation; real browser Entra sign-in; correlated telemetry; and approved
   live-model behavior without fallback. None of these is marked passed.

References consulted: [Flex hosting](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan),
[Flex networking](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to#configure-virtual-network-integration),
[Cosmos serverless](https://learn.microsoft.com/azure/cosmos-db/serverless),
[native data-plane roles](https://learn.microsoft.com/azure/cosmos-db/reference-data-plane-security),
and [Functions GitHub deployment](https://learn.microsoft.com/azure/azure-functions/functions-how-to-github-actions).
Azure MCP best-practices and Bicep resource-schema tools were also consulted;
regional/service constraints take precedence over generic guidance.

## Repository assistance and remaining completion gate (P08)

The repository workflows are **prepared locally, not executed on GitHub**:

- `contract-cosmos-review.md`: read-only contract/Cosmos implementation reviewer;
  one comment on the triggering PR, no arbitrary issue target, approvals or merges.
- `docs-maintainer.md`: manual, main-only README/sample maintainer; at most one
  draft PR, one changed file and a 64 KiB patch. A deterministic post-agent guard
  compares tracked/committed changes with the original workflow SHA and checks
  untracked files; anything other than README.md refuses publication.
- Both require `RESOLVE_REPOSITORY_AUTOMATION_APPROVED=true`, use read-only agent
  permissions, no Azure/deployment credentials, no unrestricted shell and no
  production data. Repository/retrieved text is untrusted. Supported safe-output
  jobs, not model permissions, perform allowed publication. Missing-data/tool
  reports cannot create issues.
- Numeric **proposals**, not approvals: agent 8 turns, 2 AI credits, 10 minutes,
  zero harness retries; separate threat detector 4 turns, 1 credit, 2 minutes per
  attempt, zero retries; safe-output job 5 minutes. One concurrent run per
  workflow/PR grouping. Credits are soft limits, can overshoot, and are not dollars.
  Available/failed/ambiguous/estimated usage belongs in the run summary; missing
  usage remains unknown, separate from runtime-model and coding-agent usage.
- Threat detection remains enabled. Compilation revealed its default 400-credit
  allowance, so it was explicitly reduced to one credit. Unsupported
  `max-continuations` was removed rather than pretending it was enforced; the
  pinned schema's actual harness/detector retry controls are used.
- `gh aw` **v1.0.1** compiled both Markdown sources into lock YAML, the action-pin
  manifest and generated-file attributes with zero warnings. No lock was
  hand-authored. The compiler required explicit `cli-proxy: false` for disabled
  Bash. Its supported sandbox/tool allowlists and safe-output protections remain
  in place.
- `npm run workflows:compile` regenerates locks. `npm run workflows:check` verifies
  compiler version, compilation/validation and deterministic fingerprints.
  Three unit checks verify compiled limits/read-only permissions and execute the
  actual README-only guard against accepted and rejected synthetic changes.

Before calling the full delivery complete, obtain publication and paid-run approval,
perform the real Azure checks above, and run both agentic workflows on GitHub.
Enabling Copilot automation requires a separately approved scoped Copilot credential
and usage budget; no token has been created or stored by this work.

## Schema evolution

Every document this application writes carries a `type` discriminator and `schemaVersion`
(currently `1`), both set when the document is written (`SCHEMA_VERSION` in
`src/data/documents.ts`; the outbox carries its own literal `1`). The rules for changing them:

- A new **optional** field that readers can default is compatible and does not change the version.
- A new required field, a changed type or meaning, or a restructured document increments the
  version. Rolling deployments and rollbacks mean two versions are live at once, so readers must
  accept both until the old one is gone, and writers keep writing the old one until every instance
  reads the new one.
- The application never rewrites documents in bulk. An old document is upgraded when something
  else writes it, or by an explicit, bounded, restartable migration run on purpose. None exists
  and none is needed at version 1.
- **Not yet built:** only the outbox reader checks the version (an item that is not version `1` is
  not processed). The other readers trust the stored shape, so making every reader switch on the
  version, and refuse versions it does not know, belongs with the first increment.
- Create-only documents (provider credits, idempotency records) are never updated in place, so a
  change to their shape applies to new documents only. Admission counters are replaced under an
  ETag, so a reader of one must cope with the version a competing writer may have just written.
- The HTTP contract evolves separately, under the compatibility rules in `contracts/openapi.yaml`;
  the P06 breaking-change detector passes its positive/negative tests; comparison
  with a published baseline remains blocked until there is a baseline.

## Still to document

Retention and purge for case aggregates, completed outbox items and work documents (the item TTL
decision is still open: `cases` has `defaultTtl -1`, so nothing expires unless a document sets its
own), recovery, backup assumptions (to be checked against the current Cosmos DB backup
documentation for serverless accounts), and operating costs (Cosmos DB RUs and storage, leases,
Functions and host storage, networking and private endpoint, model inference, telemetry, Actions
compute), including the change-feed write amplification of the outbox and the idle trigger-poll
cost, which are unmeasured. These are written alongside P05-P07 and are not yet claimed.
