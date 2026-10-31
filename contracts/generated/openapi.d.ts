export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness (minimal, anonymous) */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Readiness (minimal, anonymous)
         * @description Reports only `ok` or `unavailable`. No dependency details are exposed.
         */
        get: operations["getReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Who am I, and which modes are active */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the tenant's cases, newest first */
        get: operations["listCases"];
        put?: never;
        /** Submit a dispute (asynchronous, idempotent) */
        post: operations["createCase"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** Case detail with latest run, proposal and credit result */
        get: operations["getCase"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** Ordered timeline (oldest first), paginated */
        get: operations["getCaseTimeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** Investigation runs of the case (one per revision) */
        get: operations["listInvestigationRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        /** Run status, limits and persisted usage counters */
        get: operations["getInvestigationRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/runs/{runId}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        /** Per-call usage events (failed and ambiguous calls included) */
        get: operations["listRunUsageEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /** Proposal versions of the case (bounded by the revision limit) */
        get: operations["listProposals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/proposals/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        /** One proposal version with its citations */
        get: operations["getProposal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/proposals/{version}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve the exact pending proposal (asynchronous execution)
         * @description Approver role required; the approver must not be the case creator (`403`
         *     `forbidden_separation_of_duties`). The request is bound to the proposal `digest` and
         *     `policyVersion` the approver saw. The decision, case transition and execution outbox item
         *     commit atomically; the credit is issued afterwards by deterministic code and revalidated
         *     before execution.
         *
         *     A refusal is `409` with one of these codes: `proposal_not_decidable` (a finding, which
         *     proposes no credit), `proposal_already_decided`, `proposal_superseded`, `approval_expired`,
         *     `proposal_digest_mismatch`, `policy_version_mismatch`, `policy_version_changed` (the policy
         *     version in effect is no longer the one the proposal cites; approvals only) or
         *     `concurrent_update` (read the case and retry). Repeating an identical decision by the same
         *     approver replays the stored decision.
         */
        post: operations["approveProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/proposals/{version}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reject the exact pending proposal with a recorded reason
         * @description Approver role required; the approver must not be the case creator (`403`
         *     `forbidden_separation_of_duties`). The reason is recorded with the decision and kept as
         *     untrusted text. A rejection issues nothing, so it does not need the cited policy version to
         *     still be in effect.
         *
         *     A refusal is `409` with one of these codes: `proposal_not_decidable`,
         *     `proposal_already_decided`, `proposal_superseded`, `approval_expired`,
         *     `proposal_digest_mismatch`, `policy_version_mismatch` or `concurrent_update` (read the case
         *     and retry). Repeating an identical rejection by the same approver replays the stored
         *     decision.
         */
        post: operations["rejectProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start a new investigation after a rejection, expiry or stale version
         * @description Creates run `N+1`; its proposal becomes version `N+1` and needs fresh approval. The reason
         *     is stored and shown to the agent only as untrusted data. At most 3 revisions per case.
         *     Allowed when the case is `rejected`, `expired` or `finding_reported`; any other status
         *     returns 409 `revision_not_allowed`, and a request past the limit returns 409
         *     `revision_limit_reached`. `concurrent_update` (409) means another change won; read the case
         *     and retry. A revision request is not idempotent: repeating one that succeeded is refused,
         *     because the case is no longer revisable.
         */
        post: operations["requestRevision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cases/{caseId}/credit": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        /**
         * The recorded result of the simulated credit
         * @description `404` until a credit has been recorded: the case may still await a decision, have been
         *     rejected, or have an approved credit that is not executed yet.
         */
        get: operations["getCreditResult"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/{accountId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                accountId: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        /** A fictional account with its subscriptions */
        get: operations["getAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/{accountId}/invoices": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                accountId: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        /** Invoices of an account, newest first */
        get: operations["listInvoices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invoices/{invoiceId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoiceId: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        /** One invoice with lines and payments */
        get: operations["getInvoice"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Credit policy versions of the tenant, newest first */
        get: operations["listPolicies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/policies/{policyId}/versions/{policyVersion}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                policyId: components["parameters"]["PolicyId"];
                policyVersion: components["parameters"]["PolicyVersion"];
            };
            cookie?: never;
        };
        /** One immutable policy version with its clauses */
        get: operations["getPolicy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operator/work": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Work items by state (operator only)
         * @description Lists the work of the operator's own tenant in one state, newest first, one page at a time.
         *     `waiting` is a proposal that awaits a decision and has not expired; `failed` is a run that
         *     failed or was blocked, and has no recovery action; `budget_exhausted` is a run that stopped
         *     at its allowance; `poison` and `completed` are outbox items; `recoverable` is an outbox item
         *     whose claim lapsed, or that has stayed pending for more than five minutes after it was due.
         */
        get: operations["listOperatorWork"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operator/work/{workId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workId: components["parameters"]["WorkId"];
            };
            cookie?: never;
        };
        /**
         * Inspect one work item (operator only)
         * @description `404` when the item does not exist, belongs to another tenant, or is in no operator state:
         *     a proposal that is not waiting for a decision, a run that is queued, running or completed,
         *     and an outbox item that is claimed within its lease or pending and not overdue cannot be
         *     inspected. A completed outbox item can.
         */
        get: operations["getOperatorWorkItem"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operator/work/{workId}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workId: components["parameters"]["WorkId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Requeue poison/recoverable work or resume a budget-exhausted run
         * @description `requeue` re-arms a poison or recoverable outbox item; execution still revalidates the
         *     proposal and reconciles the provider, so a completed credit is never repeated. `resume`
         *     continues a budget-exhausted run from its persisted state with an explicit, recorded
         *     allowance (at most 2 grants per run, each no larger than the base limits); usage history is
         *     preserved and never reset. Recovery cannot approve, reject or create credits.
         *
         *     A resume queues the run again, so it needs one of the tenant's concurrent-run slots; when
         *     none is free the answer is 429 `tenant_concurrency_limit` and nothing is recorded.
         *
         *     `allowance` is required for `resume` and not allowed for `requeue`; otherwise the answer is
         *     a `400` with the field error `allowance_required` or `allowance_not_applicable` at
         *     `/allowance`. A refusal that depends on the item is `409`: `recovery_not_applicable` (the
         *     item is not in a state this action recovers), `resume_grants_exhausted`,
         *     `allowance_does_not_cover_stop` (the allowance does not raise the limit the run stopped at)
         *     or `concurrent_update` (read the item and retry). Recovery acts on the state the item is in
         *     now, so a repeated request is refused with `recovery_not_applicable` once the first one
         *     has taken effect.
         */
        post: operations["recoverWorkItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description Lowercase identifier without `/ \ ? */
        Id: string;
        /** @description Deterministic case id derived from the idempotency scope. */
        CaseId: string;
        /** @description `run-<revision>`, unique within a case. */
        RunId: string;
        /** @description `<caseId>~<document id>`. */
        WorkId: string;
        /** Format: date-time */
        Timestamp: string;
        /**
         * @example {
         *       "amountMinor": 4900,
         *       "currency": "USD"
         *     }
         */
        Money: {
            /** @description Amount in minor units (cents). */
            amountMinor: number;
            /** @enum {string} */
            currency: "USD" | "EUR";
        };
        Health: {
            /** @enum {string} */
            status: "ok" | "unavailable";
        };
        /** @enum {string} */
        Role: "Representative" | "Approver" | "Operator";
        Session: {
            principal: {
                /** @description Entra object id of the caller. */
                principalId: string;
                tenantId: components["schemas"]["Id"];
                roles: components["schemas"]["Role"][];
            };
            environment: {
                /**
                 * @description `demo` is the deterministic investigator; `live` calls a real model. Live never falls back to demo.
                 * @enum {string}
                 */
                agentMode: "demo" | "live";
                liveAvailable: boolean;
                liveBlockedReason: string | null;
                /** @constant */
                simulatedCredits: true;
                apiVersion: string;
            };
        };
        Problem: {
            type: string;
            title: string;
            status: number;
            detail?: string;
            code: string;
            correlationId: string;
            retryAfterSeconds?: number;
            errors?: components["schemas"]["FieldError"][];
        };
        FieldError: {
            pointer: string;
            code: string;
            message: string;
        };
        /** @enum {string} */
        CaseCategory: "duplicate_charge" | "incorrect_amount" | "service_outage" | "other";
        /**
         * @description `queued` and `investigating` are active; `awaiting_approval` holds no compute;
         *     `finding_reported` means evidence was missing or contradictory and no credit was proposed;
         *     `approved` means execution is queued; `needs_attention` means failed, poison or
         *     budget-exhausted work that an operator must recover. `expired` is reported when the
         *     pending proposal passed its approval expiry.
         * @enum {string}
         */
        CaseStatus: "queued" | "investigating" | "awaiting_approval" | "finding_reported" | "approved" | "credited" | "rejected" | "expired" | "needs_attention";
        CreateCaseRequest: {
            accountId: components["schemas"]["Id"];
            invoiceIds?: components["schemas"]["Id"][];
            category: components["schemas"]["CaseCategory"];
            requestedCredit?: components["schemas"]["Money"];
            /** @description Untrusted free text. It is never executed or followed as an instruction. */
            description: string;
        };
        Actor: {
            /** @enum {string} */
            type: "user" | "agent" | "system";
            id: string;
        };
        ProposalBrief: {
            version: number;
            kind: components["schemas"]["ProposalKind"];
            status: components["schemas"]["ProposalStatus"];
            amount: components["schemas"]["Money"] | null;
            approvalExpiresAt: components["schemas"]["Timestamp"] | null;
        };
        CaseSummary: {
            caseId: components["schemas"]["CaseId"];
            tenantId: components["schemas"]["Id"];
            status: components["schemas"]["CaseStatus"];
            category: components["schemas"]["CaseCategory"];
            accountId: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            createdBy: components["schemas"]["Actor"];
            /** @description Number of runs so far. */
            revision: number;
            latestProposal: components["schemas"]["ProposalBrief"] | null;
        };
        CaseDetail: {
            caseId: components["schemas"]["CaseId"];
            tenantId: components["schemas"]["Id"];
            status: components["schemas"]["CaseStatus"];
            category: components["schemas"]["CaseCategory"];
            accountId: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            createdBy: components["schemas"]["Actor"];
            /** @description Number of runs so far. */
            revision: number;
            latestProposal: components["schemas"]["ProposalBrief"] | null;
            description: string;
            invoiceIds: components["schemas"]["Id"][];
            requestedCredit: components["schemas"]["Money"] | null;
            latestRun: components["schemas"]["Run"] | null;
            creditResult: components["schemas"]["CreditResult"] | null;
        };
        CaseAccepted: {
            case: components["schemas"]["CaseSummary"];
            runId: components["schemas"]["RunId"];
            /** @description True when this is a replay of an earlier identical request. */
            replayed: boolean;
        };
        CasePage: {
            items: components["schemas"]["CaseSummary"][];
            continuationToken: string | null;
        };
        /** @enum {string} */
        RunState: "queued" | "running" | "completed" | "failed" | "budget_exhausted" | "blocked";
        /**
         * @description `unknown` is not zero. `not_applicable` is used by the deterministic demo investigator.
         * @enum {string}
         */
        UsageQuality: "measured" | "estimated" | "unknown" | "not_applicable";
        UsageSummary: {
            steps: number;
            toolCalls: number;
            modelCalls: number;
            retries: number;
            failedCalls: number;
            ambiguousCalls: number;
            inputTokens: number | null;
            outputTokens: number | null;
            tokenQuality: components["schemas"]["UsageQuality"];
            costMicroUsd: number | null;
            costQuality: components["schemas"]["UsageQuality"];
            activeMs: number;
        };
        RunLimits: {
            steps: number;
            toolCalls: number;
            modelCalls: number;
            tokens: number;
            costMicroUsd: number;
            retriesPerCall: number;
            retriesPerRun: number;
            activeMs: number;
        };
        Run: {
            runId: components["schemas"]["RunId"];
            caseId: components["schemas"]["CaseId"];
            revision: number;
            /** @enum {string} */
            mode: "demo" | "live";
            state: components["schemas"]["RunState"];
            /**
             * @description Open set. A stable code that says why the run did not complete; null while it has not stopped.
             *     Known values: active_time_exhausted, steps_exhausted, tool_calls_exhausted, model_calls_exhausted,
             *     tokens_exhausted, cost_exhausted, tenant_cost_exhausted, retries_per_call_exhausted,
             *     retries_exhausted, tool_error, account_unavailable, policy_unavailable, no_proposal_submitted,
             *     live_not_approved, live_not_configured, model_auth_failed, model_unauthorized, model_bad_request,
             *     model_rate_limited, model_unavailable, model_timeout, model_connection_failed,
             *     model_response_invalid, model_client_error, model_invalid_tool_calls, model_turn_limit,
             *     model_refused, model_content_filtered, model_output_truncated, model_after_submission.
             *     Clients must tolerate unknown values.
             */
            stopReason: string | null;
            createdAt: components["schemas"]["Timestamp"];
            /** Format: date-time */
            startedAt: string | null;
            /** Format: date-time */
            finishedAt: string | null;
            usage: components["schemas"]["UsageSummary"];
            limits: components["schemas"]["RunLimits"];
            allowanceGrants: number;
        };
        RunList: {
            items: components["schemas"]["Run"][];
        };
        UsageEvent: {
            eventId: string;
            runId: components["schemas"]["RunId"];
            seq: number;
            /** @enum {string} */
            kind: "tool" | "model";
            name: string;
            /**
             * @description reserved while the call is in flight; the event is then updated in place with the call outcome.
             * @enum {string}
             */
            outcome: "reserved" | "succeeded" | "failed" | "ambiguous" | "rejected_by_code";
            attempt: number;
            at: components["schemas"]["Timestamp"];
            inputTokens: number | null;
            outputTokens: number | null;
            tokenQuality: components["schemas"]["UsageQuality"];
            costMicroUsd: number | null;
            costQuality: components["schemas"]["UsageQuality"];
            latencyMs: number | null;
            errorCode: string | null;
        };
        UsageEventPage: {
            items: components["schemas"]["UsageEvent"][];
            continuationToken: string | null;
        };
        TimelineItem: {
            seq: number;
            at: components["schemas"]["Timestamp"];
            /**
             * @description Open set. Known values: case_created, run_queued, run_started, tool_called, model_called,
             *     proposal_submitted, finding_recorded, proposal_rejected_by_code, decision_approved,
             *     decision_rejected, revision_requested, execution_queued, credit_executed,
             *     credit_reconciled, run_failed, run_blocked, run_restarted, run_budget_exhausted, run_resumed,
             *     work_poisoned, work_requeued, approval_expired. Clients must tolerate unknown values.
             */
            kind: string;
            actor: components["schemas"]["Actor"];
            summary: string;
            /**
             * @description Small, kind-specific details without secrets. A reason typed by a person (a rejection,
             *     a revision or a recovery) is included as entered and is untrusted text.
             */
            data?: {
                [key: string]: string | number | boolean | null;
            };
        };
        TimelinePage: {
            items: components["schemas"]["TimelineItem"][];
            continuationToken: string | null;
        };
        Subscription: {
            subscriptionId: components["schemas"]["Id"];
            plan: string;
            /** @enum {string} */
            status: "active" | "cancelled" | "paused";
            monthlyAmount: components["schemas"]["Money"];
        };
        Account: {
            accountId: components["schemas"]["Id"];
            /** @description Fictional company name. */
            displayName: string;
            /** @enum {string} */
            currency: "USD" | "EUR";
            /** @enum {string} */
            status: "active" | "suspended" | "closed";
            subscriptions: components["schemas"]["Subscription"][];
        };
        InvoiceLine: {
            description: string;
            amount: components["schemas"]["Money"];
        };
        Payment: {
            paymentId: components["schemas"]["Id"];
            amount: components["schemas"]["Money"];
            /** @enum {string} */
            status: "succeeded" | "refunded" | "failed";
        };
        Invoice: {
            invoiceId: components["schemas"]["Id"];
            accountId: components["schemas"]["Id"];
            subscriptionId: components["schemas"]["Id"];
            number: string;
            /** Format: date */
            periodStart: string;
            /** Format: date */
            periodEnd: string;
            issuedAt: components["schemas"]["Timestamp"];
            /** @enum {string} */
            status: "paid" | "open" | "void" | "refunded";
            lines: components["schemas"]["InvoiceLine"][];
            total: components["schemas"]["Money"];
            payments: components["schemas"]["Payment"][];
        };
        InvoicePage: {
            items: components["schemas"]["Invoice"][];
            continuationToken: string | null;
        };
        PolicyClause: {
            clauseId: components["schemas"]["Id"];
            title: string;
            text: string;
            appliesTo: components["schemas"]["CaseCategory"];
            /** @description Hard cap enforced in code for credits proposed under this clause. */
            maxCreditMinor: number;
            /**
             * @description Share of the evidenced amount that is creditable under this clause, in basis points
             *     (1000 is ten percent). When absent, the whole evidenced amount is creditable. Code
             *     enforces it together with `maxCreditMinor`; `text` is the human-readable form of the rule.
             */
            creditRateBasisPoints?: number;
        };
        Policy: {
            policyId: components["schemas"]["Id"];
            version: number;
            /** @enum {string} */
            status: "effective" | "superseded";
            effectiveFrom: components["schemas"]["Timestamp"];
            /** @enum {string} */
            currency: "USD" | "EUR";
            clauses: components["schemas"]["PolicyClause"][];
        };
        PolicyList: {
            items: components["schemas"]["Policy"][];
        };
        /** @enum {string} */
        ProposalKind: "credit" | "finding";
        /**
         * @description `pending_approval` is a credit proposal waiting for an approver. `reported` is a finding:
         *     it records why no credit is proposed, needs no decision and has no approval expiry.
         *     `expired` is reported once `approvalExpiresAt` has passed without a decision.
         *     `superseded` means a later revision replaced it.
         * @enum {string}
         */
        ProposalStatus: "pending_approval" | "reported" | "approved" | "rejected" | "expired" | "executed" | "superseded";
        /** @enum {string} */
        EvidenceAssessment: "consistent" | "missing" | "contradictory";
        InvoiceRef: {
            invoiceId: components["schemas"]["Id"];
            lineIndex: number | null;
        };
        PolicyRef: {
            policyId: components["schemas"]["Id"];
            version: number;
            clauseId: components["schemas"]["Id"];
        };
        /** @enum {string} */
        FindingCode: "missing_evidence" | "contradictory_evidence" | "no_credit_due" | "exceeds_policy_limit";
        Proposal: {
            caseId: components["schemas"]["CaseId"];
            version: number;
            runId: components["schemas"]["RunId"];
            kind: components["schemas"]["ProposalKind"];
            status: components["schemas"]["ProposalStatus"];
            amount: components["schemas"]["Money"] | null;
            explanation: string;
            invoiceRefs: components["schemas"]["InvoiceRef"][];
            policyRef: components["schemas"]["PolicyRef"] | null;
            findingCode: components["schemas"]["FindingCode"] | null;
            evidenceAssessment: components["schemas"]["EvidenceAssessment"];
            /** @description SHA-256 over the canonical proposal content. Approvals are bound to it. */
            digest: string;
            createdAt: components["schemas"]["Timestamp"];
            /** Format: date-time */
            approvalExpiresAt: string | null;
            decision: components["schemas"]["Decision"] | null;
        };
        ProposalList: {
            items: components["schemas"]["Proposal"][];
        };
        ApproveRequest: {
            policyVersion: number;
            proposalDigest: string;
            comment?: string;
        };
        RejectRequest: {
            policyVersion: number;
            proposalDigest: string;
            reason: string;
        };
        Decision: {
            decisionId: string;
            caseId: components["schemas"]["CaseId"];
            proposalVersion: number;
            policyVersion: number;
            proposalDigest: string;
            /** @enum {string} */
            outcome: "approved" | "rejected";
            reason: string | null;
            decidedBy: components["schemas"]["Actor"];
            decidedAt: components["schemas"]["Timestamp"];
        };
        DecisionAccepted: {
            decision: components["schemas"]["Decision"];
            caseStatus: components["schemas"]["CaseStatus"];
        };
        RevisionRequest: {
            /** @description Untrusted free text, stored on the run and in the case timeline for reviewers. The investigating agent is not given it. */
            reason: string;
        };
        CreditResult: {
            resultId: string;
            caseId: components["schemas"]["CaseId"];
            proposalVersion: number;
            amount: components["schemas"]["Money"];
            /** @constant */
            simulated: true;
            provider: {
                name: string;
                reference: string;
                idempotencyKey: string;
                /** @description True when the provider already held the credit and the executor only acknowledged it locally. */
                reconciled: boolean;
            };
            recordedAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description `waiting` proposals awaiting a human; `failed` runs; `poison` outbox items that exhausted their
         *     attempts; `recoverable` outbox items whose claim lease expired or that never started;
         *     `budget_exhausted` runs stopped by a limit; `completed` finished outbox items.
         * @enum {string}
         */
        WorkState: "waiting" | "failed" | "poison" | "recoverable" | "budget_exhausted" | "completed";
        /** @enum {string} */
        WorkKind: "proposal_approval" | "investigation_run" | "outbox";
        /**
         * @description `attempts` counts executions. For an outbox item it is the attempts made so far; for a run
         *     it is 0 until the run starts and then one more than the resume grants it has used; for a
         *     proposal it is 0.
         */
        WorkItem: {
            workId: components["schemas"]["WorkId"];
            caseId: components["schemas"]["CaseId"];
            kind: components["schemas"]["WorkKind"];
            state: components["schemas"]["WorkState"];
            summary: string;
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            attempts: number;
            lastError: {
                code: string;
                message: string;
            } | null;
            /** Format: date-time */
            claimedUntil: string | null;
            usage: components["schemas"]["UsageSummary"] | null;
            actions: ("requeue" | "resume")[];
        };
        WorkItemPage: {
            items: components["schemas"]["WorkItem"][];
            continuationToken: string | null;
        };
        /** @description Additional allowance granted by an operator; each value is capped by the base limit. */
        Allowance: {
            steps?: number;
            toolCalls?: number;
            modelCalls?: number;
            tokens?: number;
            costMicroUsd?: number;
            activeMs?: number;
        };
        RecoverRequest: {
            /** @enum {string} */
            action: "requeue" | "resume";
            reason: string;
            allowance?: components["schemas"]["Allowance"];
        };
        /**
         * @description `state` is the state the item was in when the recovery was accepted, not the state it moves
         *     to. `grantNumber` is the resume grant that was spent, and null for a requeue.
         */
        RecoverAccepted: {
            workId: components["schemas"]["WorkId"];
            /** @enum {string} */
            action: "requeue" | "resume";
            state: components["schemas"]["WorkState"];
            grantNumber: number | null;
        };
    };
    responses: {
        /** @description The request is malformed or fails validation. */
        BadRequest: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The bearer token is missing or invalid. */
        Unauthorized: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                "WWW-Authenticate"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller lacks the required tenant role. */
        Forbidden: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The resource does not exist or belongs to another tenant. */
        NotFound: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request conflicts with the current state or a previous request. */
        Conflict: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A request with a body must declare its size in a `Content-Length` header. Chunked transfer encoding is not supported: the Azure Functions host does not pass such bodies to the app. */
        LengthRequired: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The request body exceeds 16 KiB. */
        PayloadTooLarge: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Only `application/json` is accepted. */
        UnsupportedMediaType: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A tenant admission or concurrency limit was reached. */
        TooManyRequests: {
            headers: {
                "X-Correlation-Id": components["headers"]["CorrelationId"];
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        /** @description 16-64 characters of `A-Za-z0-9._~-`. Scoped to (tenant, caller, key). */
        IdempotencyKey: string;
        Limit: number;
        /** @description Opaque cursor returned by the previous page. */
        ContinuationToken: string;
        CaseId: components["schemas"]["CaseId"];
        RunId: components["schemas"]["RunId"];
        ProposalVersion: number;
        AccountId: components["schemas"]["Id"];
        InvoiceId: components["schemas"]["Id"];
        PolicyId: components["schemas"]["Id"];
        PolicyVersion: number;
        WorkId: components["schemas"]["WorkId"];
    };
    requestBodies: never;
    headers: {
        /** @description Correlation id of the request; also present in diagnostics. */
        CorrelationId: string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The host is running. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    getReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dependencies are reachable. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            400: components["responses"]["BadRequest"];
            /** @description A dependency is unavailable. */
            503: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The validated principal and the active runtime modes. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    listCases: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                /** @description Opaque cursor returned by the previous page. */
                continuationToken?: components["parameters"]["ContinuationToken"];
                status?: components["schemas"]["CaseStatus"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of cases. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CasePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    createCase: {
        parameters: {
            query?: never;
            header: {
                /** @description 16-64 characters of `A-Za-z0-9._~-`. Scoped to (tenant, caller, key). */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateCaseRequest"];
            };
        };
        responses: {
            /** @description Accepted. The investigation is queued and will run asynchronously. */
            202: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    /** @description URL of the new case. */
                    Location?: string;
                    /** @description Suggested polling interval in seconds. */
                    "Retry-After"?: number;
                    /** @description `true` when this response replays an earlier identical request. */
                    "Idempotency-Replayed"?: "true" | "false";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CaseAccepted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            411: components["responses"]["LengthRequired"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The case. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CaseDetail"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getCaseTimeline: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Opaque cursor returned by the previous page. */
                continuationToken?: components["parameters"]["ContinuationToken"];
            };
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of timeline items ordered by `seq`. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TimelinePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listInvestigationRuns: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All runs of the case (at most one per revision). */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getInvestigationRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The run. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Run"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listRunUsageEvents: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                /** @description Opaque cursor returned by the previous page. */
                continuationToken?: components["parameters"]["ContinuationToken"];
            };
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description One page of usage events ordered by `seq`. A call is recorded as `reserved` before it starts
             *     and the same event (same `eventId` and `seq`) is updated in place when the call settles, so an
             *     event that was read while `reserved` must be read again to see its outcome.
             */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UsageEventPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listProposals: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All proposal versions, oldest first. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProposalList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getProposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The proposal. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Proposal"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    approveProposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApproveRequest"];
            };
        };
        responses: {
            /** @description Approved. Execution is queued. */
            202: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    /** @description URL of the case. */
                    Location?: string;
                    /** @description Suggested polling interval in seconds. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecisionAccepted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            411: components["responses"]["LengthRequired"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
        };
    };
    rejectProposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
                version: components["parameters"]["ProposalVersion"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RejectRequest"];
            };
        };
        responses: {
            /** @description Rejected. The reason is recorded; a revision needs fresh approval. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Decision"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            411: components["responses"]["LengthRequired"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
        };
    };
    requestRevision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RevisionRequest"];
            };
        };
        responses: {
            /** @description Accepted. The revision run is queued. */
            202: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    /** @description URL of the new run. */
                    Location?: string;
                    /** @description Suggested polling interval in seconds. */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Run"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            411: components["responses"]["LengthRequired"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getCreditResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                caseId: components["parameters"]["CaseId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The credit result. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreditResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                accountId: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The account. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Account"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listInvoices: {
        parameters: {
            query?: {
                limit?: components["parameters"]["Limit"];
                /** @description Opaque cursor returned by the previous page. */
                continuationToken?: components["parameters"]["ContinuationToken"];
            };
            header?: never;
            path: {
                accountId: components["parameters"]["AccountId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of invoices. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvoicePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getInvoice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoiceId: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The invoice. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Invoice"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listPolicies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All policy versions of the tenant. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    getPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                policyId: components["parameters"]["PolicyId"];
                policyVersion: components["parameters"]["PolicyVersion"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The policy version. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Policy"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listOperatorWork: {
        parameters: {
            query: {
                state: components["schemas"]["WorkState"];
                limit?: components["parameters"]["Limit"];
                /** @description Opaque cursor returned by the previous page. */
                continuationToken?: components["parameters"]["ContinuationToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of work items of the operator's tenant. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    getOperatorWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workId: components["parameters"]["WorkId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The work item. */
            200: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItem"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    recoverWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workId: components["parameters"]["WorkId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecoverRequest"];
            };
        };
        responses: {
            /** @description Recovery accepted and recorded. */
            202: {
                headers: {
                    "X-Correlation-Id": components["headers"]["CorrelationId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecoverAccepted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            411: components["responses"]["LengthRequired"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
            429: components["responses"]["TooManyRequests"];
        };
    };
}
