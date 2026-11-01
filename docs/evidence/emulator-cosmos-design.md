# Cosmos DB design evidence (Linux emulator, Node 24)

> Emulator evidence only. All identifiers are fictional. Request charges are the emulator's reported values and are not Azure billing measurements.

Case `case_a353fb590c958afa696eac4b9dc63e00`, tenant `aurora`. Hierarchical partition key of `cases` is `[/tenantId, /caseId]`.

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
  "caseId": "case_a353fb590c958afa696eac4b9dc63e00",
  "type": "case",
  "schemaVersion": 1,
  "sortKey": "2026-11-01T23:10:11.261Z~case_a353fb590c958afa696eac4b9dc63e00",
  "status": "credited",
  "category": "duplicate_charge",
  "accountId": "acct_aurora_0001",
  "createdAt": "2026-11-01T23:10:11.261Z",
  "updatedAt": "2026-11-01T23:10:16.692Z",
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
    "approvalExpiresAt": "2026-11-04T23:10:15.960Z"
  },
  "nextSeq": 12,
  "_etag": "\"52bd985c-a082-4ecd-8f06-3856271290ca\"",
  "_ts": 1793574616
}
```

Stored proposal document:

```json
{
  "id": "proposal-1",
  "tenantId": "aurora",
  "caseId": "case_a353fb590c958afa696eac4b9dc63e00",
  "type": "proposal",
  "schemaVersion": 1,
  "workKey": "2026-11-01T23:10:15.960Z~case_a353fb590c958afa696eac4b9dc63e00~proposal-1",
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
  "digest": "sha256:9fbdd94ab784f3ef245238608f13c683fdc031f6a0e91a92f6494b73669de653",
  "createdAt": "2026-11-01T23:10:15.960Z",
  "approvalExpiresAt": "2026-11-04T23:10:15.960Z",
  "decision": {
    "decisionId": "decision-case_a353fb590c958afa696eac4b9dc63e00-v1",
    "caseId": "case_a353fb590c958afa696eac4b9dc63e00",
    "proposalVersion": 1,
    "policyVersion": 2,
    "proposalDigest": "sha256:9fbdd94ab784f3ef245238608f13c683fdc031f6a0e91a92f6494b73669de653",
    "outcome": "approved",
    "reason": null,
    "decidedBy": {
      "type": "user",
      "id": "363e1dc9-3077-4415-8ec5-2300835432d1"
    },
    "decidedAt": "2026-11-01T23:10:16.272Z"
  },
  "_etag": "\"0bdcfd44-e492-4f2a-8294-0aab42f7370a\"",
  "_ts": 1793574616
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
  "caseId": "case_a353fb590c958afa696eac4b9dc63e00",
  "type": "outbox",
  "schemaVersion": 1,
  "workKey": "2026-11-01T23:10:16.272Z~case_a353fb590c958afa696eac4b9dc63e00~out-credit-execute-v1",
  "kind": "credit.execute",
  "state": "completed",
  "attempts": 1,
  "maxAttempts": 5,
  "notBefore": "2026-11-01T23:10:16.272Z",
  "claimedUntil": null,
  "claimedBy": null,
  "payload": {
    "proposalVersion": 1,
    "digest": "sha256:9fbdd94ab784f3ef245238608f13c683fdc031f6a0e91a92f6494b73669de653"
  },
  "createdAt": "2026-11-01T23:10:16.272Z",
  "updatedAt": "2026-11-01T23:10:16.692Z",
  "completedAt": "2026-11-01T23:10:16.692Z",
  "lastError": null,
  "_etag": "\"22d529ff-507e-4e7e-93b2-757d3ae6671a\"",
  "_ts": 1793574616
}
```

## Tenant listing (`WHERE c.tenantId = @tenantId`, no partition key option, `TOP @n`)

1.00 RU for 5 cases, newest first, with no cross-tenant read.

## Conditional write and create-only deduplication

- Replace with a stale ETag (`IfMatch`): HTTP 412.
- Second create of the existing provider key: HTTP 409.

## Eight concurrent identical approvals

HTTP statuses returned (sorted): 202, 202, 202, 202, 202, 202, 202, 202.
Provider ledger records for the case: **1** (key `credit-case_a353fb590c958afa696eac4b9dc63e00-v1`, reference `sim-85265d1cd21c9ef0`).
Credit result: 4900 minor units USD, reconciled=false.

Provider ledger document:

```json
{
  "id": "credit-case_a353fb590c958afa696eac4b9dc63e00-v1",
  "tenantId": "aurora",
  "type": "provider_credit",
  "schemaVersion": 1,
  "caseId": "case_a353fb590c958afa696eac4b9dc63e00",
  "amount": {
    "amountMinor": 4900,
    "currency": "USD"
  },
  "reference": "sim-85265d1cd21c9ef0",
  "createdAt": "2026-11-01T23:10:16.677Z",
  "_etag": "\"945fbab5-6176-43b0-b4f2-0dc1b4dea451\"",
  "_ts": 1793574616
}
```

## Change feed leases

The `leases` container holds 2 lease document(s) (ids: 127.0.0.1_MDAwMg==_MDAwMg==..0, 127.0.0.1_MDAwMg==_MDAwMg==.info).

