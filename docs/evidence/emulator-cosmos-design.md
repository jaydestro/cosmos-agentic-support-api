# Cosmos DB design evidence (Linux emulator, Node 24)

> Emulator evidence only. All identifiers are fictional. Request charges are the emulator's reported values and are not Azure billing measurements.

Case `case_145bf52b15af7d62565ce31139f77180`, tenant `aurora`. Hierarchical partition key of `cases` is `[/tenantId, /caseId]`.

## Documents in the case partition

| type | count |
|---|---|
| case | 1 |
| credit_result | 1 |
| idempotency | 1 |
| outbox | 2 |
| proposal | 1 |
| run | 1 |
| timeline | 11 |
| usage | 5 |

Partition-scoped parameterized query (`WHERE c.type != @none`, partition key `[tenant, case]`): 1.00 RU, 23 documents.

## Point reads (id + partition key, no query)

| read | RU |
|---|---|
| case | 1.00 |
| proposal-1 | 1.00 |
| out-credit-execute-v1 | 1.00 |

Stored case document:

```json
{
  "id": "case",
  "tenantId": "aurora",
  "caseId": "case_145bf52b15af7d62565ce31139f77180",
  "type": "case",
  "schemaVersion": 1,
  "sortKey": "2026-11-01T21:35:31.787Z~case_145bf52b15af7d62565ce31139f77180",
  "status": "credited",
  "category": "duplicate_charge",
  "accountId": "acct_aurora_0001",
  "createdAt": "2026-11-01T21:35:31.787Z",
  "updatedAt": "2026-11-01T21:35:33.221Z",
  "createdBy": {
    "type": "user",
    "id": "211820aa-05ab-41ed-89e5-11232c6ee0c7"
  },
  "revision": 1,
  "description": "The same invoice appears to have been charged twice this month.",
  "invoiceIds": [
    "inv_aurora_0001_a",
    "inv_aurora_0001_b"
  ],
  "requestedCredit": {
    "amountMinor": 4900,
    "currency": "USD"
  },
  "latestRunId": "run-1",
  "latestProposal": {
    "version": 1,
    "kind": "credit",
    "status": "executed",
    "amount": {
      "amountMinor": 4900,
      "currency": "USD"
    },
    "approvalExpiresAt": "2026-11-04T21:35:32.525Z"
  },
  "nextSeq": 12,
  "_etag": "\"b5d48227-2663-458b-a02a-ae9f0894894a\"",
  "_ts": 1793568931
}
```

Stored proposal document:

```json
{
  "id": "proposal-1",
  "tenantId": "aurora",
  "caseId": "case_145bf52b15af7d62565ce31139f77180",
  "type": "proposal",
  "schemaVersion": 1,
  "workKey": "2026-11-01T21:35:32.525Z~case_145bf52b15af7d62565ce31139f77180~proposal-1",
  "version": 1,
  "runId": "run-1",
  "kind": "credit",
  "status": "executed",
  "amount": {
    "amountMinor": 4900,
    "currency": "USD"
  },
  "explanation": "Policy credit-policy v2, clause dup-charge. Invoices inv_aurora_0001_a, inv_aurora_0001_b cover 2026-09-01 to 2026-09-30 on sub_aurora_0001 for USD 49.00 each and were all collected. inv_aurora_0001_a was issued first; inv_aurora_0001_b is the duplicate. Creditable under the clause: USD 49.00. Policy limit: USD 250.00. Requested: USD 49.00. Proposed credit: USD 49.00.",
  "invoiceRefs": [
    {
      "invoiceId": "inv_aurora_0001_a",
      "lineIndex": null
    },
    {
      "invoiceId": "inv_aurora_0001_b",
      "lineIndex": null
    }
  ],
  "policyRef": {
    "policyId": "credit-policy",
    "version": 2,
    "clauseId": "dup-charge"
  },
  "findingCode": null,
  "evidenceAssessment": "consistent",
  "digest": "sha256:42a9e17ac0f4b877699606686aa99af29ab2f989795a950f468a7b7e61d4b6b3",
  "createdAt": "2026-11-01T21:35:32.525Z",
  "approvalExpiresAt": "2026-11-04T21:35:32.525Z",
  "decision": {
    "decisionId": "decision-case_145bf52b15af7d62565ce31139f77180-v1",
    "caseId": "case_145bf52b15af7d62565ce31139f77180",
    "proposalVersion": 1,
    "policyVersion": 2,
    "proposalDigest": "sha256:42a9e17ac0f4b877699606686aa99af29ab2f989795a950f468a7b7e61d4b6b3",
    "outcome": "approved",
    "reason": null,
    "decidedBy": {
      "type": "user",
      "id": "363e1dc9-3077-4415-8ec5-2300835432d1"
    },
    "decidedAt": "2026-11-01T21:35:33.107Z"
  },
  "_etag": "\"84befe1a-c00d-4cfd-9c11-4b4de4328efb\"",
  "_ts": 1793568931
}
```

The decision (outcome, proposal/policy version, digest, approver) is embedded in the proposal document above; the proposal replace, case state change, timeline item and outbox item are written in one single-partition transactional batch.

Outbox items of the case (partition-scoped query):

```json
[
  {
    "id": "out-investigation-start-run-1",
    "state": "completed",
    "attempts": 1
  },
  {
    "id": "out-credit-execute-v1",
    "state": "completed",
    "attempts": 1
  }
]
```

Outbox query: 1.00 RU.

Outbox document after the change-feed trigger ran:

```json
{
  "id": "out-credit-execute-v1",
  "tenantId": "aurora",
  "caseId": "case_145bf52b15af7d62565ce31139f77180",
  "type": "outbox",
  "schemaVersion": 1,
  "workKey": "2026-11-01T21:35:33.107Z~case_145bf52b15af7d62565ce31139f77180~out-credit-execute-v1",
  "kind": "credit.execute",
  "state": "completed",
  "attempts": 1,
  "maxAttempts": 5,
  "notBefore": "2026-11-01T21:35:33.107Z",
  "claimedUntil": null,
  "claimedBy": null,
  "payload": {
    "proposalVersion": 1,
    "digest": "sha256:42a9e17ac0f4b877699606686aa99af29ab2f989795a950f468a7b7e61d4b6b3"
  },
  "createdAt": "2026-11-01T21:35:33.107Z",
  "updatedAt": "2026-11-01T21:35:33.221Z",
  "completedAt": "2026-11-01T21:35:33.221Z",
  "lastError": null,
  "_etag": "\"d1e1a867-f0ef-4873-a177-8183d973f95f\"",
  "_ts": 1793568931
}
```

## Tenant listing (hierarchical prefix partition key `[tenantId]`, `TOP @n`)

1.00 RU for 1 cases, newest first, with no cross-tenant read.

## Conditional write and create-only deduplication

- Replace with a stale ETag (`IfMatch`): HTTP 412.
- Second create of the existing provider key: HTTP 409.

## Eight concurrent identical approvals

HTTP statuses returned (sorted): 202, 202, 202, 202, 202, 202, 202, 202.
Provider ledger records for the case: **1** (key `credit-case_145bf52b15af7d62565ce31139f77180-v1`, reference `sim-2f83a041465b247f`).
Credit result: 4900 minor units USD, reconciled=false.

Provider ledger document:

```json
{
  "id": "credit-case_145bf52b15af7d62565ce31139f77180-v1",
  "tenantId": "aurora",
  "type": "provider_credit",
  "schemaVersion": 1,
  "caseId": "case_145bf52b15af7d62565ce31139f77180",
  "amount": {
    "amountMinor": 4900,
    "currency": "USD"
  },
  "reference": "sim-2f83a041465b247f",
  "createdAt": "2026-11-01T21:35:33.207Z",
  "_etag": "\"f810d93b-eea4-4d28-8927-76d462f3bf02\"",
  "_ts": 1793568931
}
```

## Change feed leases

The `leases` container holds 2 lease document(s) (ids: 127.0.0.1_MDAwMg==_MDAwMg==..0, 127.0.0.1_MDAwMg==_MDAwMg==.info).

