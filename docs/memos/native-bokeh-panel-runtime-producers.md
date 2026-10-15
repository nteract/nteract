# Native Bokeh/Panel sessions and Python producer hooks

**Recommendation:** Extend the existing notebook-native Bokeh/Panel session implementation with explicit reconstruction, outcome, publication, and producer-capability contracts. Keep Python authoritative for the live graph and callbacks, BokehJS responsible for rendering, and nteract responsible for admission, security, durable publication, and output lifetime. Extract an artifact-only Python producer API first; treat typed session hooks as a medium-scope extension, not a prerequisite for that extraction.

**Status:** Draft research proposal for a documentation-only draft PR. No architecture decision or implementation approval.

**Date:** 2026-10-15.

Prefer versioned, complete authoritative reconstruction with supported reconciliation; use controlled replacement when equivalent reconciliation cannot be guaranteed. Do not preserve rejected browser state merely to preserve object identity. Compare this direction against upstream in-kernel server sessions before committing to enduring private toolkit hooks.

## Evidence, versions, and existing baseline

Research was source-only and ran **no new runtime tests**; supplied fault-regression evidence is identified separately below. The recommendations are proposals to validate, not implemented guarantees.

| Source | Exact research version |
|---|---|
| nteract committed research snapshot—not a current-main claim | `02a06ceebb7b73221369005da69e019b0aee1d6a` |
| nteract stable comparison | `d552f512676a9edb718db72f5a4914ab308e47d0` |
| PR4437 exact inspected head | `3e94af17f2ea0292440ed0d2f934a873a46a0064` |
| Documentation branch base | `6259e81781e1c99a90bb7a9d45b186eddbd8445c` |
| Bokeh 3.9.2 | `1605765de30309a46a17ea1874abb437a695f65f` |
| Panel v1.9.4 | `95c0be7b4e57aea92dc9df556d79f3be46fc6f49` |
| Automerge `rust/automerge-0.11.0` | `8feb8be8be203e3b878bf2cb5919601094f3c816` |

The coordinator checked changes to the inspected relevant nteract source between the research pin and documentation base, finding only unrelated explicit-queue projection changes in `runtime-doc`. This is a scoped comparison, not a claim that every source file remained unchanged.

The historical [Bokeh Document Sessions for Panel memo](panel-runtime-state.md) describes an **implemented baseline**, not an architecture this proposal invents. Native document sessions, typed shell/IOPub messages, runtime manifests, blob pointers, lifecycle handling, and React projections already exist. Its original blanket stale-base rejection description predates shipped admission fixes; pinned source governs. That memo remains unchanged in this pass.

The new work is a supported API boundary and stronger guarantees: complete reconstruction, explicit uncertain outcomes, bounded publication and recovery, producer provenance, and save closure. Existing [kernel session code](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py) and [daemon artifact ingestion](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/bokeh_session.rs) are starting points, not disposable prototypes.

## Product contract and comparative choice

The desired experience is concrete:

- Displaying a Panel object renders a live output; browser interactions run Python callbacks, and Python changes reach authorized viewers.
- Multiple viewers share canonical application state without confusing local focus, selection, connectivity, or speculation with authoritative state.
- Save/reopen restores a declared durable rendering state and resources, not an implied Python process.
- A disconnected viewer shows uncertainty; a confirmed dead kernel leaves the last durable state visible with Python controls disabled.
- Focus and mounted-view continuity are preserved where supportable. Recovery may visibly replace views rather than silently retain rejected values.

| Alternative | Strongest benefit | Principal obligation |
|---|---|---|
| **Native session capability—preferred** | Fits accepted executions, output retirement, artifacts, and recovery | Formalize outcomes and reconstruction; obtain sustainable toolkit seams |
| **Upstream in-kernel `ServerSession`/PanelExecutor tunneling** | Reuses session context, scheduling, locking, and server-oriented Panel behavior | Add notebook authorization, outcomes, publication, and portable artifacts |
| **Controller-lease comm relay** | Compatibility-first product with one active controller and many observers | Enforce leases and fences server-side; synchronize transfer |
| **Daemon shadow graph** | Late joins, replay, and checkpointing without repeatedly querying Python | Reimplement or host version-coupled graph semantics |
| **Distinct declarative CRDT subset** | Independent collaborative annotations/settings, potentially usable offline | Define boundaries that do not imply callback-bearing Bokeh graph convergence |

The strongest alternative is upstream session hosting. Panel’s [Jupyter executor](https://github.com/holoviz/panel/blob/95c0be7b4e57aea92dc9df556d79f3be46fc6f49/panel/io/jupyter_executor.py) creates an in-kernel server session and tunnels protocol traffic through a comm. This is implementation precedent, **not a promised public hosting API**. In-kernel hosting preserves live Python references; moving arbitrary closures into a separate service does not.

Standard server locking serializes important work but does not solve concurrent accepted outcomes, notebook durability, or offline reconstruction. Bokeh’s [server session implementation](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/src/bokeh/server/session.py) also documents a concurrent same-attribute synchronization problem. Patch handling returns `OK`; the [BokehJS client](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/bokehjs/src/lib/client/session.ts) does not use that as nteract’s revision-correlated, durable acceptance outcome. “No acknowledgment exists” would be inaccurate.

**Falsification criterion:** abandon the preferred custom hosting boundary if representative applications require persistent private hooks, or upstream hosting satisfies the same reconstruction, resource, lifecycle, and notebook-durability criteria with materially less machinery. Compare both on identical workloads, including asynchronous callbacks and custom extensions.

A controller lease is coherent if simultaneous editing is unnecessary. A shadow graph requires evidence that replay/export scale justifies duplicating references, defaults, streams, rollover, indexed patches, and extension semantics. A declarative CRDT can contain rich collaborative structures—not merely LWW scalars—but should remain semantically distinct from Python callback execution.

## Ownership and authority

Preserve the existing document split:

| Component | Responsibility |
|---|---|
| `NotebookDoc` | Notebook content and structure |
| `RuntimeStateDoc` | Runtime facts, execution/session topology, status, revision and artifact pointers |
| `CommsDoc` | Replicated widget/comm state |
| Python kernel | Live Bokeh graph, validation, callbacks, scheduling, authoritative mutation order |
| Runtime agent | Kernel-facing brokering and permitted runtime facts |
| Daemon/host | Admission, authentication, schema policy, retirement, and publication policy |
| Viewer | Local BokehJS materialization, speculation, mount lifetime, and uncertainty |

`RuntimeStateDoc` is **not simply daemon-only**: [current policy](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtime-doc/src/policy.rs) permits runtime peers to author allowed facts while reserving host authority. Likewise, [CommsDoc ingress](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/notebook_sync_server/peer_comms_sync.rs) accepts editor, owner, and runtime-peer changes subject to current scope and actor checks. Those checks are not producer-specific field allowlists.

Any stronger producer policy must cover **all mutation paths**, including existing raw replica ingress. Restricting only a new SDK cannot secure a document still writable through broader paths.

Keep host effects in adapters. Existing [RxJS-backed stores](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/packages/runtimed/src/observable-store.ts) and [React external-store projections](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/src/components/notebook/state/output-store.ts) already provide the frontend integration pattern. No React rewrite is proposed.

## Proposed ordering and outcome contracts

The following contracts are **proposals**, not descriptions of complete shipped guarantees.

| Identity or clock | Meaning |
|---|---|
| Authority incarnation | Fences a particular live session authority |
| Session revision | Orders canonical graph transitions |
| Checkpoint generation | Identifies snapshot publication |
| Viewer generation | Fences asynchronous local materialization |
| Automerge heads | Describe replicated-document causality |
| Command ID/viewer sequence | Correlate submissions and outcomes |
| Producer sequence | Orders broker-accepted producer emissions |

A checkpoint or viewer rebuild does **not** increment authority incarnation. A replacement kernel requires new authority. A daemon restart requires fenced reattachment, not automatic trust in persisted “connected” metadata.

Illustrative proposed envelopes:

```text
CommandV1 {
  session_id, authority_incarnation, command_id,
  viewer_sequence, observed_revision, operation_kind,
  capability_handle, payload, buffer_descriptors
}

CanonicalEventV1 {
  session_id, authority_incarnation, producer_sequence,
  base_revision, revision, command_id?,
  event_class, artifact_refs, payload_digest
}
```

Authenticated identity and admission policy come from the host, not self-asserted payload fields. For Bokeh, the kernel-side session registry remains the revision allocator around graph mutation; the runtime agent validates the bound producer and daemon ingestion validates the canonical stream. The capability broker assigns/enforces producer sequences. Arbitrary library-chosen numbers do not become authority.

The shipped kernel accepts patches with `base_revision <= head` and rebases them onto the current document under a broad last-writer-wins rule; it rejects future bases. That compatibility fix avoids repeated resynchronization when browser layout and Python updates race. The proposed contract should classify assignments, structural edits, indexed patches, streams, and button events by their actual stale-base semantics; shipped admission does not establish that all are safely rebased. Preserve older-base compatibility as the baseline rather than restoring blanket rejection, and validate any operation-specific refinement. See the [current admission implementation](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py#L232-L241).

Proposed outcomes distinguish:

- `rejected_before_apply(reason)`;
- `applied(revision)`;
- `partially_applied(revision, checkpoint_ref)`;
- `outcome_unknown`;
- a separate `published(revision, artifact_ref)` durability milestone.

“Applied” means processed under the producer contract, not necessarily that every requested value survived validation or callbacks. [Bokeh patch application](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/src/bokeh/document/document.py) is sequential and can encounter removed references.

Negotiate a bounded outcome-ledger window by incarnation, age, count, and bytes. Admission must atomically reserve a `pending` entry keyed by `(authority_incarnation, command_id)` and bound to the content digest before entering mutation or callbacks. A concurrent duplicate returns or waits on that same pending entry; it never re-enters apply. Within that window, an identical completed command retrieves its recorded outcome without reapplication. A crash that loses a pending entry leaves an unknown outcome, not permission to retry effects. Reusing a command ID, incarnation/sequence, or revision with different content must fail, not silently deduplicate. After expiration or crash, unknown remains unknown: no callback replay without an application-specific idempotency contract, and no exactly-once external-effect promise.

Batching preserves order and dependencies; it must not collapse button presses into scalar updates. Bokeh [hold machinery](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/src/bokeh/document/callbacks.py), notification freezing, and [Automerge transactions](https://github.com/automerge/automerge/blob/8feb8be8be203e3b878bf2cb5919601094f3c816/rust/automerge/src/transaction/manual_transaction.rs) do not establish rollback or observer atomicity across Python, JavaScript, blobs, and multiple documents. Partial mutation requires publication of surviving authoritative state or an explicit canonical-session failure.

## Reconstruction and honest continuity

Two supplied fault regressions used real Bokeh models, mounted Panel, and live kernels at the exact PR4437 head versus stable:

| Supplied fault | PR4437 head observation | Stable observation |
|---|---|---|
| Rejected edit, then sparse checkpoint | Browser `start=10`; Python `0` | Browser restored `0` |
| Failed fetch, then explicit checkpoint | Browser retained `10`, with **zero apply requests** | Browser restored `0` |

Whole native-notebook acceptance was not tested at that head. These observations motivate **future acceptance criteria**; this research did not rerun them. Compare PR4437’s [in-place controller](https://github.com/nteract/nteract/blob/3e94af17f2ea0292440ed0d2f934a873a46a0064/src/isolated-renderer/bokeh-session-controller.ts) with stable’s [replacement path](https://github.com/nteract/nteract/blob/d552f512676a9edb718db72f5a4914ab308e47d0/src/isolated-renderer/bokeh-session-controller.ts).

The source supports the underlying concern: Python [property serialization](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/src/bokeh/core/has_props.py) can omit defaults, while BokehJS [same-ID deserialization](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/bokehjs/src/lib/core/serialization/deserializer.ts) updates supplied attributes. Sparse merging can therefore retain rejected browser values.

Do **not** implement an immediate dirty-property default reset. BokehJS [`dirty` and initialization](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/bokehjs/src/lib/core/properties.ts) track property initialization/set behavior, not pending commands. Python/JavaScript/theme/custom-model default equivalence remains unproven.

A proposed checkpoint contract identifies authority, revision, generation, toolkit versions, serialization version, document hash, buffers, and resources. It must define roots, definitions, types, authoritative properties, omitted defaults, themes, and custom-model reconstruction. A `complete` flag alone is insufficient.

Seek supported preparation/reconciliation APIs that validate references and report preserved versus replaced models. Until reconciliation is equivalent to authoritative reconstruction, controlled replacement is the correctness fallback. Same-ID model identity does not guarantee mounted DOM, focus, editors, canvas resources, or child-view continuity; Bokeh’s [view manager](https://github.com/bokeh/bokeh/blob/1605765de30309a46a17ea1874abb437a695f65f/bokehjs/src/lib/core/view_manager.ts) treats view lifetime separately.

A fetch failure creates **viewer-local uncertainty**, not shared healthy-kernel `Error`. Repair should read a checkpoint/tail and install authority even at the same revision, without resending unaccepted controls. The default repair policy discards pending unsent edits. Any retained editable draft stays separate from the canonical graph; submitting it later requires a new command against repaired authority under an explicit producer policy. Never silently reapply unsent changes over the checkpoint or automatically replay event controls. Generation checks must follow asynchronous fetch and mount boundaries.

## Dedicated Python producer hooks

Dedicated lower-level hooks should let a Python library publish content, revise appropriate comm state, or host a typed live session. Raw access should bypass convenience rather than enforcement.

**Existing foundations.** The Python [binary-output hook](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/python/nteract-kernel-launcher/nteract_kernel_launcher/_buffer_hook.py) attaches stashed buffers to rich outputs, including worker-thread publication. The [kernel application](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/python/nteract-kernel-launcher/nteract_kernel_launcher/app.py) already routes Bokeh shell requests and queued IOPub events with binary frames. The [wire layer](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/notebook-wire/src/lib.rs) separates requests, responses, broadcasts, synchronization, and binary blob frames; [blob uploads](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/notebook_sync_server/blob_upload.rs) implement staging, multipart completion, validation, and bounded admission.

These are real extraction points, not a public acknowledged producer service. The reserved [`nteract.dx.*` namespace](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/dx_blob_comm.rs) has no handler and must not be advertised as an upload API.

### Proposed capability boundary

An execution-scoped Python context should negotiate protocol/schema versions, operations, limits, and capabilities. Names below are illustrative:

```text
producer.open(kind, versions, requested_capabilities) -> context
artifact.begin(context, media_type, size, digest?) -> upload
artifact.part(upload, index, digest, binary_frame)
artifact.finish(upload) -> stored_ref
output.attach(context, stored_ref, resource_closure) -> publication
session.attach(context, checkpoint, output_binding) -> session_handle
session.emit(session_handle, event_class, payload, artifact_refs)
session.checkpoint(session_handle, document_ref, resource_closure)
comm.transact(context, comm_id, schema, path_ops, delivery_mode)
```

`artifact.finish` stores validated bytes; attachment/publication establishes an authorized reference. Upload success alone does not make content reachable or saved.

The broker binds context to a runtime-accepted execution, output, kernel incarnation, and room. A supplied output ID or parent header is insufficient. Background Bokeh events can use `parent=None`; retain the accepted binding from attachment rather than associating callbacks with whichever cell executes later.

Expose raw typed envelopes and binary frames through the **same** capability broker. Neither SDK nor raw callers may spoof provenance, author host-owned facts, bypass quotas, or resurrect retired outputs. In-process capability handles organize authority; they do not isolate mutually untrusted libraries sharing one Python interpreter.

The SDK manages buffer lifetime and callback adapters. The runtime-agent/session broker authenticates kernel origin and sequencing; daemon/host policy governs admission, retirement, and publication.

### Choose the smallest suitable state surface

| Surface | Appropriate scope |
|---|---|
| **Artifact-only SDK: smallest extraction** | Arrays, tables, static plots, resources, immutable checkpoints |
| **Typed canonical Bokeh events: medium scope** | Ordered live graph changes, command outcomes, checkpoints, lifecycle |
| **Optional brokered CommsDoc operations** | State whose collaboration and delivery semantics genuinely fit |
| **New document or non-CRDT sidecar** | Distinct writers, subscriptions, retention, security, or recovery requirements |

Do not assume every producer is ipywidgets-shaped. A comm schema extension can describe producer type, schema, ownership, paths, and state-versus-event routing. A comm-write operation must explicitly say whether Python is already updated or requires delivery. Existing [runtime-agent forwarding and echo filters](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/runtime_agent.rs) can suppress runtime-authored echoes; blindly writing as a runtime peer does not guarantee delivery back to Python.

A new document is justified only when its independent semantics outweigh protocol routing, authorization, subscriptions, persistence, migration, typed clients, [WASM document APIs](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed-wasm/src/lib.rs), export, and retention costs. A sidecar need not be a CRDT. Generic `SessionManifest{kind}` extraction should wait for a concrete second producer; it is not necessary to expose artifacts or improve Bokeh contracts.

## Publication, budgets, and security

Distinguish three acknowledgments:

- **Stored:** bytes passed validation and reached the negotiated storage boundary.
- **Published:** required artifact closure is available and its authoritative manifest committed.
- **Applied:** a specified Python session or viewer processed an operation.

Viewer application is separate from Python acceptance. Existing [output publication](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/output_blob_publisher.rs) publishes remote bytes before advertising runtime references; preserve that ordering. Atomically advancing one manifest does not create a transaction spanning Python, blobs, or multiple documents. Cross-document consumers need revision/readiness gates.

Raw binary avoids base64, but **zero-copy is not established**, including kernel-to-daemon. Buffer-protocol inputs and ZMQ frames alone do not establish copy counts through hooks, frame construction, hashing, and persistence. Specify buffer-release completion, then measure optimizations separately.

Existing [patch-request limits](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/requests/apply_bokeh_session_patch.rs) include 256 buffers and 100 MiB; these are not total workload budgets. Negotiate byte/time limits for uploads, events, tails, pending commands, outcome records, fetch concurrency, sessions, mounts, and retention. Reserve capacity for interrupts, retirement, and acknowledgments; separate queues alone do not eliminate transport head-of-line blocking. Coalesce only declared replaceable state. Gaps require explicit resynchronization, not silent success.

Existing multipart staging uses a [fixed one-hour expiration with cleanup](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/notebook_sync_server/blob_upload.rs#L21-L25). The producer API must state its upload bounds and cleanup behavior. Staging expiration is distinct from published-content retention: publication establishes reachability under a documented policy, not an indefinite pin or an assumed garbage-collection grace period. Validate binary sizes, shapes, dtypes, references, and allocation bounds.

Hash identity is not read authorization. Blob reads, session commands, leases, and exports must respect room/session policy. Extension packaging needs versioned resources, declared JavaScript/CSS/modules/assets, integrity checks, trust/CSP policy, and explicit remote dependencies. No universal per-kind renderer registry is assumed to exist.

## Collaboration, lifecycle, save, and recovery

Offer explicit `any-authorized`, `controller-lease`, and `read-only` policies. Server-side permissions and lease fencing are mandatory. Lease transfer revokes old tokens and requires synchronization before control resumes. Originators receive canonical outcomes as well as observers; echo suppression must not hide corrective authority.

Shared versus viewer-local ranges, selections, and other UI state require a product/producer policy. Focus and presence remain local by default. Automerge [data-model semantics](https://github.com/automerge/automerge/blob/8feb8be8be203e3b878bf2cb5919601094f3c816/rust/automerge/src/lib.rs) and [synchronization](https://github.com/automerge/automerge/blob/8feb8be8be203e3b878bf2cb5919601094f3c816/rust/automerge/src/sync.rs) converge document state; they do not establish Python acceptance, completed browser installation, or callback effects.

Use Automerge for notebook structure, accepted runtime facts, compact session descriptors, artifact references, and deliberately collaborative declarative state. Keep high-volume Bokeh graph artifacts outside the CRDT and preserve kernel ordering for callback-bearing operations. Replicated document changes must not trigger replay of Python controls merely because a peer reconnects. A separately designed collaborative annotation or configuration layer can use richer Automerge structures without pretending that convergence settles arbitrary Bokeh graph validation.

Distinguish viewer detachment, output retirement, and session disposal. Detaching one viewer preserves others. Retirement immediately fences future publication before asynchronous cleanup, preserving [existing retirement ordering](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs). Disposal must cancel watchers, callbacks, tasks, and resources, including views created after unmount. The current [Panel adapter](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/python/nteract-kernel-launcher/nteract_kernel_launcher/_panel.py) motivates supported upstream lifecycle hooks.

A connection loss is not proof of kernel death. A surviving kernel may reattach after an incarnation/revision handshake and fencing of competing owners. Kernel or VM restoration is different: serialized artifacts do not restore closures, external handles, or arbitrary process state. Abrupt termination cannot produce a new final checkpoint.

Explicit save needs a bounded barrier and receipt identifying notebook heads plus each selected session’s authority, revision, checkpoint, buffers, and transitive resources. Existing [save projection](https://github.com/nteract/nteract/blob/02a06ceebb7b73221369005da69e019b0aee1d6a/crates/runtimed/src/notebook_sync_server/persist.rs) resolves outputs/manifests but does not alone prove latest-session resource closure. Pin selected closure during fetch/export; report unavailable sessions rather than falsely labeling an incomplete save current.

Write-on-close may improve a snapshot but cannot be the durability strategy. Crash recovery exposes last durable state and unknown outcomes. Offline reopen advertises static rendering, trusted JavaScript-only interaction, or bounded precomputed states. Panel’s [notebook/export support](https://github.com/holoviz/panel/blob/95c0be7b4e57aea92dc9df556d79f3be46fc6f49/panel/io/notebook.py) does not restore arbitrary Python sessions. Disable unavailable Python controls; never queue offline clicks for automatic replay.

## Migration and discriminating acceptance evidence

PRs 4423/4425/4426 already shipped cancellation, older-patch admission, and retirement fixes. Preserve them; do not propose duplicate implementation. This memo is **not an extra gate** on bounded PR4437 corrections and makes no merge or release claim.

| Stage and owners | Go/no-go evidence |
|---|---|
| Bounded corrections: PR4437 author and existing QA owners | Retest changed head; preserve both supplied regression oracles |
| Contract specification: runtime, protocol, storage, and frontend owners | Agreed authority, outcomes, generations, publication, uncertainty, and fallback semantics |
| Artifact extraction: Python/runtime/storage owners | Scope, closure, retirement, flood, and save tests pass without live-session generalization |
| Native versus upstream hosting: nteract and Bokeh/Panel owners | Same workload suite; correctness and maintainability justify chosen boundary |
| Typed producer rollout: runtime/client owners | Negotiated compatibility, bounded resources, durable recovery; second-producer evidence before generic framework extraction |

Panel [reactive scheduling](https://github.com/holoviz/panel/blob/95c0be7b4e57aea92dc9df556d79f3be46fc6f49/panel/reactive.py) and [document lifecycle utilities](https://github.com/holoviz/panel/blob/95c0be7b4e57aea92dc9df556d79f3be46fc6f49/panel/io/document.py) make session-context compatibility an explicit comparison dimension.

The following are **future tests**, not results from this research. Inspect Python state, effective JavaScript properties, mounted behavior, and durable artifacts independently.

| Test | Required oracle |
|---|---|
| Rejected edit plus sparse checkpoint | Python, JS, mounted control, and reconstructed artifact agree on `start=0`; rejected `10` disappears |
| Fetch failure plus explicit checkpoint | Same repair with **zero apply requests**; only affected viewer is uncertain |
| Reconstruction and continuity | Defaults/themes/custom types/roots reconstruct correctly; unsent drafts never silently overwrite repaired authority; report model and DOM preservation separately |
| Lost replies and partial callbacks | Duplicate during pending and completed ledger states does not rerun callback; partial state is checkpointed; crash-window outcome stays unknown |
| Competing viewers and lease transfer | Canonical outcomes reach both viewers; revoked holder cannot mutate; operation-specific stale admission holds |
| Producer provenance and comm scope | SDK, raw envelopes, and replica ingress cannot cross producer/host boundaries; delayed callbacks cannot attach to replacement output; delivery mode is honored |
| Producer ordering and publication | Identical retry has one publication; same sequence/different digest fails; failed upload exposes no incomplete manifest |
| Flood and backpressure | Memory/storage/queues remain within negotiated bounds; control and retirement meet declared latency budgets |
| Retirement and asynchronous mount | Late events cannot resurrect output; late-created views are disposed; other viewers survive one detachment |
| Save, restart, and offline closure | Reopen without kernel/original blob server renders selected closure; Python controls are disabled; reattach differs from kernel replacement |

## Questions for Bokeh/Panel and nteract maintainers

1. Which representative Panel applications fundamentally require real server-session context, and which should define the comparison suite?
2. Could PanelExecutor’s hosting pattern become a supported transport-independent API, or should it remain implementation precedent?
3. Can Bokeh define complete authoritative reconstruction across omitted defaults, themes, custom models, and version changes?
4. Which same-ID model and mounted-view continuity guarantees are supportable, and when should replacement be explicit?
5. Where should asynchronous callback completion fall relative to command outcomes and canonical publication?
6. Which operation families support stale-base admission or application idempotency, and what ledger window is practical?
7. Which producer first needs more than artifact publication, and does that justify generic session manifests or brokered comm access?
8. How should comm delivery modes and stronger producer restrictions interact with current echo filtering and raw replica ingress?
9. Which save-barrier, resource-packaging, retention, and offline guarantees should be product commitments?
10. If one Python application appears in several outputs, should each output own a session or share a reference-counted session, and what should retirement close?
