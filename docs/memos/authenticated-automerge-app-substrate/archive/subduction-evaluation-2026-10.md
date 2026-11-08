# Repo 3 and Subduction evaluation, October 2026

Archived 2026-11-08: superseded by docs/memos/authenticated-automerge-app-substrate/README.md and experiment/UPSTREAM.md; historical only. Pages uses plain Automerge sync, not Subduction.

## What the source evaluation established

The initial October 18, 2026 evaluation inspected pinned public sources, the
nteract checkout, and automatic captions of the
[2026 Q4 community call](https://www.youtube.com/watch?v=0rpfOFVDr7g&t=749s).
Independent Kilo Opus and Fable reports informed the evaluation; source inspection
checked their central claims. This is architectural evidence, not performance or
production qualification. Roadmap statements in the call are not release facts.

- Experimental Repo 3 moves storage and synchronization behind
  [`SedimentreeBackend`](https://github.com/automerge/automerge-repo/blob/afec0444191a5a662e065f24193bef58ab07122a/packages/automerge-repo/src/sedimentree/backend.ts).
  Its boundary uses document IDs, records, metadata, and bytes. `store` and
  `flush` describe local recoverability under the backend's guarantee. Peer heads
  and synchronization observations are explicitly not remote durable receipts;
  batches are not transactions.
- The [Repo 3 Subduction adapter](https://github.com/automerge/automerge-repo/blob/afec0444191a5a662e065f24193bef58ab07122a/packages/automerge-repo-subduction/README.md)
  uses `@automerge/subduction` 0.23.0 and **allow-all native authorization** for
  explicitly trusted peers. Its storage requires exclusive ownership and
  atomic replacement of individual records; a failed batch can be partly
  persisted and observed. It does not yet supply our application authority.
- The evaluated Subduction source has lower-level
  [storage policies](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_core/src/policy/storage.rs)
  separating fetch from put, and the requesting peer from the verified signing
  author. Its [WASM policy interface](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_wasm/src/policy.rs)
  and [ephemeral policies](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_wasm/src/policy/ephemeral.rs)
  expose authorization hooks. Newer Rust source alone does not establish the
  APIs of an older published WASM package; the initial integration fixture
  separately verified policy forwarding with published Subduction 0.23.0.
- [Patchwork's integration](https://github.com/inkandswitch/patchwork-system/blob/bd12be7c10d6145cab0888f025c09b2f291612a7/core/patchwork/src/repo.ts)
  is another useful reference, but its dependency line is Repo
  `2.6.0-subduction.48` with `@automerge/automerge-subduction` 0.16.1, not
  experimental Repo 3. Do not combine evidence from these paths as though one
  deployed stack already implements every feature.

The reviewed [Subduction revision](https://github.com/inkandswitch/subduction/tree/239c5fc125619d345be4015d186b91ac587306ad)
still warns against production use. Its native/WASM components are candidates for
reuse, not a reason to skip our admission, recovery, and compatibility checks.

## Options to test

| Option | What it could replace | Evidence still needed |
| --- | --- | --- |
| Repo 3 with an authenticated backend/adapter | Client handle lifecycle, observation, storage and sync plumbing | Compatible policy injection; admission ordering; browser/Node editor behavior; no duplicate repository beside ours |
| Native Subduction service with the same account policy | Generic relay and incremental storage machinery | Deployment and storage integration; key/account binding; client compatibility; operational cost |
| Existing room-host implementations with smaller shared helpers | Repeated auth/provenance and persistence glue | Baseline for code size, durability, and cost; whether extraction actually removes duplication |

Start with the first option. Prefer a bounded public adapter or an upstreamable
hook over a downstream engine fork. Native hosting is a follow-up if it removes
materialization or runtime constraints that the first experiment cannot.

Owning our WASM packaging does not imply changing Automerge's data format or
replacing its JavaScript document API. Build matching Rust/WASM, generated glue,
and JS bindings, then test the actual editor APIs. Merely exposing similarly
named functions is insufficient. Keep native and browser implementations aligned
through shared fixtures and interoperability tests; do not pass opaque objects
between independent WASM instances.

celld, a Durable Object, and a native relay are hosting choices. S3/R2 are storage
choices. Neither choice establishes acknowledgment semantics. Preserve the local
daemon's [acknowledged-head recovery contract](../../../adr/automerge-document-storage.md),
and document the exact guarantee of each hosted adapter separately. The existing
`automerge-store` contract is a useful reference; its presence is not proof that
production room paths already use that implementation.

## Initial integration evidence

Pages no longer uses Subduction: every Page syncs with plain Automerge sync,
and the Subduction adapter, its patches and these fixtures were removed from
the experiment. The record below is the historical evidence.

The initial integration fixture established that published
Subduction 0.23.0 already had the policy interfaces: the tested Repo adapter patch
forwarded `policy` and `ephemeralPolicy` without changing WASM or the wire protocol. This
qualified the integration seam, not a production service. The table below records
that initial evidence; it is not the current Pages qualification checklist. See
[Pages](../experiment/pages/README.md) for application qualification.

The fixture used disposable documents, pinned packages, and deterministic
credentials. Fixture tests must not be reported as live provider qualification;
browser login and live provider admission need separate evidence.

| Evidence | Initial spike result |
| --- | --- |
| None/reader/writer enforcement, cross-account denial, forged account/driver claims | Passed through real native policy and verified-identity fixtures |
| OIDC/API-key verification, key binding, expiry/revocation | Production verifiers with generated credentials passed; key revocation tested on connected peers; browser login and live provider untested |
| Relayed record authorship | Native requestor and original author differ; expired-author history rejected despite current relay authority |
| Reader presence, signed origin, revoked subscriptions | Passed with native pubsub and positive controls; multi-hop presence identity remains untested |
| Unknown-field preservation and managed-runtime rejection | Unknown content and tolerant reader fixtures passed; runtime role gate passed, actual runtime semantic validation untested |
| Storage failure, retry, restart recovery | Sustained failure, fresh-process reopen, and same-edit flush retry passed; partial batches and remote receipts remain untested |
| Attributed text streams and editor illumination | Disposable patch probe passed; event-origin and provenance gaps identified; end-to-end editor parity untested |
| Matching custom WASM/glue, browser/Node and editor interoperability | Planned; not yet run |
| Cold-load time/memory, reconnect bytes, writes and bytes per editing burst | Planned; not yet run |
| Existing machinery removed versus adapter code added | Planned; not yet run |

The test also exposes two unresolved contracts. Rejected optimistic edits remain
local, and later retries may persist them: failed flush is not rollback. A
three-peer test confirms the policy preserves the original signing author and
denies its relayed history after that author's lease expires, even when the relay
remains an authorized writer. Durable author provenance must be separate from
current-session admission before adopting this for general historical replication. Provider API-key revocation is additionally
bounded by the existing 60-second validator cache plus the admission lease.

An acceptance receipt must identify the document and accepted causal frontier,
with a documented recovery guarantee. Do not infer one from a peer-head event or
successful synchronization round. Where the application also needs operation
idempotency and provenance records, test their crash consistency with the
document write rather than assuming a batch is atomic.

Report costs using the same histories and editing workloads as the baseline,
including object counts, requests, and compaction. In-memory tests do not establish
S3/R2 durability, production performance, or a deployment bill. Adoption requires
preserved contracts and net removal of machinery. Stop or narrow the effort if
the adapter recreates the repository it was intended to replace.

Earlier [nteract #3585](https://github.com/nteract/nteract/issues/3585) already
tracked Repo/Subduction research and several storage improvements. This spike
evaluates new boundaries; it does not reopen completed work or supersede existing
ADRs without a later decision.
