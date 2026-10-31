# Project Overview

Resolve is a public, serverless sample for synthetic SaaS billing disputes. A support
representative submits a case; an agent investigates invoices and a versioned credit
policy, proposes a cited credit, and waits for an authorized human. Deterministic code
executes one simulated credit after approval. Include rejection/revision, a paginated
timeline, and operator recovery. Exclude real payments and real customer data.

The demo goal is a successful, tested Azure deployment of Cosmos DB and the full
API, showing Cosmos DB best practices and evidence-backed benefits of GitHub
Agentic Workflows for a blog. Prepared YAML and emulator success are not Azure proof.

## Stack and Hosting

- Use TypeScript, a currently supported GA Node.js runtime, and Azure Functions
  programming model v4 on Linux **Flex Consumption**. Use on-demand scaling;
  leave always-ready instances disabled unless explicitly approved.
- Use Azure Cosmos DB for NoSQL with the official JavaScript SDK and **serverless
  account capacity** in a single Azure region. Do not use provisioned throughput,
  autoscale RU/s, or shared-throughput databases. Do not set throughput on any
  database or container, including the lease container.
- Declare serverless capacity in Bicep. Verify supported regions, limits, trigger,
  identity, and networking compatibility. Report incompatible requirements instead
  of silently changing either service to a different hosting/capacity model.
- Use OpenAPI 3.1, a minimal browser console with supported Entra authentication
  components, Bicep, and correlated Application Insights/OpenTelemetry diagnostics.
  Verify current APIs and compatible tool versions; lock dependencies.

## Application Requirements

1. Seed versioned fictional accounts, subscriptions, invoices, and credit policies
   for at least two application tenants. Include duplicate, ordinary, missing, and
   contradictory evidence. Application tenants need not be separate Entra directories.
2. Authenticate representatives and scope case submission/list/detail to their tenant.
   Case creation uses idempotency keys: identical input replays the original result;
   different input with the same key returns a conflict. Define key scope and retention.
3. Start investigations asynchronously and persist acknowledged work. Expose only
   allowlisted invoice/policy reads and proposal submission as model tools. Validate
   tool arguments and treat case/retrieved text as untrusted data.
4. Persist proposals with amount, currency, explanation, invoice references, and policy
   version/clause. Enforce evidence and credit limits in code. Missing or contradictory
   evidence must produce a finding, not an invented credit.
5. Release compute while awaiting human approval. Preserve the exact pending proposal
   across restarts. Decide approval-role separation explicitly. Bind decisions to
   proposal/policy versions and revalidate before execution. Rejection records a reason;
   revision requires fresh approval. Define approval expiry separately from active time.
6. Atomically record decisions, state transitions, and outbox work. A Cosmos DB-triggered
   Function executes approved work at least once with leases, bounded retries,
   document-type filtering, poison-work handling, and idempotent handlers.
7. The simulated provider supports stable idempotency keys and result lookup. Reconcile
   provider success before local acknowledgment instead of issuing another credit.
   Inspect stored provider/results to prove one effect under repeats and concurrency.
8. Provide a paginated ordered timeline and authorized operator inspection/recovery of
   waiting, failed, poison, recoverable, budget-exhausted, and completed work. Resume
   preserves usage history and completed effects; it cannot bypass authorization.

## API, Data, and Security

- Author the contract before handlers. Cover cases, investigations/run status,
  invoice/policy reads, proposals, human approval/rejection, revisions, credit results,
  timeline, and operator recovery. Include stable operation IDs, security, async
  responses, continuation tokens, structured errors, examples, and compatibility rules.
  Generate a typed client and interactive reference; validate requests and responses.
- Support the complete browser journey on desktop/mobile, including progress,
  evidence, decisions, pagination, errors, and recovery. Label simulated credits and
  deterministic demo versus live-model modes. Never silently fall back from live to demo.
- Store bounded runs/usage, evidence references, versioned proposals, decisions,
  idempotency records, results, timeline items, and outbox work in Cosmos DB. Use point
  reads, scoped parameterized queries, conditional writes, and create-only deduplication.
  Reuse SDK clients; justify partitions/indexes, tenant listings, growth, and retention.
  Transactions cover one container/full logical partition, never the external provider.
  Do not embed unbounded histories or call ordinary documents tamper-proof.
- Derive identity from validated Entra tokens; enforce tenant/role checks in code.
  Neither arbitrary identity headers, function keys, CORS, nor model output authorize
  protected actions. The model cannot approve or directly execute credits.
- Keep Functions ingress public over HTTPS. Use outbound VNet integration, a Cosmos DB
  private endpoint/private DNS, disabled database public network access, and managed
  identity with least-privilege data-plane RBAC for application and lease operations.
- Seed explicitly with stable IDs, target guards, bounded retries, independent read-back,
  and non-destructive repeats. Never seed approvals/results, seed at startup, or expose
  public seed/reset endpoints. Cloud seeding requires a separate scoped identity and
  approved private-network access; GitHub OIDC alone does not provide reachability.
- Validate configuration, request sizes, browser origins, abuse/concurrency controls,
  and minimal health responses. Redact secrets and sensitive payloads from diagnostics.
  Document schema evolution, retention, recovery, backup assumptions, and operating costs.

## Execution Limits

- Agree numeric limits for steps, tool/model calls, tokens/cost, retries, active time,
  approval expiry, and tenant admission/concurrency before paid execution.
- Atomically reserve allowances before calls and persist counters across retries and
  restarts. Stop before the next call on exhaustion; require authorized resume with
  an explicitly recorded allowance. Never reset usage or silently increase budgets.
- Track coding-agent, runtime-model, and repository-automation usage separately.
  Record failed/ambiguous calls, estimated or unknown usage, and soft-limit overshoot.
  Unknown is not zero. Date pricing assumptions; do not claim unmeasured savings.
- Account for consumed Cosmos DB RUs/storage and leases, Functions/host storage,
  networking, model inference, telemetry, and Actions compute. Serverless compute
  and database capacity do not make supporting resources free.

## Development and Validation

- Inspect relevant files and Git state. Keep changes small and run a focused check
  immediately after each substantive change. Ask about material decisions; do not
  invent approvals, weaken requirements, or mark reviewer-owned checks complete.
- Keep the short plan, actual layout, version decisions, and verified install/build/
  run/type/lint/test/seed commands in README.md. Establish and execute package scripts
  before documenting them as working. Do not generate parallel planning frameworks.
- Keep all tests and test support under `tests/`. Begin with the Linux Cosmos DB
  emulator and Azurite in containers and Functions Core Tools on the host. Verify
  readiness, certificate trust, gateway mode, trigger, and leases early. Add a custom
  host container only for a demonstrated need; never disable global TLS verification.
- Use shared local/CI lifecycle entry points, synthetic fixtures, bounded timeouts,
  diagnostic capture, exit codes, and owned-resource cleanup. Exercise real HTTP
  endpoints and the Cosmos DB trigger, not only handler mocks.
- Run build/type/lint, request/response conformance, client/reference compatibility,
  breaking-change, unit, service-backed integration, and browser end-to-end checks.
  Keep emulator, live-model, Azure, and GitHub workflow evidence separate.
- Test tenant/role negatives, injection, missing/contradictory evidence, idempotency
  replay/conflicts, competing approvals, stale versions, rejection/revision, restart
  during approval waits, redelivery, provider reconciliation, poison recovery, and
  usage exhaustion/resume with restart-safe counters. Verify seed read-back/repeats.
- Azure verification must prove real token/role denials, private DNS, positive managed-
  identity data/lease access, outside-network denial, serverless account/hosting
  configuration, and safe cloud repeat seeding. Emulator success cannot establish these.

## Delivery Sequence

On an end-to-end build request, complete P01-P08 in order, verifying each stage before
continuing without requiring another prompt. Stop for material decisions, required
approvals, or blockers. A single-stage request stays scoped to that stage. Reading
these instructions during a question or documentation change does not start a build.

1. **P01: Preflight and plan.** Check tools and prerequisites; resolve role separation,
   usage limits, idempotency retention, and approval expiry. Record the plan in README.
   Install the latest reviewed default-branch Cosmos DB Agent Kit skill under
   `.github/skills/cosmosdb-best-practices/` with commit, metadata version, complete
   resources, license, and provenance. Consult relevant rules on demand; record actual
   use. Do not copy upstream MCP/plugin settings or require new MCP servers.
2. **P02: Foundation.** Implement the contract, locked Functions scaffold, configuration,
   auth boundaries, client/reference, fixtures, and guarded seeder. Prove real host-to-
   emulator HTTP/trigger/lease compatibility, read-back, and non-destructive repeat seeding.
3. **P03: Investigation.** Implement cases, restricted evidence reads, bounded runs,
   cited proposals, persisted usage, timeline, and the durable approval wait.
4. **P04: Decisions and execution.** Implement approval/rejection, revision, atomic
   outbox transitions, replay-safe provider execution, reconciliation, and operator recovery.
5. **P05: Browser and live model.** Complete the usable console and supported bounded
   live-model adapter. Verify browser journeys; report unapproved/unavailable live runs blocked.
6. **P06: Local and CI checks.** Consolidate proven checks into shared entry points and
   deterministic GitHub Actions gates. Run the safety and end-to-end acceptance checks.
7. **P07: Deployment.** Compare direct Bicep/supported tooling with azd; implement only
   the verified choice for Flex Consumption and serverless Cosmos DB. Include private
   networking, identity/RBAC, storage, model/telemetry dependencies, protected OIDC
   deployment, and scoped cloud seeding. Validate infrastructure before paid provisioning;
   after approval, execute the separate Azure verification checks.
8. **P08: Repository assistance and completion.** Add a contract/Cosmos implementation
   reviewer and documentation/sample maintainer using GitHub Agentic Workflows. Use
   minimal permissions, sanitized inputs, supported safe outputs, and bounded time/
   usage/retry/concurrency. No production data, deployment credentials, auto-approval,
   or auto-merge. Compile Markdown to lock files with pinned tooling; never hand-author
   generated locks. Require actual GitHub runs before claiming workflow execution.
    Pin every action and reusable-workflow `uses` reference to a full 40-character
    commit SHA, including generated locks. Verify references against their official
    repositories with GitHub MCP and consult the official GitHub Agentic Workflows
    documentation. Keep these requirements intact during compiler regeneration.

## Completion and Change Safety

- Use only fictional data and sanitized configuration in source, examples, browser
  assets, logs, and artifacts. Include secret scanning and manual privacy review of
  source, history/metadata, and generated output before publication.
- Do not commit, push, provision paid resources, publish externally, or run destructive
  resets without explicit approval. Instructions guide behavior; code, permissions,
  CI, and supported budget controls enforce boundaries.
- Report changed files, commands/results, decisions, usage when reported, and blockers.
  Keep README status current. An unexecuted check is blocked, not passed; a working
  sample is not production certification.