# Authenticated Automerge infrastructure for applications

**Status:** Research with an actively maintained application experiment.
[Pages](experiment/pages/README.md) exercises the editor and authenticated backend
in a separately deployable celld service. Its README describes current behavior,
development, testing, and deployment. Production notebook adoption remains
undecided.

We want another application to reuse document loading, synchronization,
persistence, presence, and authenticated attribution without rebuilding our
notebook room host. The initial integration fixture connected upstream Automerge
infrastructure to our OIDC and API-key authority. Pages extends that work into an
application where we can test which existing mechanisms it can replace.

This memo preserves the original source evaluation and notebook-adoption
questions. The [maintained integration fixture](experiment/README.md) and
[upstream provenance](experiment/UPSTREAM.md) describe the current pinned
dependencies and adapter changes. Pages is a consumer of the shared
infrastructure. [Extensible document contracts](../extensible-automerge-document-contracts.md)
describes the separate question of what applications may store and edit.

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

## The boundary we add

OIDC sessions and API keys should pass through the same account and resource
authorization model. Credential verification establishes a principal and
provider capability bounds. The host's grant determines document access.
The spike deliberately uses issuer/endpoint-qualified namespace defaults rather
than production's OIDC/API-key fallback mapping. Existing ACL principal strings
need explicit compatibility mapping before adoption. Neither a document URL, an
email/display name, a client-supplied driver label,
nor a valid signing key alone grants access. This follows the existing
[identity](../../adr/identity-and-trust.md),
[credential transport](../../adr/hosted-credential-transport.md), and
[room authorization](../../adr/hosted-room-authorization.md) contracts.

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
daemon's [acknowledged-head recovery contract](../../adr/automerge-document-storage.md),
and document the exact guarantee of each hosted adapter separately. The existing
`automerge-store` contract is a useful reference; its presence is not proof that
production room paths already use that implementation.

## Preserve editor change streams

Change illumination is an adoption requirement. Incoming agent edits often arrive
as a large tool operation; readers need to see which text changed and who drove
it while continuing to type. RxJS can remain the observation layer with either
engine. The contract underneath it needs qualification before replacing our
Rust/WASM observer.

Today, runtimed WASM derives ordered text patches and structural changes from one
Automerge diff. The RxJS sync engine emits attribution events before coalescing
materialization work. The editor applies the text first, then decorates inserted
ranges and maps those ranges through later edits. Preserve that ordering and the
separation between precise text events and coalesced cell invalidations. Current
attribution attaches the incoming batch's actor set to each patch. That is
sufficient for this visual affordance; exact per-range or per-character
authorship in mixed-author batches is not an adoption requirement.

Pinned Repo 3 supplies patches and before/after documents, but
[Document.applyMutation](https://github.com/automerge/automerge-repo/blob/afec0444191a5a662e065f24193bef58ab07122a/packages/automerge-repo/src/Document.ts#L87-L115)
labels both local and incoming events with source "change". Its change payload
has no per-patch actor or authenticated principal. A disposable two-peer probe
confirmed narrow UTF-16 patches from updateText, identical local/remote source
labels, and an aggregate event for multiple actors. A batch with no net visible
change advanced heads without a change event. Thus visible patches alone are
neither an operation log nor authenticated attribution.

Bulk text APIs must preserve the existing collaborative text object. Use
[splice or updateText](https://automerge.org/docs/reference/documents/text/), as
our existing splice_source/update_source paths do. In the probe, assigning a new
string recreated the whole text, whereas updateText preserved narrow edits. A
snapshot diff cannot recover discarded CRDT identity or prove authorship; large
text diffs also need concurrent-edit testing rather than an assumption that they
preserve user intent.

For notebook adoption, an editor fixture must demonstrate:

- An agent changes a paragraph while a human types elsewhere: only affected
  surviving text is illuminated, with stable selection and undo behavior.
- Ordered patches use explicit UTF-16 coordinates, including emoji, combining
  text, insertion/deletion pairs, and range remapping through subsequent edits.
- Local echoes, initial load, live remote edits, and reconnect catch-up follow
  deliberate display rules. Observation preserves causal frontiers even when no
  visible patch exists; coalescing must not silently erase required edit events.
- Account and driver labels come from trusted identity context. Batch-level
  attribution is sufficient for illumination; a mixed-author batch may use a
  combined or neutral visual cue. Authorization is enforced independently.

Keep the existing Rust/WASM and RxJS/editor path as the baseline. Full Repo
adoption would need an explicit event adapter; reuse of only the lower backend
would need record import/export compatibility with our WASM, including history
fragments. Neither path is qualified yet. Avoid maintaining a second materialized
document solely to reconstruct observations we already have.

## Initial integration evidence

The initial [integration fixture](experiment/README.md) established that published
Subduction 0.23.0 already had the policy interfaces: the tested Repo adapter patch
forwarded `policy` and `ephemeralPolicy` without changing WASM or the wire protocol. This
qualified the integration seam, not a production service. The table below records
that initial evidence; it is not the current Pages qualification checklist. See
[UPSTREAM.md](experiment/UPSTREAM.md) for the maintained adapter tests and
[Pages](experiment/pages/README.md) for application qualification.

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
