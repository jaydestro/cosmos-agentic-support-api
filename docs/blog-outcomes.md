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
