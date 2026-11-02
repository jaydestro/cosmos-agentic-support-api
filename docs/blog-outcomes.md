# Resolve delivery outcome log

Sanitized evidence for a future blog, not a production certification. Only fictional
application data belongs in this log. Do not add tokens, subscription/directory
identifiers, private resource inventories, customer data or raw deployment settings.
The implementation plan and operating decisions remain in [README](../README.md).

## 2026-10-30: local verification

The complete `npm run check:all` command exited 0:

| Evidence category | Result |
|---|---|
| Unit | 2,066 passed |
| Real Functions host + Cosmos DB emulator + Azurite integration | 129 passed |
| Chrome desktop/mobile/operator journeys | 41 passed |
| Compiled Bicep and protected-workflow invariants | 4 passed |
| Real secret scanner and API breaking-change detector self-tests | 2 passed |
| Contract lint, generated-client drift, typecheck, lint, build/package | Passed |
| Agentic workflow compiler v1.0.1 | Two workflows compiled; fingerprints matched |
| Dependency audit | Zero reported vulnerabilities at that time |

A fresh `npm ci --ignore-scripts` and `npm run check` also exited 0.
These results prove local/emulator behavior, not Azure, real Entra authentication,
live-model inference or execution of GitHub workflows.

Useful implementation outcomes:

- Browser recovery preserves usage across an allowance grant and still requires a
  distinct approver before one simulated credit is issued.
- Poison-work requeue and a stale requeue form are exercised through real HTTP and
  the Cosmos DB trigger; the simulated provider ledger is independently inspected.
- A work-id selector initially matched both the original item and its `-g1` resume
  item. Exact matching fixed the test, without changing application behavior.
- Cancelling recovery returns keyboard focus to its opener. Outbox cards are called
  "Background work", including investigation starts.
- Strict CSP remains enabled in browser tests. String `waitForFunction` predicates
  were blocked; Node-side polling replaced them, not `bypassCSP`.
- Core Tools intermittently failed during worker startup with a null-provider error.
  Both 4.15.2 and an isolated, checksum-verified 4.16.0 showed it. Verbose diagnostics
  were added; subsequent complete runs passed. No claim that upgrading fixed its cause.
- The earlier Azure Identity/MSAL Node advisory was fixed by pinning Identity 4.14.1,
  resolving MSAL Node 7.1.2. The subsequent audit was clean.
- Agentic-workflow compilation exposed a default 400-credit detector budget. Explicit
  agent/detector limits and retry controls replaced that default; detection stayed on.

## 2026-10-31: requested merge, deployment and proof

Authorization received to merge, deploy, test and preserve blog outcomes.
Publication and Azure evidence will be recorded separately below as they occur.
No paid execution or success claim is implied by a prepared template or workflow.

### Access and source-control preflight

- The initial active GitHub CLI session could read the public repository but could
  not push or read its configuration. A push dry-run correctly failed with HTTP 403.
- An existing repository-owner session was used only within the command process;
  the authorized push dry-run succeeded. Global authentication was not switched,
  and no credentials were printed, persisted in source or put on command lines.
- Main was fetched. The prepared branch was one commit ahead, with no divergence.
  The repository has no main-branch protection; this does not justify bypassing
  the application's checks or claiming an unsuccessful run passed.
- Actions are enabled with read-only default workflow permissions. No deployment
  variable or secret names were configured at this preflight.
- The sanitized implementation was committed as
  `f92db9fe72e932f9b7b3533d5205e06c538bfca7` and pushed to
  `feat/resolve-serverless-sample` with public noreply author metadata and the
  Copilot co-author trailer.
- [Draft PR #1](https://github.com/jaydestro/cosmos-agentic-support-api/pull/1)
  was opened against main. Its description explicitly records the failing audit
  and the unexecuted cloud proof; it is not merged or represented as green.
- Git warned that Windows checkout could rewrite generated files as CRLF. Explicit
  LF attributes were added for workflow Markdown/locks, the action-pin manifest,
  generated client types and the attribute file so regeneration remains portable.

### New audit result after the previous clean run

`npm run check` again passed contract/type/lint and all 2,066 unit tests, then failed
at the dependency audit. This is a real failed gate, not a passing deployment check.

- One new moderate advisory,
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
  was published at **2026-10-30 23:09:55 UTC**, after the clean local run.
- It concerns minimatch glob-parts amplification and appears in 13 development
  dependency entries, not 13 distinct vulnerabilities.
- Resolved affected versions: minimatch 10.2.6 in ESLint/typescript-eslint and
  minimatch 5.1.9 in the OpenAPI type generator's older Redocly dependency.
- The shared CVE assessment tool independently reported one finding across the
  two minimatch coordinates.
- `npm audit --omit=dev` reported zero production dependency vulnerabilities.
  That narrower result does **not** make the full dependency audit pass.
- The advisory names 11.0.1 as patched. The configured registry returned 404 for
  that version and listed versions only through 10.2.6. Direct public-registry
  retrieval failed with TLS handshake errors using multiple verified clients.
  An upstream Git tag exists, but no release asset was available in the checked
  GitHub release endpoint. These are distribution/access observations, not a
  claim that no patch exists anywhere.
- No `npm audit fix --force`, forced major override, disabled TLS verification,
  silent audit exception or blind downgrade was used. In particular, the legacy
  Redocly code calls minimatch as a function; blindly replacing it with the newer
  named-export API would be a compatibility risk.

### First actual GitHub runs

- [Resolve checks run 41230031305](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41230031305)
  ran on the draft PR and failed at the full dependency audit. Contract, typecheck,
  lint and 2,066 unit tests passed in the GitHub-hosted Linux job. The audit failure
  stopped later service/browser stages; yesterday's local service results are not
  substituted for an unexecuted GitHub stage.
- [Reviewer workflow run 41230031316](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41230031316)
  was registered but skipped by the explicit automation-approval gate. No agent or
  detector inference is claimed to have run.
- The PR merge state was `UNSTABLE`; it remained draft rather than bypassing the
  failed check. Actions billing/credits are unmeasured here; observed workflow
  execution is not a claim of zero cost.
- The tested line-ending/outcome revision was committed as
  `65f3bd3d19803937ac8fcd8f190a66ba36b9bf57`.
  [Its GitHub check 41230648040](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41230648040)
  again passed 2,066 unit tests and failed on the same moderate advisory.
  [The corresponding reviewer run](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41230648065)
  was again skipped, not counted as agent execution.

### Decision boundary

A focused decision form asked for an installable-patch requirement versus a
72-hour exception scoped only to this moderate development advisory, and for the
Azure target, numeric limits, real Entra setup and private seed-runner approval.
The tool returned "user unavailable" rather than actual decisions. No exception,
paid-limit confirmation, app-registration authorization or seed-runner approval
was inferred from that response.

The existing instruction to merge/deploy is recognized. The additional gates in
the project instructions are not silently removed: main has not been updated,
Azure has not been provisioned, and real cloud tests remain unexecuted.

### Evidence still required

- Successful GitHub checks and an actual merged PR/commit.
- Approved Azure target, regional cost assumptions and numeric paid-execution limits.
- Provider validation/what-if, protected OIDC setup and real app registrations.
- Real token/role denials, private DNS, app managed-identity data/lease access,
  outside-network denial, serverless/FC1/zero-always-ready configuration.
- Approved private-network cloud seeding, independent read-back and safe repeat seed.
- Azure HTTP/browser journey and independently inspected one-effect provider results.
- Actual runs of the two agentic workflows; approved live-model runs remain separate.

Coding-agent token/cost totals are unavailable here and therefore unknown, not zero.
Runtime-model and repository-automation consumption must be tracked independently.

## 2026-10-31: goal confirmation, immutable workflows and real Azure preflight

The goal was explicitly reconfirmed: prove a successful Azure Cosmos DB/full-API
deployment, demonstrate Cosmos best practices and evidence-backed agentic-workflow
benefits, and feed the results into a blog. Repository-memory write attempts were
rejected by the memory service; they are not claimed as saved. The requirements
were instead recorded in the repository's mutable instruction file, not the
read-only conversation attachment.

- Read the official GitHub Agentic Workflows overview, quickstart, creation and
  secure-use guidance. The official GitHub MCP verified the published workflow
  source and the ten distinct action references in their canonical repositories.
- All 139 executable `uses` references were already full 40-character SHAs.
  An exhaustive regression gate now covers all six workflow surfaces, including
  generated lock YAML and agentic frontmatter. It rejects tags, branches, shortened/
  nonhex hashes, missing hashes and dynamic external references.
- Focused policy tests: **15 passed**. ESLint, both project typechecks and
  compiler/lock verification passed. Locks were not hand-edited.
- This verification took longer than necessary because source pinning was
  over-investigated; it was verification work, not Azure deployment progress.
- The configured registry still could not supply minimatch 11.0.1. The official
  source tag exists, but it contains no built `dist` tree and uses a preparation
  build; a blind source override would not preserve the current locked install
  and legacy API compatibility. No force update or audit exception was introduced.
- Azure effective-permission inspection explicitly confirmed **no**
  `Microsoft.Authorization/roleAssignments/write` permission. This is an actual
  authorization blocker for the template's managed-identity host-storage and
  telemetry grants, not merely an unanswered configuration question.
- Group-inclusive role inspection found two active subscription assignments and
  no resource-group-scoped assignments or existing Owner/RBAC-administrator grants.
  No alternate already-authorized group scope was found. No role elevation,
  account-key fallback or partial paid deployment was attempted.
- Three similarly named Entra registrations were inspected read-only. They are
  unrelated and expose none of the required application roles, delegated scope
  or SPA redirects. Their names/identifiers are not copied into this log and they
  were not reused or modified.
- No paid Azure resources, real directory users or client secrets were created.
  An administrator must bootstrap the necessary narrowly scoped role-assignment
  authority, or an already-authorized deployment identity/context must be supplied,
  before the secure deployment can succeed. Existing merge/deploy authorization
  does not grant missing Azure permissions.

## 2026-11-01: managed identities actually created

The user explicitly requested creation of the required managed identity. The
identity-only bootstrap was added to Bicep so it is reproducible and matches the
future application deployment's naming.

- Created the dedicated demo resource group in East US. No unrelated resources
  or existing registrations were changed.
- `infra/identities.bicep` passed lint/build, normal provider validation and what-if
  before deployment. The `resolve-identities` deployment **Succeeded**.
- Independent management-plane read-back verified exactly three identities:
  application, reference seeder and deployment. Client IDs and principals were
  present and distinct; private identifiers are not copied into this public log.
- Verified the deployment identity's exact GitHub OIDC issuer, protected
  `azure-demo` environment subject and token-exchange audience.
- A repeat what-if showed **four NoChange resources**. Identity creation is
  repeatable without duplicates or changes to the trust.
- An actual second `resolve-identities-repeat` deployment also succeeded;
  independent before/after read-back confirmed exactly three identities with
  unchanged client IDs and principals. This is executed repeat evidence, not only
  a what-if prediction.
- The first local result parser encountered a Bicep warning mixed into JSON.
  That was a log-parsing failure, not a deployment failure. Independent Azure
  read-back, rather than treating the ambiguous CLI output as success, established
  the actual succeeded state.
- All three identities currently have **zero Azure RBAC grants**. Identity
  creation does not inherit the creator's permissions or solve missing role-write
  authority.
- The administrator-access template limits deployment authority to the dedicated
  group and IAM changes to two specific application-identity roles. Six compiled
  infrastructure tests, typechecks and focused lint passed.
- Bicep multiline strings did not interpolate role/principal values. An explicit
  compiled-condition check caught that defect; placeholder replacement fixed it.
  The corrected template passed provider condition/schema validation.
- `ProviderNoRbac` validation deliberately excluded caller authorization and is
  not claimed as authorization proof. Full `Provider` validation failed on both
  required `roleAssignments/write` operations, confirming the remaining blocker.
  No roles were granted, no key fallback was used, and no self-elevation was attempted.

This is **successful managed-identity deployment**, not successful full API/Cosmos
deployment. Functions, Cosmos DB, storage, telemetry and private networking have
not been provisioned; no real API, cloud seed or live-model tests have run. An
authorized administrator must complete the narrowly scoped access bootstrap before
the deployment identity can execute the full protected deployment.

## 2026-11-01: Azure deployed, proven and documented

Superseded blockers are resolved or restated in [evidence/azure-proof.md](evidence/azure-proof.md), [evidence/github-agentic-workflows.md](evidence/github-agentic-workflows.md) and [evidence/cosmos-agent-kit-rules.md](evidence/cosmos-agent-kit-rules.md); the tutorial is [blog/resolve-cosmos-db-agentic-workflows-tutorial.md](blog/resolve-cosmos-db-agentic-workflows-tutorial.md).

- Node 24.22.2 local gate passed; audit advisory handled by a dated, explicit exception (no patched minimatch exists).
- Azure East US: Flex Consumption + serverless Cosmos DB + private endpoint + managed identity deployed and exercised; one provider credit under concurrent approvals; seed repeat non-destructive; outside and token denials observed.
- Azure-only bug: prefix partition key queries return HTTP 400 on the service (accepted by the emulator); fixed in src/cases/store.ts.
- Not proven: real Entra user tokens (tenant requires a ServiceManagementReference to create an app registration), identity-based host storage (no role-assignment authority), OIDC deployment.
- GitHub Agentic Workflows: 7 executed runs, 6 agent failures (authentication_failed), no output to accept or reject; about 72 agent credits billed against a soft limit of 2 per run.
- Costs: Cosmos RU measured from metrics (about 13,000 RU); dollar costs not measured.

- CI note: the first full GitHub run of the service-backed suite exposed failures: fixture outbox items executed by the trigger and a missing wait for the poison notification (both fixed), and an intermittent 90-second timeout in tests/integration/decisions.test.ts (lets exactly one of two competing decisions win) while four investigations run at once. That test failed in 3 of 6 CI attempts on the same code lineage (passed locally on the emulator in every complete run after one early failure). Moving the Cosmos evidence generator out of the shared suite did not remove it, so it is **not** the cause. Root cause not established; the CI log now prints host warnings on failure (	ests/support/cli.ts) so the next failure carries evidence. Treat the service-backed suite as flaky on 2-core runners until then.
