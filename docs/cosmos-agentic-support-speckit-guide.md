# Build Resolve with GitHub Spec Kit

A step-by-step, agent-led build guide for `cosmos-agentic-support`, using GitHub Copilot CLI as the coding agent.

Resolve is a durable, approval-aware support agent. It investigates a synthetic SaaS billing dispute, proposes a service credit, waits for human approval, and executes one simulated credit. Azure Cosmos DB holds durable application state; an OpenAPI-first Azure Functions API exposes controlled tools.

## How to use this guide

This is one guide containing **separate prompts**, not one prompt to execute in full.

1. Run the setup commands in your terminal.
2. Launch GitHub Copilot CLI in the project directory.
3. Paste each Spec Kit prompt into the CLI's interactive chat separately.
4. Review the resulting artifacts and answer clarification questions before proceeding.
5. Implement in stages, save the actual CLI prompts and verification evidence, then check convergence against the specification.

The commands below use the GitHub Copilot default skills syntax documented on October 29, 2026. Older installations can use different syntax. Follow the commands installed by your chosen Spec Kit version and confirm them with `/skills list` in Copilot CLI.

This guide does not create the repository, install tools, provision Azure resources, or execute the prompts.

## The three agent roles

| Role | Responsibility |
|---|---|
| GitHub Copilot CLI (coding agent) | Helps the developer specify, implement, test, and deploy the application through reviewed CLI sessions. |
| Runtime support agent | Investigates cases through explicitly permitted application tools. |
| GitHub Agentic Workflows | Reviews repository changes and proposes documentation maintenance through controlled outputs. |

GitHub Agentic Workflows does not orchestrate customer-facing support runs. Conventional GitHub Actions remains responsible for deterministic CI and deployment gates.

## 1. Initialize the project

Prerequisites: Python 3.11+, `uv`, Git, and an installed GitHub Copilot CLI with an authorized account. Azure, runtime-model, and GitHub workflow access are needed for their respective cloud demonstrations, not to write the initial specification. Copilot CLI inference has its own account access and usage requirements.

Run in a terminal from the parent directory where you want the new repository:

```powershell
uv tool install specify-cli
specify init cosmos-agentic-support --integration copilot --script ps
Set-Location cosmos-agentic-support
```

For an existing repository, follow Spec Kit's existing-project instructions instead of creating a nested project. Record the installed version and consult its documentation before proceeding if commands differ.

From the initialized project root, record the installed versions, create a private evidence directory, and launch the coding agent:

```powershell
copilot --version
uv tool list
New-Item -ItemType Directory -Force .local/blog/evidence | Out-Null
copilot
```

Inside Copilot CLI, check the active identity and available skills before running a project prompt:

```text
/user show
/skills list
```

For this project's recorded authoring sessions, the active GitHub account must be `jaydestro`; readers reproducing the published walkthrough use their own authorized account. If the CLI shows a different account, stop and use its account-switching flow before continuing. GitHub CLI (`gh`) and Copilot CLI authentication are separate checks; do not assume one proves the other's identity. Never put tokens in prompts or evidence.

All `/speckit-*` commands below go into **GitHub Copilot CLI interactive chat**, not PowerShell. If the installed Spec Kit skills are missing, resolve their discovery before proceeding. Keep interactive tool approvals enabled and review permissions before granting them. Paid provisioning, external publication, and destructive operations still require explicit approval.

### Capture the CLI development loop

Use the same bounded methodology for specification, implementation, and later blog-writing sessions:

**Developer prompt -> Copilot CLI changes -> human review -> executable check -> saved evidence.**

Give the CLI one Spec Kit stage or approved implementation slice at a time. Review its output and answer material questions before advancing. Do not pass this entire guide as one implementation request or disable questions and permission checks to bypass those review gates.

For each milestone, retain the exact prompt and follow-up corrections, CLI and Spec Kit versions, selected model, session identifier, relevant artifact or diff, human decision, and actual check commands with exit codes and results. Record the code revision when available. Preserve failures and retries; unavailable checks are blocked, not passed. A session export or agent summary does not replace test output or independent state verification.

After the milestone finishes, export the session locally from CLI chat, using a distinct filename for each milestone:

```text
/share file session .local/blog/evidence/01-constitution.md
```

Keep raw transcripts, screenshots, check output, and editorial drafts under ignored `.local/blog/`. Review them for secrets and sensitive content even when they are ignored by Git. Do not create a shareable session link or gist automatically. Only separately reviewed, sanitized excerpts belong in published material, with approval before external publication. Label any work performed outside Copilot CLI accurately rather than presenting it as CLI execution.

### Make Cosmos DB skills available to every worker

Use the latest source from the default branch of [AzureCosmosDB/cosmosdb-agent-kit](https://github.com/AzureCosmosDB/cosmosdb-agent-kit) when setting up this project, not an older local installation or an assumed latest release. Resolve and record its exact commit and skill metadata version so the demonstrated build can be reproduced. Refresh through a reviewed change rather than automatically changing the skills during a run.

Check in the complete upstream `skills/cosmosdb-best-practices/` payload under `.github/skills/cosmosdb-best-practices/`, including `SKILL.md`, referenced rules, metadata, supporting resources, and applicable license notices. Preserve upstream provenance. Do not copy the upstream repository's MCP settings or plugin configuration; this project needs the skills only. Avoid duplicate plugin and project installations of the same skill.

Repository-scoped files must be present in a fresh checkout. A user-level plugin, a link into a developer's home directory, or ignored `.local/` content does not make the skills available to a GitHub cloud worker. Keep the generated Spec Kit skills alongside the Cosmos DB skill without overwriting either.

After reloading skills or starting a new CLI session, confirm discovery with `/skills list`. For a relevant task, explicitly ask the agent to use `cosmosdb-best-practices`; retain its skill-loading evidence and the rules it consulted. Load task-relevant guidance on demand instead of injecting the entire rule catalog into every prompt. Skill installation does not prove that the skill was used or that its recommendations are correct.

If GitHub cloud coding agents are used, make the repository instructions point to these checked-in skills, the current specification, test commands, and the task's budget and stop conditions. Verify a fresh worker can discover the skill, open its referenced resources, and run a bounded check using synthetic data. Install required test dependencies through the worker's supported setup mechanism; for Actions-hosted Copilot workers this can include `.github/workflows/copilot-setup-steps.yml`. Record the worker surface and a real session/run result before claiming cloud readiness.

No additional MCP servers are required for this methodology. GitHub, Azure, and documentation MCP servers are not project prerequisites, and local editor MCP configuration must not become an undeclared cloud dependency. Skills provide guidance, not Azure authentication, database access, or deployment authority. A missing required skill or setup dependency blocks the affected task rather than silently proceeding without it.

### Budget agent usage before running it

Keep the three usage accounts separate:

| Workload | Usage to record | Controls to agree before execution |
|---|---|---|
| Copilot CLI authoring and optional cloud coding tasks | Model, input/output tokens when reported, actual GitHub AI credits, failed attempts, and elapsed time | Approved credit allowance, wall-clock deadline, retry limit, and maximum concurrent workers |
| Resolve runtime support agent | Provider-reported input/output, cached or reasoning tokens where applicable, inference/tool calls, retries, and active processing time | Per-call output limit and timeout, cumulative per-run token/cost allowance, step/tool limits, tenant admission/concurrency limits, and run expiry |
| Repository automation | Agent inference or credits, Actions minutes, artifacts, and run count | Trigger scope, job timeout, concurrency, retry limits, and supported agent-engine usage controls |

Choose numeric allowances with the developer during planning and record their scope, owner, reset rules, enforcement point, and exhaustion behavior. These are operating controls, not invented performance or cost targets. Count failed attempts, repeated inference, test runs, and recovery work; a per-worker allowance is not a shared project budget. Account separately for Cosmos DB RUs/storage and leases, Functions/storage, model usage, telemetry, and Actions compute.

In Copilot CLI chat, use the installed version's supported controls and inspect reported usage:

```text
/limits set max-ai-credits NUMBER
/usage
```

Replace `NUMBER` with an approved allowance supported by the installed version. Credit-limit behavior is preview/version-dependent: verify the minimum accepted value, whether the limit covers a response, task, or session, and when it resets. The command reference and dedicated limit guide may describe different scopes; verify the installed behavior and record any unresolved discrepancy. These are soft limits: an in-flight response can finish and exceed the allowance. Do not present them as a hard billing cap. Stop for review rather than automatically topping up or starting a fresh session to bypass a limit.

For unattended or cloud work, add an external wall-clock/job timeout and a bounded retry policy. Budget parallel tasks and any integration/review sessions together. Timeouts and cancellation stop further work as supported; they cannot undo completed actions or guarantee that an in-flight provider request is unbilled. The runtime token budget and repository workflow budget need their own enforcement; a Copilot CLI setting does not control either.

Reduce avoidable usage with narrow prompts and diffs, on-demand skills, bounded retrieved context and tool results, persisted completed steps, and deterministic checks before another model pass. Use a smaller model only when the same required checks establish adequate quality. Do not save credits by skipping verification, silently changing live-model operation to fixtures, or retrying failed output until it looks successful. Compare total usage and quality for the same task before claiming savings.

## 2. Establish the constitution

Paste:

```text
/speckit-constitution Establish these principles for Resolve, a production-oriented reference application:

1. Specification-led delivery: requirements, API contracts, implementation, and tests must remain traceable and consistent.
2. Safe agent actions: models may propose actions but cannot approve them. Application code enforces authorization and business rules.
3. Durable execution: acknowledged work and approvals survive restarts. Retries and concurrency must not duplicate business actions.
4. Tenant isolation and least privilege: derive identity from validated authentication and enforce authorization at every boundary.
5. Contract-first interfaces: externally consumed APIs have validated contracts and explicit compatibility policies.
6. Evidence over assertions: correctness requires executable tests; service-specific guarantees require service-backed verification. Unexecuted checks are blocked, not passed.
7. Bounded AI execution: constrain tool access, steps, time, and inference usage. Retrieved content is untrusted data.
8. Agent-led, human-accountable engineering: coding agents implement; humans review consequential decisions. Deterministic CI owns release gates. Repository agents cannot approve or merge their own work.
9. Reproducible delivery: provide local setup, infrastructure, deployment, observability, recovery, and transparent cost assumptions.
10. Honest production claims: distinguish a working sample from a deployment proven ready for real customer use.

Keep the architecture small. Use synthetic data and simulated financial actions. Budget coding-agent credits, runtime-model tokens, and repository automation separately; require explicit time and usage limits and record consumption honestly. Require approval before paid provisioning, external publication, or destructive operations.
```

Review the constitution before defining the feature. Run this once per project; update it only when project principles change.

## 3. Specify behavior and outcomes

Keep implementation choices for the planning step.

```text
/speckit-specify Build Resolve, an approval-aware AI support application for synthetic SaaS billing disputes.

A support representative submits: "Our team was charged twice for this month's subscription."

The application investigates synthetic invoices and a versioned service-credit policy, gathers evidence, and proposes a credit with a clear explanation. An authorized human approves or rejects that specific proposal. Approval leads to one simulated credit and a recorded outcome.

Users:
- Support representatives submit cases and inspect investigation progress.
- Approvers inspect evidence and approve or reject specific proposals.
- Operators inspect execution history and recover interrupted work.

Prioritized user stories:

P1: Submit a case and receive an evidence-backed proposal. Users can start an investigation, inspect status, and see supporting invoices and policy. Missing or contradictory evidence is surfaced, not invented.

P1: Approve and execute one simulated credit. Only an authorized human can approve. Approval applies to a specific proposal version. The AI cannot approve itself, and an unapproved or superseded proposal cannot execute.

P1: Resume interrupted work safely. Waiting for approval survives a restart. Repeated requests, concurrent approvals, and redelivered background work cannot duplicate credits or erase newer decisions.

P2: Reject and revise. An approver can reject with a reason. A revised proposal requires fresh approval.

P2: Inspect and operate. Users see a paginated execution timeline. Operators can distinguish waiting, failed, recoverable, and completed work and follow a recovery process.

P2: Maintain the repository with bounded AI assistance. Maintainers receive evidence-backed review of contract and persistence changes and reviewable documentation updates when merged changes make examples stale. Automation cannot merge changes or access production data.

Acceptance scenarios:
- Two synthetic tenants cannot access each other's cases or actions.
- Unauthorized users cannot approve.
- Repeating a request returns a consistent result.
- Reusing an idempotency key with different input produces an explicit conflict.
- Concurrent approvals cannot execute multiple credits.
- Stale approval cannot authorize a revised proposal.
- Restarting during an approval wait preserves progress.
- Recovery after provider success but before recording success reconciles the original credit instead of creating another.
- Untrusted case text cannot expand agent authority.
- Agent execution stops predictably when its configured budget is exhausted.
- Retries and restarts do not reset cumulative usage allowances; exhausted work remains inspectable and requires an authorized resume decision.

Provide a minimal browser console and a documented API for other clients. Support explicitly labeled deterministic demo mode and live-model operation. Never silently substitute simulation for failed live inference.

Exclude real payments, real customer data, customer communications, automotive scenarios, and generic multi-agent infrastructure.

Success means a developer can reproduce the full journey, restart/replay demonstrations, and normal feature delivery with verifiable results. Define measurable acceptance criteria without inventing performance or cost targets.
```

Review user stories, exclusions, edge cases, and acceptance criteria in the generated specification.

## 4. Resolve ambiguities

```text
/speckit-clarify Focus on approval-role boundaries, proposal and policy changes, idempotency scope and retention, recovery after ambiguous provider outcomes, tenant-wide case discovery, and limits on repository automation. Ask about material unresolved decisions rather than silently choosing them.
```

Answer the agent's questions. Review the resulting specification before moving to design.

## 5. Produce the technical plan

```text
/speckit-plan Implement Resolve in cosmos-agentic-support using the following constraints.

STACK
- TypeScript, Azure Functions Node.js programming model v4, and a currently supported GA Node.js runtime.
- Azure Cosmos DB for NoSQL and its official JavaScript SDK.
- A minimal browser console and a supported model endpoint with structured tool calling.
- Bicep and Azure Developer CLI for infrastructure and deployment.
- Microsoft Entra ID, managed identity, and correlated Application Insights/OpenTelemetry telemetry.

Verify current SDK APIs, hosting support, and tooling against official sources. Record compatible versions and lock dependencies. Evaluate Flex Consumption against actual regional, trigger, identity, and networking requirements.

OPENAPI-FIRST API
Author OpenAPI 3.1 contracts before handlers. Verify validator, documentation-renderer, and client-generator compatibility; document necessary tradeoffs.

Include stable operationIds, security, structured errors, pagination, idempotency, examples, and asynchronous run resources. Cover case creation/retrieval, investigation start/status, execution timeline, permitted invoice/policy reads, proposal submission, human approval/rejection, and credit results.

Generate a typed client and interactive reference. Validate requests/responses and detect unintended breaking changes in CI.

Derive model tools from an explicit operation allowlist. Do not expose approval or unrestricted credit execution to the model. OpenAPI does not replace authorization.

COSMOS DB
Use Cosmos DB as the authoritative store for cases, runs, evidence references, versioned proposals, approvals, idempotency records, results, and outbox work.

Evaluate a tenant-and-case partition key that co-locates records needing atomic updates. Explain tenant-wide listings, hot cases, growth, retention, and transaction boundaries. Avoid unbounded embedded histories.

Use point reads, partition-scoped parameterized queries, continuation tokens, database-side concurrency conditions, stable IDs, and create-only deduplication. Use transactional batches only within one container/full logical partition.

Justify indexes from actual queries, reuse SDK clients, capture RU/diagnostics, and bound SDK-aware retries. Define schema evolution and separate retention for transient and audit records. Do not call ordinary history items tamper-proof.

Use a Cosmos DB-triggered Function for outbox processing. Include its lease container, permissions, and cost. Plan for at-least-once delivery, document-type filtering, worker coordination, poison work, replay, and interrupted processing.

The synthetic provider must implement idempotency and result lookup. Reconcile ambiguous results. Do not imply Cosmos transactions extend to external services or that trigger delivery is exactly once.

RUNTIME AGENT
Persist progress between bounded steps and release compute during approval waits. Define recovery around model/tool calls, including possible repeated inference and its cost.

Bind approval to the proposal version and policy; revalidate before execution. Derive tenant identity from validated claims. Enforce roles and business rules in code. Bound steps, tokens, time, and tool calls.

Define the numeric usage policy with the developer: per-call output limits and timeouts, cumulative run tokens and estimated cost, maximum steps/tool calls/retries, tenant admission and concurrency limits, active processing deadline, and a separate expiry for approval waits. Do not keep inference or compute running while waiting for a human.

Persist cumulative usage and attempt counts across retries and restarts. Reserve allowances atomically before concurrent work and reconcile with provider-reported usage. Treat missing usage as unknown or conservatively estimated, not zero. Before starting another call, check the remaining allowance. Record an explicit budget-exhausted outcome and require an authorized resume decision; resuming must not bypass approval, idempotency, or already-completed actions. A canceled or ambiguous request can still incur charges, so reconcile it rather than assuming it was free.

Validate model arguments and treat case/invoice content as untrusted. Provide deterministic fixtures and a separately verified live-model path. MCP is not required for the first implementation.

DELIVERY
Use GitHub Copilot CLI with Cosmos DB Agent Kit for implementation guidance. Run bounded Spec Kit stages and implementation slices through the CLI, with human review and executable verification between them. Capture actual prompts, local session exports, changes, review decisions, and check results for the companion blog. Skills do not prove correctness or grant Azure access.

Use the latest upstream Agent Kit source at setup, record the resolved commit, and check the complete reviewed cosmosdb-best-practices skill into .github/skills/ for both local CLI and optional GitHub cloud workers. Verify discovery, referenced resources, and actual task-relevant loading in each used host. Do not require additional MCP servers. Include a fresh-checkout worker preflight and supported dependency setup if cloud coding is used; do not assume the developer's local plugins, secrets, or editor configuration exist there.

Implement local testing and GitHub Actions CI with a compatible Linux Cosmos DB emulator image and the Azure Functions Core Tools local host, plus Azurite for host storage when needed. Provide checked-in setup, readiness, synthetic seeding, integration/end-to-end test, diagnostic capture, and owned-resource cleanup commands. CI must invoke the same test entry points used locally, exercising the real Functions HTTP endpoints and Cosmos DB trigger rather than only calling handlers directly. Record and verify the image, SDK, Core Tools, and binding-extension versions, including Functions trigger and leases compatibility. Keep unavailable checks blocked, not passed.

Document Resolve's actual setup and test commands in the quickstart. Reference the previous emulator local/CI blog post for the general image lifecycle pattern instead of repeating that tutorial; it does not replace implementing this project's test runner. Include record inspection through Data Explorer or the VS Code extension.

Create two GitHub Agentic Workflows:
1. Contract/Cosmos implementation reviewer: evidence-backed findings on relevant specification, API, persistence, and test changes.
2. Documentation/sample maintainer: proposes reviewable updates when merged API changes affect examples and the walkthrough.

Verify triggers, authentication, frontmatter, network rules, and safe outputs against pinned gh-aw tooling. Check in source Markdown and compiler-generated .lock.yml files. Never hand-author generated lock files.

Use minimal permissions, bounded execution, sanitized inputs, and human-reviewed outputs. No production database access, deployment credentials, auto-merge, or privileged execution of untrusted code.

Conventional GitHub Actions owns deterministic build, lint, type-check, contract checks, tests, and protected deployment gates. Repository agents do not orchestrate runtime support cases.

Budget CLI authoring, cloud coding tasks, runtime inference, and repository automation separately. Document the installed CLI's credit-limit semantics and overshoot, supported workflow limits, wall-clock deadlines, cumulative retry/concurrency costs, and stop/resume decisions. Keep an evidence ledger linking prompts and code revisions to reported usage and verification results. No automatic budget increases or extra paid runs to conceal a failure.

OPERATIONS AND PROOF
Use managed identity, least-privilege Cosmos data permissions, GitHub-to-Azure OIDC, and protected deployment environments.

Plan configuration validation, health checks, alerts, rollback/recovery, retention, backup/restore, network exposure, abuse controls, and operating costs. Protect secrets and sensitive content in logs and artifacts.

Require unit, contract, integration, and end-to-end tests, including service-backed concurrency and transaction checks. Distinguish mocks, emulator evidence, and isolated cloud verification.

Verify budget exhaustion before another call, bounded retries, concurrent allowance reservations, restart-safe counters, and no repeated effects during budgeted recovery. Record actual inference usage and distinguish observed credits/tokens from estimated currency costs. Date and source pricing assumptions; preserve unknown usage and billing gaps explicitly. Do not claim savings without a comparable measured baseline.

Produce standard Spec Kit planning artifacts: research decisions, data model, contracts, and quickstart. Include an architecture diagram separating runtime from repository automation.

Build the first complete vertical slice before polish. No staged break/fix exercise. Capture actual prompts and evidence for a later blog; the full blog is a separate task.
```

Review the technical decisions, data model, API contracts, resource inventory, deployment assumptions, and quickstart.

## 6. Check requirements quality

```text
/speckit-checklist Create a requirements-quality checklist focused on approval authority, tenant isolation, durable state transitions, idempotency/recovery, API compatibility, bounded agent execution, repository automation boundaries, reproducible deployment, and agent economics.

Check whether requirements are complete, clear, measurable, and consistent. Check budget units, ownership, scope/reset rules, soft versus enforced limits, exhaustion/resume behavior, and usage evidence. If cloud coding is used, check that repository-scoped skills and dependency setup are specified without hidden local or MCP prerequisites. Do not treat this as an implementation test report or automatically approve reviewer-owned items.
```

Custom checklists are reviewer-owned. A checked item means the requirement-quality criterion was reviewed and satisfied, not that implementation passed. Resolve gaps through the appropriate earlier step.

## 7. Generate tasks

```text
/speckit-tasks Generate dependency-ordered tasks with explicit unit, contract, service-backed integration, and end-to-end verification.

Prioritize a complete case -> investigation -> proposal -> durable approval wait -> authorized approval -> one simulated credit -> persisted timeline vertical slice.

Follow with rejection/revision, repository automation, and operational hardening. Include setup instructions and evidence capture in the relevant phases.

Before the first vertical slice, include foundational tasks for the Linux Cosmos DB emulator image, Azure Functions Core Tools local host, Azurite when needed, and the shared local/CI test runner. Include readiness, synthetic fixtures, actual HTTP/trigger integration checks, bounded execution, diagnostic artifacts, and cleanup of owned resources. Use the same test entry points locally and in GitHub Actions CI. Keep emulator-backed deterministic checks, live-model tests, and isolated Azure verification separately labeled; unexecuted checks are blocked, not passed. The previous blog is a setup reference, not a substitute for these implementation and verification tasks.

Include latest-source Agent Kit installation with recorded provenance and complete repository-scoped skills, host discovery/loading checks, and a fresh-worker preflight if cloud coding is used. Include approved time/credit/token allowances, usage accounting, budget-exhaustion and restart/concurrency tests, bounded retries, and measured cost evidence. Additional MCP servers are not required.
```

Review `tasks.md` for test coverage, dependencies, and independently verifiable user-story phases.

## 8. Analyze artifact consistency

```text
/speckit-analyze
```

This command is read-only. Fix findings in the artifact that owns the problem:

| Finding | Return to |
|---|---|
| Missing or ambiguous behavior | Specify or clarify |
| Incorrect technical design | Plan |
| Missing implementation or verification work | Tasks |

Rerun analysis after corrections. Do not silently weaken requirements to make the analysis pass.

## 9. Implement the first vertical slice

```text
/speckit-implement Implement the Setup, Foundational, and user-story phases needed for the first complete case-to-approved-credit vertical slice in tasks.md.

Perform this work in GitHub Copilot CLI. Run associated checks and record actual prompts, changes, human review decisions, and check results. Stop before later feature phases and paid provisioning. Mark unavailable checks blocked, not passed. Do not change reviewer-owned checklist approvals.
```

Review the working slice, then continue:

```text
/speckit-implement Implement the remaining approved tasks for rejection/revision, repository automation, and operational hardening.

Continue the same bounded GitHub Copilot CLI workflow. Verify each phase. Record evidence and remaining environment blockers. Request approval before paid provisioning, external publication, or destructive operations.
```

If tasks use different phase names, scope implementation to the actual generated phases rather than inventing new ones.

## 10. Verify convergence

After implementation has run on the current task list:

```text
/speckit-converge
```

Convergence assesses implementation against the specification, plan, and tasks. It can append missing tasks; it does not repair code itself.

If tasks are appended, run `/speckit-implement` for those tasks, then `/speckit-converge` again. Report persistent blockers instead of looping without progress.

**Converged is not a production certification.** Cloud verification, deployment approval, security controls, recovery evidence, and operational readiness remain explicit gates.

## 11. Demonstrate the application

Use actual execution evidence:

1. Show the specification and OpenAPI contract.
2. Submit the synthetic duplicate-charge case.
3. Show the agent gathering evidence and proposing a credit.
4. Inspect the corresponding Cosmos DB records and partition boundary.
5. Restart the application while approval is pending.
6. Approve the same proposal and show one simulated credit.
7. Replay the request and verify no additional credit.
8. Show rejection/revision behavior and fresh approval requirements.
9. Show actual repository review and documentation-maintenance workflow output.
10. Explain measured behavior, costs, and remaining production gaps.

If demonstrating feature development separately, use rejection/revision as a normal follow-on Spec Kit feature rather than introducing a deliberate defect. A separate feature needs its own specification, plan, and tasks.

## 12. Direct the blog-writing agent

Use this as a separate writing prompt in GitHub Copilot CLI after implementation evidence exists. It is not a Spec Kit command. Review the evidence-backed outline before requesting the full draft.

```text
Develop an evidence-backed technical blog about building cosmos-agentic-support with GitHub Copilot CLI.

Working title: "From Spec to Safe Agent Actions: Building with Azure Cosmos DB, Azure Functions, and GitHub Agentic Workflows"

Audience: developers building agentic applications in 2026.

Thesis: useful agents need durable state, explicit authorization, concurrency control, and replay-safe actions. Cosmos DB supplies these application foundations; an OpenAPI-first Azure Functions API exposes controlled tools; coding agents and GitHub Agentic Workflows help deliver and maintain the implementation.

Inspect the repository and execution evidence first. Produce an outline tied to actual artifacts and identify missing evidence before drafting.

Document the actual development method: bounded prompt -> Copilot CLI changes -> human review -> executable check -> saved evidence. Use the original local CLI session exports and test output, not reconstructed conversations. Identify the CLI version and selected model used for demonstrated work. Distinguish coding-agent inference from the application's runtime model. Label work done in other tools accurately.

Show the checked-in Cosmos DB Agent Kit skill, its resolved upstream commit, and actual loading evidence. If cloud coding was used, show the fresh-worker preflight and real session/run; otherwise label it unverified. No additional MCP servers are required, and this article must not become an MCP setup walkthrough.

Explain agent economics with actual usage: separate Copilot credits, runtime-model tokens and charges, repository-agent inference, and Actions/infrastructure costs. Show the configured scope and enforcement of time, retry, concurrency, and usage limits, including soft-limit overshoot and budget exhaustion/recovery. State pricing dates, assumptions, unknowns, and any explicitly approved budget increases. Discuss narrow context, on-demand skills, and deterministic verification as usage controls; do not invent savings or omit failed attempts.

Structure:
1. Show the finished case-to-approved-credit journey.
2. Turn the brief into a specification with Spec Kit.
3. Define OpenAPI and the restricted agent tool boundary.
4. Build the first working slice with GitHub Copilot CLI.
5. Explain Cosmos DB documents, partitioning, conditional writes, transactional batches, and outbox processing using real implementation excerpts.
6. Demonstrate restart/resume and replay-safe credit execution.
7. Show a normal feature increment, not a staged break/fix.
8. Show actual GitHub Agentic Workflow review and documentation maintenance.
9. Explain deployment, operating costs, and remaining production requirements.

At each milestone show the developer prompt, meaningful agent artifact, human decision, and verification evidence.

Distinguish coding agent, runtime agent, and repository automation. Never imply GitHub Agentic Workflows orchestrates customer cases.

Include selected real code/contract excerpts, a runtime-versus-repository architecture diagram, an approval/resume sequence diagram, reproducible commands, and a 10-minute demo script.

Explain how each tool reduces specific delivery friction. Avoid a disconnected tool roundup, generic AI introduction, productivity percentages, or claims that agents eliminate engineering judgment.

Do not fabricate workflow runs, deployments, measurements, or defects. Distinguish fixture execution from live inference and emulator evidence from cloud validation. Do not label the sample production-ready without supporting evidence.
```

## Official references

- [From Local Development to CI Workflows with the Azure Cosmos DB Emulator](https://devblogs.microsoft.com/cosmosdb/from-local-development-to-ci-workflows-with-the-azure-cosmos-db-emulator/)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference)
- [Copilot CLI AI credit limits](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/set-session-limit)
- [Cosmos DB Agent Kit source](https://github.com/AzureCosmosDB/cosmosdb-agent-kit)
- [Agent Kit setup and verification](https://learn.microsoft.com/en-us/azure/cosmos-db/gen-ai/agent-kit/setup)
- [Repository-scoped Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [GitHub Spec Kit repository](https://github.com/github/spec-kit)
- [Spec-Driven Development quickstart](https://github.github.io/spec-kit/quickstart.html)
- [Agentic SDD command reference](https://github.github.io/spec-kit/reference/agentic-sdd.html)
- [Spec Kit existing-project guidance](https://github.github.io/spec-kit/guides/existing-projects.html)
- [GitHub Agentic Workflows overview](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows)
- [Azure Cosmos DB Agent Kit](https://learn.microsoft.com/en-us/azure/cosmos-db/gen-ai/agent-kit)
- [Azure Functions Node.js reference](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node)
- [Azure Cosmos DB transactional batches](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch)
- [Azure Cosmos DB trigger for Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-cosmosdb-v2-trigger)
