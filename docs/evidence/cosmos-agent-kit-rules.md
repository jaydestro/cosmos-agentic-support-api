# Cosmos DB Agent Kit rules: what was actually used

Source of the rules: `AzureCosmosDB/cosmosdb-agent-kit`, `skills/cosmosdb-best-practices` (global copy at
`~/.agents/skills/cosmosdb-best-practices/`, folder hash `811c5176d61977eda86671be5e82409763dcecd3`, MIT,
142 rule files). The skill is **not** copied under `.github/skills/` (a recorded deviation, see README).
A rule is listed only if its file was opened and a decision in this repository was checked against it.
Where a rule and the product requirements or the real service disagreed, the outcome is stated.

| Rule | Where it applies in Resolve | Outcome |
|---|---|---|
| `partition-hierarchical` | `cases` uses `[/tenantId, /caseId]`; one case is one logical partition, so a single-partition batch holds the decision, state change, timeline item and outbox item | Followed. **Gap found:** the rule shows .NET and Python only. With JS SDK 4.10.1 a prefix key in `{ partitionKey: ['aurora'] }` works on the emulator but the Azure service answers HTTP 400. Tenant listings now filter `c.tenantId = @tenantId` and pass no partition key option (2.96 RU on Azure). Proven in [azure-proof.md](azure-proof.md). |
| `query-point-reads` | `case`, `proposal-N`, outbox, idempotency and credit-result lookups are `item(id, pk).read()` | Followed. 1.00 RU per point read on both the emulator and Azure. |
| `query-parameterize` | Every query uses `@parameters`; `TOP @n` is parameterized | Followed. |
| `sdk-etag-concurrency` | Proposal decisions, case state, outbox claims and admission counters are replaced with `IfMatch` | Followed. Stale ETag answers 412 on the emulator and on Azure. |
| `sdk-conditional-create-etag` | Create-only deduplication: idempotency records and provider credits are created, never upserted | Followed through HTTP 409 on a second create (emulator and Azure). |
| `throughput-serverless` | One account with the `EnableServerless` capability; no throughput on any database or container, including `leases` | Followed (the rule says "dev/test"; the project requirement makes it the sample's hosting model). |
| `security-managed-identity` | Application and seeder authenticate with user-assigned managed identities; local auth is disabled on the account | Followed. The code uses `ManagedIdentityCredential` with an explicit client id on Azure rather than `DefaultAzureCredential`, to avoid probing other credential sources. |
| `security-rbac-least-privilege` | Five custom native data-plane roles, each assigned to one container | Followed. Real denials: seeder reading `cases`/`provider` and app writing `reference` or deleting provider records all answer 403. |
| `security-network-restrict` | Public network access disabled on the account | Followed. A valid Entra token from outside the network gets 403. |
| `security-private-endpoint-dns` | Private endpoint, `privatelink.documents.azure.com` zone and a VNet link | Followed. From inside the VNet the account resolves to `10.42.2.4`; from outside it resolves to a public address that the firewall refuses. |
| `monitoring-ru-consumption` | Request charges are recorded per request and measured per call in the proofs | Followed for per-call RU. Idle change-feed polling is visible in the account metrics and is a real cost driver (see the Azure proof). |
| `sdk-emulator-ssl`, `tooling-emulator-setup` | Linux emulator in a container with certificate trust | Followed except the rule's `NODE_TLS_REJECT_UNAUTHORIZED=0` suggestion, which the project forbids. |
| `query-pagination` | Keyset cursors (`sortKey` / `workKey`) | Deviated on purpose: the emulator ignores `maxItemCount` with `ORDER BY`. |
| `index-composite`, `index-exclude-unused`, `index-path-syntax` | `infra/containers.json` excludes bulky text and snapshot paths | Followed. |
| `model-type-discriminator`, `model-schema-versioning`, `model-id-constraints` | Every document carries `type` and `schemaVersion` | Followed. |
| `sdk-retry-429` | One client per process with bounded retries; a throttled request becomes 503 with `Retry-After` | Followed. |
| `query-avoid-cross-partition` | Case queries pass the full `[tenantId, caseId]` key | Followed; tenant listings are the one deliberate fan-out, bounded by the `tenantId` filter. |
| `partition-20gb-limit` | Case aggregates are bounded per case | Followed. |

Not applicable and not used: the change-feed materialized-view pattern (the trigger executes outbox
work, it does not build views) and the LangChain/LangGraph checkpoint rules.
