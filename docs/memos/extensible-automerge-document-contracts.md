# Extensible Automerge document contracts

**Status:** Research proposal, 2026-10-17. No document migration or authorization
change is established by this memo.

Applications should be able to share authenticated synchronization without
sharing a universal notebook or Page schema. Typed tools can provide good editor
and agent APIs while preserving content introduced by tools they do not know.
The [infrastructure spike](authenticated-automerge-app-substrate.md) evaluates
that separation against upstream Repo 3 and Subduction.

Two questions remain independent: **who may read or write this document**, and
**which application contract applies to its contents**. A flexible content model
does not imply flexible permissions. A valid schema does not imply permission to
write it.

## What other applications provide

Patchwork's [datatype interface](https://github.com/inkandswitch/patchwork-system/blob/bd12be7c10d6145cab0888f025c09b2f291612a7/core/plugins/src/datatypes.ts)
registers initialization, title reading, and optional title writing. It adds
`@patchwork` type/tool metadata; it does not impose a universal closed set of
payload fields. Its [Markdown datatype](https://github.com/inkandswitch/patchwork-pkg-base/blob/87e36dbad77e770a4ff56a1400aebf3244e76c47/codemirror-base/src/datatype.ts)
expects `content: string`. That expectation is still a schema: a reader that
calls string methods on arbitrary data can fail.

The same environment includes [versioned tldraw migration](https://github.com/inkandswitch/patchwork-pkg-base/blob/87e36dbad77e770a4ff56a1400aebf3244e76c47/tldraw5/src/migrate.tsx).
An open infrastructure can accommodate a strongly versioned editor.
[Pushwork's shape interface](https://github.com/inkandswitch/pushwork/blob/b7b15dcc85ae3a8eb0db84d12d66b438e73d1d0c/src/shapes/types.ts)
provides a different kind of extensibility: adapters translate document layouts
to and from a filesystem view. These examples support typed adapters around shared
documents, not a claim that all adapters preserve every unknown field.

Automerge's [modeling guide](https://automerge.org/docs/cookbook/modeling-data/)
leaves structure and granularity to applications and highlights concurrent
migrations and mixed client versions. Its Cambria reference is research, not an
automatic schema-translation layer available to adopt.

## Proposed access and content profiles

Use a simple access vocabulary for generic documents, without replacing existing
notebook capabilities:

| Access | Host behavior |
| --- | --- |
| None | Deny document reads, writes, discovery and presence subscription; do not reveal private document existence through errors |
| Reader | Permit authorized reads and sync negotiation; deny durable mutations; presence publication is a separate explicit policy |
| Writer | Reader rights plus content writes admitted under the document's profile; no implied sharing administration or execution authority |

Apply grants to discovery, fetch, sync, semantic operations, and presence—not
only UI controls or initial connection setup. The host derives grants from the
verified principal, provider bounds, and resource ACL. Existing notebook
`editor`, `runtime_peer`, and `owner` roles are not a total order and must not be
collapsed into a generic writer. In particular, ownership or content editing
does not imply runtime authorship.

Separately, choose a host-controlled content profile:

| Profile | Contract |
| --- | --- |
| Generic document | Valid, authorized Automerge history within resource bounds; no universal application payload schema |
| Typed, extensible document | Known fields have usable types; unknown fields and unsupported blocks survive; readers report unsupported features |
| Managed document | Enforce protected roots, actor/provenance rules, and semantic write authority before accepting changes |

The host binds a resource to its profile. A client cannot switch a `type` field
to bypass managed-document validation. Document type hints, suggested tool URLs,
and extension metadata may remain useful inert data; executing a suggested tool
requires the host's separate registration and loading policy. ACLs and trusted
account/key bindings must not become writable extension fields.

All profiles need bounded parsing, document/frame/history sizes, and protection
against unbounded queues or extension growth. A generic relay may carry opaque
records, but must be explicit about what it validates and what only a trusted
consumer validates. Generic transport is not a promise to accept arbitrary bytes
as a valid Automerge document.

## Typed application interfaces

A document plugin can supply a reader/projection, semantic mutations, migration
rules, export behavior, and selection/anchor support. Unsupported values should
produce a placeholder or diagnostic that preserves the original data, not a
lossy projection written back as the entire document. Writers should update
known locations rather than reconstructing containers from a narrower type.

Keep agent operations precise. An extensible document does not require an
unrestricted arbitrary-path mutation tool. A plugin can advertise operations
such as inserting a block or replying to a thread, with typed arguments and
clear preconditions. A client without the plugin may still preserve or transfer
the document without claiming to understand it.

The [Pages prototype](https://github.com/nteract/nteract/pull/4451) is a candidate
for the typed, extensible profile. Its current exact root/block-key admission
and closed block-kind set are prototype policies, not a requirement of shared
sync infrastructure. Relaxing them would be a separate tested change that keeps
author and comment ownership protections. Unknown blocks must survive older
clients and export/import workflows, or the exporter must explicitly report
that its output cannot round-trip them.

NotebookDoc already has an accepted
[forward-compatibility contract](../adr/schema-evolution-and-genesis.md): frozen
genesis, additive evolution, tolerant readers, and separate documents for
structural reshaping. This proposal extends that reasoning to new applications;
it does not authorize regenerating notebook genesis or changing existing
notebook migration rules. Bare unknown cell fields survive raw Automerge
storage but not necessarily `.ipynb` export; the existing contract places
additive cell data in metadata.

## Runtime documents retain authority

The existing [document split](../adr/document-split.md) separates NotebookDoc,
RuntimeStateDoc, CommsDoc, and CommentsDoc because their authorities and lifetimes
differ. The [runtime writer proposal](runtime-writer-decomposition.md) describes
the shared Rust ingress policy already used by local and hosted paths.

Runtime peers may report lifecycle and progress/output state for accepted
executions. They may not create execution intent, rewrite accepted execution
provenance, or change coordinator-owned trust, environment, and room facts.
Ordinary content writers cannot acquire those rights by producing valid JSON or
claiming a runtime actor. Execution continues to reference a synced `cell_id`.

Keep this validation at the authority boundary before storage and publication.
An encrypted generic relay cannot enforce field-level runtime rules. Managed
documents therefore need a trusted validating host or a deliberate split into
documents with appropriate write capabilities. Consumer rendering checks are
still useful, but cannot substitute for admission.

## Comments, presence, and attribution

Patchwork's [universal comments experiment](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/11/)
separates editor-specific selections/pointers from common thread, reply, storage,
and navigation behavior. A reusable nteract layer could similarly let each
editor define anchors while sharing authenticated thread operations. This is a
design direction; the 2024 research API and current Patchwork tools are not one
stable API we can assume compatible.

Commenter-only authority cannot be enforced by an opaque document-wide writer
grant. Use an authorized CommentsDoc sidecar or trusted semantic admission for
thread operations, including reply ownership and resolution policy. Anchors need
defined behavior when their target is edited, deleted, moved, or unsupported.

Presence is ephemeral and permission-scoped. Persistent attribution is separate:
show the verified account and recorded driver, preserve independent CRDT actors,
and retain the provenance needed to explain accepted edits. A driver label is
not proof that a particular vendor authored an edit. Neither an actor label nor
a signed outer transport record alone proves the account behind every inner
change. Preserve historical actor IDs and hashes; adapt identity projections
instead of rewriting CRDT history to change display names.

## Migration and compatibility evidence

CRDT convergence does not guarantee an application's invariants. Two individually
valid edits can violate uniqueness or structural assumptions after merging.
Prefer deterministic tolerant projections for presentation rules; use explicit
authority for protected invariants. Migration must account for offline peers,
old writers, concurrent migration attempts, and retries. Never silently clamp a
newer schema version or discard unknown data merely to mount an older editor.

| Fixture | Status at proposal |
| --- | --- |
| Old/new clients edit known fields while unknown fields and blocks round-trip | Planned; not yet run |
| Malformed known fields and unsupported versions yield recoverable diagnostics | Planned; not yet run |
| Concurrent initialization/migration and retry preserve usable content | Planned; not yet run |
| None/reader/writer grants remain independent of client-supplied type metadata | Planned; not yet run |
| Valid-looking unauthorized runtime changes fail before durable storage/fanout | Planned; not yet run |
| Comments preserve authorship and anchors through edits; revoked peers lose presence access | Planned; not yet run |

The spike should demonstrate these properties with small representative documents
before changing Pages or notebook admission. Results should distinguish fixture
proof, real editor behavior, and deployment behavior. A later ADR can record a
chosen profile and compatibility promise once those boundaries are demonstrated.
