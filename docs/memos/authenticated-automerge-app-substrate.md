# Authenticated Automerge infrastructure for applications

**Status:** Research proposal, 2026-10-17. The integration spike is authorized;
adoption, production deployment, and dependency changes remain undecided.

We want another application to reuse document loading, synchronization,
persistence, presence, and authenticated attribution without rebuilding our
notebook room host. The first experiment should connect upstream Automerge
infrastructure to our OIDC and API-key authority, then establish which existing
mechanisms it can replace. It should not begin by extracting another complete
repository implementation.

This work is independent of the [Pages prototype PR](https://github.com/nteract/nteract/pull/4451).
Pages is a useful consumer and comparison point, not a required dependency of
the shared infrastructure. [Extensible document contracts](extensible-automerge-document-contracts.md)
describes the separate question of what applications may store and edit.

## What the source evaluation established

The evaluation inspected pinned public sources, the nteract checkout, and
automatic captions of the [2026 Q4 community call](https://www.youtube.com/watch?v=0rpfOFVDr7g&t=749s).
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
- Current Subduction has lower-level
  [storage policies](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_core/src/policy/storage.rs)
  separating fetch from put, and the requesting peer from the verified signing
  author. Its [WASM policy interface](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_wasm/src/policy.rs)
  and [ephemeral policies](https://github.com/inkandswitch/subduction/blob/239c5fc125619d345be4015d186b91ac587306ad/subduction_wasm/src/policy/ephemeral.rs)
  expose authorization hooks. Wiring a compatible implementation through Repo
  remains work to prove; newer Rust source does not establish the APIs of an
  older published WASM package.
- [Patchwork's integration](https://github.com/inkandswitch/patchwork-system/blob/bd12be7c10d6145cab0888f025c09b2f291612a7/core/patchwork/src/repo.ts)
  is another useful reference, but its dependency line is Repo
  `2.6.0-subduction.48` with `@automerge/automerge-subduction` 0.16.1, not
  experimental Repo 3. Do not combine evidence from these paths as though one
  deployed stack already implements every feature.

The reviewed [Subduction revision](https://github.com/inkandswitch/subduction/tree/239c5fc125619d345be4015d186b91ac587306ad)
still warns against production use. Its native/WASM components are candidates for
reuse, not a reason to skip our admission, recovery, and compatibility checks.

## The boundary we add

OIDC sessions and API keys should pass through the same account and resource
authorization model. Credential verification establishes a principal and
provider capability bounds. The host's grant determines document access.
Neither a document URL, an email/display name, a client-supplied driver label,
nor a valid signing key alone grants access. This follows the existing
[identity](../adr/identity-and-trust.md),
[credential transport](../adr/hosted-credential-transport.md), and
[room authorization](../adr/hosted-room-authorization.md) contracts.

The spike needs an explicit binding between a verified principal and each
admitted signing key, with resource scope and expiry/revocation behavior.
Cryptographic proof of key possession does not itself prove an Anaconda account.
Keep the account, driver/operator, signing author, Automerge actor, and current
connection distinct. A single account may use several concurrent actors and
drivers. A signed outer record also does not automatically authenticate the
claimed actor of every inner Automerge change, especially imported history.

For ordinary collaborative documents, authorization can largely operate at the
document boundary. Managed documents still require semantic admission before
untrusted changes reach authoritative storage or fanout. A consumer-side shape
check after receipt cannot protect an earlier write. An encrypted relay cannot
inspect plaintext runtime invariants: retain a trusted validating host for those
documents or change their authorization layout deliberately.

Presence uses ephemeral transport with separately authorized subscribe, publish,
and delivery. The host projects verified account identity and the recorded
driver; untrusted contact/name fields remain display claims. Expiry and
revocation must affect existing connections and subscriptions, not only the
next handshake. Offline local edits can remain recoverable without being
accepted by a host after their author loses write permission.

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
daemon's [acknowledged-head recovery contract](../adr/automerge-document-storage.md),
and document the exact guarantee of each hosted adapter separately. The existing
`automerge-store` contract is a useful reference; its presence is not proof that
production room paths already use that implementation.

## Bounded spike and evidence

Use disposable documents and pinned packages. First exercise the policy boundary
with deterministic credential fixtures; then integrate browser OIDC and Node
API-key verification. Fixture tests must not be reported as live provider
qualification. Keep the Pages deployment and storage namespace untouched.

| Evidence | Status at proposal |
| --- | --- |
| None/reader/writer enforcement, cross-account denial, forged account/driver claims | Planned; not yet run |
| Real OIDC and API-key paths, key binding, expiry/revocation on live connections | Planned; not yet run |
| Reader presence, signed origin versus relay identity, revoked subscriptions | Planned; not yet run |
| Unknown-field preservation and managed-runtime rejection | Planned; not yet run |
| Failed storage, retry, duplicate delivery, partial batches, restart recovery | Planned; not yet run |
| Matching custom WASM/glue, browser/Node and editor interoperability | Planned; not yet run |
| Cold-load time/memory, reconnect bytes, writes and bytes per editing burst | Planned; not yet run |
| Existing machinery removed versus adapter code added | Planned; not yet run |

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
