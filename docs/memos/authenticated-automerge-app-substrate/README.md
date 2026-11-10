# Authenticated Automerge infrastructure for applications

**Status:** infrastructure research. [Pages](../../../apps/pages/pages/README.md) is the
product built on it; start there for the editor, model, agent tools and
deployment. Production notebook adoption is undecided.

The goal: let another application reuse document loading, sync, persistence,
presence and authenticated attribution without rebuilding the notebook room
host.

| Today | Where |
| --- | --- |
| Pages syncs with plain Automerge sync through its own `AutomergeSyncBackend` | [apps/pages/UPSTREAM.md](../../../apps/pages/UPSTREAM.md) |
| Pinned Repo 3 package and its source-hash-checked patches | [apps/pages/README.md](../../../apps/pages/README.md) |
| Pages direction: destination, order of work, target rules | [apps/pages/pages/DIRECTION.md](../../../apps/pages/pages/DIRECTION.md) |
| Unmet infrastructure promotion gates | [celld memo](../celld-hosted-room-substrate.md) |
| What applications may store and edit | [Extensible document contracts](../extensible-automerge-document-contracts.md) |
| October 2026 Repo 3 and Subduction evaluation | [archive/subduction-evaluation-2026-10.md](archive/subduction-evaluation-2026-10.md) |

The two sections below are the adoption requirements that still apply to any
application, notebooks included.

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
