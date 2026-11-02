# GitHub Agentic Workflows: measured evidence

Repository `jaydestro/cosmos-agentic-support-api`, `gh aw` v1.0.1 (compiler), engine `copilot` (Copilot CLI 1.0.103),
agent firewall AWF v0.29.0. Everything below was read from the run pages and run artifacts
(`usage`, `safe-outputs-items`, `agent`); nothing is estimated. Skipped runs are listed separately and **not counted**.

## Verdict

Both workflows **ran on GitHub** (seven executed runs; an eighth was still running when this was written and is not counted) (activation, agent, detection and safe-output jobs executed). Neither produced an
artifact a human could accept or reject. The agent job failed with `authentication_failed` in six of the seven executions
after Copilot inference had already been billed. The one run that finished green ended in a `noop` safe output.
The compiled bounds held in structure (permissions, one-comment limit, threat detection), but the **soft AI-credit limit of
2 was exceeded roughly five-fold by one request in every run**. This is the real, measured outcome; no benefit is claimed.

## Runs that executed

| # | Workflow | Trigger | Run | Jobs | Agent outcome | Safe output | Human decision |
|---|---|---|---|---|---|---|---|
| 1 | Documentation/sample maintainer | `workflow_dispatch` on `main` | [41360129792](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41360129792) | activation ok, **agent failed**, detection ok, safe_outputs ok, conclusion failed | `authentication_failed`, 1 attempt, 0 retries (configured) | `report_incomplete` (no PR) | None possible: nothing was proposed |
| 2 | Contract and Cosmos DB reviewer | `workflow_dispatch` on `main` | [41361417593](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41361417593) | all six jobs succeeded | exit 0 (harness recorded one `authentication_failed` attempt, no retry) | `noop` (manual dispatch has no PR to review, by design) | None possible |
| 3 | Contract and Cosmos DB reviewer | `pull_request` ([PR #3](https://github.com/jaydestro/cosmos-agentic-support-api/pull/3)) | [41362320000](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41362320000) | activation ok, **agent failed**, detection ok, safe_outputs ok, conclusion failed | `authentication_failed`, 1 attempt | `report_incomplete`; PR has 0 comments | None possible |

Runs 4 to 7 are further reviewer runs triggered by pushes to PR #3 (event `pull_request`): [41364262380](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41364262380), [41365236482](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41365236482), [41366028728](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41366028728) and [41367643765](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41367643765). Each failed in the agent job with `authentication_failed`, produced `report_incomplete` and left no PR comment.

Not counted: reviewer runs [41329745600](https://github.com/jaydestro/cosmos-agentic-support-api/actions/runs/41329745600),
41230031316, 41230648065, 41232057255 and 41236841843 were **skipped** by the approval variable gate. Reviewer runs
41353001277 and 41354856865 failed in `activation` (the compiled workflow reads its Markdown from the base branch and
the file was not on `main` yet); they were fixed by merging [PR #1](https://github.com/jaydestro/cosmos-agentic-support-api/pull/1).

## Permissions (compiled lock files)

| Job | `contract-cosmos-review` | `docs-maintainer` |
|---|---|---|
| agent | contents read, pull-requests read, **copilot-requests write** | contents read, **copilot-requests write** |
| detection | contents read, copilot-requests write | contents read, copilot-requests write |
| safe_outputs | issues write, pull-requests write | contents write, issues write, pull-requests write |
| conclusion | issues/pull-requests write, checks/actions read | contents/issues/pull-requests write |

The agent job has no write to repository contents, issues or pull requests; writes happen only in `safe_outputs`.
`copilot-requests: write` is the only addition made for this run. It replaces a stored personal token, so no secret
exists in the repository. gh-aw rejects `gho_` OAuth tokens for `COPILOT_GITHUB_TOKEN`, and a fine-grained PAT can only be
created in the GitHub web UI, so the PAT route was not available to this automation.

## Safe-output and run limits (as compiled)

- Reviewer: `add-comment` max 1, target triggering PR, `create-issue` false, `report-missing-tool`/`report-missing-data` max 1
  with issue creation disabled. Docs maintainer: at most one draft PR, one changed file, 64 KiB, README only, with a
  deterministic post-agent guard.
- Threat detection enabled, 1 AI credit, 4 turns, `engine-timeout` 2m, 0 retries. Safe-output job timeout 5 minutes.
- Agent: `max-turns` 8, `max-ai-credits` 2, harness retries 0, step timeout 10 minutes. **The agent *job* timeout in the
  compiled lock is 60 minutes** (the 10-minute value applies to the engine step), a difference from the earlier README text.
- Concurrency group per workflow/PR; `RESOLVE_REPOSITORY_AUTOMATION_APPROVED` repository variable set to `true` on 2026-11-01.

## Usage (from the `usage` artifact; AI credits are provider-reported, not dollars)

| Run | Agent model | Input tok | Output tok | Cache-write tok | Agent credits | Detection (model, credits) | Wall time |
|---|---|---|---|---|---|---|---|
| 41360129792 | claude-sonnet-5.5 | 447 | 142 | 44,112 | **11.2594** | claude-haiku-5.5, 0.285 + 0.237 = 0.522 | 3m38s (create to last job) |
| 41361417593 | claude-sonnet-5.5 | 381 | 201 | 39,285 | **10.0985** | claude-haiku-5.5, 0.27 + 0.21 | 4m11s |
| 41362320000 | claude-sonnet-5.5 | 381 | 161 | 39,288 | **10.0592** | claude-haiku-5.5, 0.28 + 0.22 | 4m34s |

Runs 4 to 7 each billed 10.06 agent credits (381 input, 161 output, about 39,28x cache-write tokens). Measured total for the seven executed runs: about 71.7 agent credits plus about 0.5 detection credits per run, against a configured soft
limit of 2 per agent run. The overshoot is a single large prompt (about 40k cache-write tokens of system context and tool
schemas), which the turn limit cannot prevent. Dollar cost, Actions minutes billed and Copilot premium-request
accounting are **not measured**. The runtime-model usage of the application (deterministic demo mode) is **not measured**
because no live model was configured; coding-agent (this session's Copilot) usage is **not measured**.

## Benefits and limits that are supported by measurement

- **Measured:** the Markdown source compiles to reviewed lock files with pinned action SHAs; compile and the SHA check run in CI
  (`workflows:check`, 139 references, 10 distinct). Permission separation is observable in the lock files above.
- **Measured:** threat detection and the safe-output job ran in every executed run, and a failed agent produced no write.
- **Measured limit:** inference authentication on a user-owned repository failed even though one request was billed.
- **Measured limit:** the soft credit cap was exceeded in all seven runs.
- **Not measured:** review quality, time saved, defects found, maintenance savings. There is no comparable human baseline, so
  none is claimed. No finding or documentation change was ever produced.

## To obtain a real accept/reject record

Create a fine-grained PAT (resource owner: the user, **Copilot Requests: Read**), store it with
`gh aw secrets set COPILOT_GITHUB_TOKEN`, rerun both workflows, and record the reviewer comment or draft PR and whether it was
accepted or rejected. This was not done here because the PAT cannot be created from the CLI.
