# MCP direction: notebook identity and realtime collaboration

Date: 2026-10-09. Status: staged implementation and remaining research direction.
Source check: `3a83bd2684c76367434cbc409a3a9b2db4b27ede` (2026-10-09 main). The inspected MCP, sync, runtime, hosted transport, and MCP App implementations match the earlier investigation checkpoint; intervening differences in those directories are version manifests.
Prepared from source and standards research with an independent Kilo Fable architecture consultation. The [attachment contract](../adr/mcp-explicit-notebook-attachments.md) now records the approved first migration: ID/domain or handle targeting and separate retained address ownership. Existing logical handles keep their deliberate-release/no-TTL contract; any ownerless-pool eviction policy is a new contract, not retroactive handle expiry.

## First implementation

The first slice fixes local replica actor identity and adds bounded
`inspect_notebook`. Ordinary operations accept notebook ID/domain or an existing
handle. ID requests retain and capture already connected, authorized replicas;
a cold target still requires explicit connect. Shared address owners have no
TTL/eviction, count toward capacity, and are separate from explicit handle
ownership. This is a staged subset of the full resolver below: cold projection
inspection, bridge canonical-address metadata and broader hosted readiness
qualification remain future work.

`get_results(timeout_secs)` continues an existing execution wait, default zero,
maximum 50 seconds. `inspect_notebook(after, timeout_secs)` covers notebook-wide
changes with the same bounds. The old combined wait remains callable with its
original handle/default contract but leaves the advertised catalog, so inspect
does not increase tool count. Resources and subscriptions remain first-class.

Actor IDs use a full random UUID per independent writable local replica (and full-entropy hosted nonce) and
reconstructed recovery peer; shared DocHandles retain one actor. Stable
principal/operator attribution and historical labels remain readable. Automerge
0.12's released Authors API is being qualified separately; the collision repair
does not require changing the dependency or admission model.

## Recommendation


Make notebook identity the ordinary public target. Use `notebook_id` under the MCP server's fixed local authority; hosted calls also name the configured `domain`. Resolve the address once per request into authorized access appropriate to the operation: a ready, captured replica for edits, and an existing replica or side-effect-free authority snapshot for inspection. Keep retention leases, subscriptions, physical replica identity, and execution identity separate.

Use the ID/domain tool contract across local stdio MCP and MCP adapters for direct/bridged hosted connections. Share `(authority, notebook_id)` semantics and conformance cases with WebSocket, Node bindings, and notebook UI; those clients can retain their native socket/URL addressing. Do not replace notebook sync with MCP messages or require all adapters to run through one new service.

Deliver this in small stages: fix the known actor defect and make reads dependable; establish the notebook-address resolver and lifecycle contract; strengthen recoverable observation; then ship a read-first live notebook tab and richer OpenAI entrypoints.

## What the investigation established

- The installed swarm passed 104 edits and 52 executions on three notebooks, including concurrent calls from one caller across three targets. Its cells had different IDs across notebooks, and shared-notebook calls did not actually overlap. This is useful bounded routing evidence, not transport/load qualification.
- A separate isolated real-daemon fixture reproduced create-then-connect in one worker producing distinct writable replicas with identical actors and daemon `DuplicateSeqNumber` rejection. Healthy file-open reuse passed its control. Fix replica identity regardless of pooling or argument naming. Source anchors: `crates/runt-mcp/src/tools/session.rs:1802`, `crates/runtimed/src/notebook_sync_server/identity.rs:100`, and `crates/notebook-sync/src/connect.rs:460`. The implementation adds a real-daemon regression and preserves the healthy reuse control.
- WebSocket selects a notebook at `/n/{id}/sync` admission and binds subsequent frames to that room. Individual `NotebookRequestEnvelope` operations carry correlation/causal information, not another notebook selector. MCP must resolve its per-call target before borrowing such a bound connection. See `crates/notebook-cloud-transport/src/lib.rs:180` and `crates/notebook-protocol/src/protocol.rs:468`.
- Local and hosted admission are not identical: local causal admission waits for missing heads; hosted currently rejects them. Hosted readiness still has a connected-replica fallback, and edit permission does not establish compute permission. The API must expose those facts and retain the safety gates.
- A native integration can own notebook retention through trusted host lifecycle hooks. Generic MCP cannot assume it receives equivalent chat identity; its operations must remain correct when such hooks are absent.

## Identity and lifetime contract

| Concept | Responsibility |
| --- | --- |
| `(authority, notebook_id)` | Stable notebook address; never a credential or conversation identity |
| Principal and effective scope | Authorize source, runtime, and comment operations at the actual room host |
| Operator/agent label | Useful attribution; cannot supply routing or authenticated authority |
| Replica actor | Unique for each independently writable Automerge instance; clones of one instance share it |
| Retention lease | One explicit owner's request to keep resources retained; independently releasable |
| Subscription and cursor | One observation lifetime and one bounded journal position |
| Execution ID | One accepted run and its original source/results, independent of later cell runs |

For the mixed installed server, retain the existing `domain` vocabulary: omitted domain always means its configured local daemon; a hosted notebook requires its explicit configured origin. Never consult mutable default-domain, last-opened state, first cache match, or credential availability to guess a target. Return effective authority alongside notebook ID. A future multi-account origin needs an explicit account selector; current origin-only configuration cannot safely guess one.

Configured `domain` is now published for connect/list and ordinary ID-targeted calls. The compatibility `target` locator remains hidden. Live and packaged catalogs must agree; broader authority and bridge discovery remains part of Stage 2.

Room locators, MCP resource URIs, and host-owned file URIs stay separate. Do not reinterpret a `nteract://` representation URI as a credential or raw network endpoint. Keep hosted canonical IDs visible even if an internal bridge uses a local UUID alias. This requires daemon protocol work: `RoomInfo` currently lacks the bridge locator and effective hosted identity/scope (`crates/runtimed-client/src/protocol.rs:510`), although the internal bridge retains the locator and hosted ID (`crates/runtimed/src/notebook_sync_server/hosted_bridge.rs:64`). Stage 2 must expose an authorized, credential-free canonical address mapping and obtain effective capabilities from admission. A bridge alias must not be presented as a different local authority or pooled with a direct hosted connection without compatible identity evidence.

Internally, pool on address plus endpoint/incarnation or hosted generation, authenticated principal/scope/auth epoch, and attribution compatibility. Coalesce concurrent opens per compatible key. Revalidate after connection establishment. An operation that permits peer acquisition may create another replica after a pool miss, unhealthy candidate, or failed optional lookup, so correctness must never depend on perfect pooling. Inspection follows the separate no-launch rule below.

For the local actor fix, use a full UUID per physical replica; the shipped hosted per-connection nonce illustrates the lifetime boundary (`crates/notebook-cloud-transport/src/registry.rs:158`). Separate stable operator attribution from unique replica identity rather than changing the worker operator on every request. Audit typed actor parsing, NotebookDoc/CommentsDoc admission, backing-key attribution comparisons, proxy identity seeding, and presence/comment rendering. Preserve authenticated-principal checks; do not replace them with loose string-prefix matching.

Each request retains its captured access, including any borrowed replica, until completion. Preserve known admission/outcome and IDs even if the lease ends meanwhile. A lost reply remains uncertain; never replay a mutation automatically. An unavailable ID must not open an empty notebook or choose another authority.

## Proposed ordinary API

The implemented ordinary surface (additional bounded inspection options are in tools/list):

```text
inspect_notebook(notebook_id, domain?, cell_ids?, start?, count?, after?, timeout_secs=0)
set_cell(notebook_id, cell_id, source, domain?, ...)
execute_cell(notebook_id, cell_id, domain?, ...)
get_results(notebook_id, execution_id, domain?, timeout_secs=0, full_output=false)
```

The inspection tool is advertised and bounded, using the same projection/read code as resources. Sharing projections does not imply acquiring an ordinary peer for every read: use an already-authorized replica or a daemon-owned snapshot that cannot auto-launch a kernel. For cold rooms where that is insufficient, return explicit unavailability until a non-launching observer admission is available. Do not silently connect an ordinary peer to satisfy a read. Defaults return a useful summary, stable cell IDs, effective capabilities, heads, truncation/pagination, and a matching cursor when observation is available; otherwise report that observation is unavailable. Do not assume every host discovers resource templates or hidden tools. Current hidden reads are in `crates/runt-mcp/src/tools/mod.rs:329`.

Current pagination uses offsets over live snapshots, with explicit next offsets/truncation. Compare observation cursors before combining pages; it is not a pinned historical snapshot. Future stable pagination tokens must remain distinct from observation cursors. Mutation receipts distinguish locally applied, authority-synced, and file-saved outcomes; a successful edit receipt must not imply a disk checkpoint.

Execution always references synced cells; required heads establish containment, not a global lock or a guarantee to execute exactly the source the model last saw. Return exact execution IDs and authoritative source snapshots where available. Optional guarded editing/execution can reject an outdated observed source. A local guard must validate and apply atomically, and cannot prevent a concurrent remote change that has not arrived. Same-cell collaboration remains allowed.

Responses should consistently identify notebook/authority, cell and execution IDs, known outcome, relevant revision/heads, and next readable resource. Use small model-visible text and structured results. Keep full renderer hydration separately versioned and complete; do not silently truncate its current contract.

## Runtime ownership and MCP retention stay separate

Python executes in a daemon-owned runtime-agent subprocess that joins through the notebook protocol and synchronizes the notebook/runtime/comms documents. Switching an MCP edit target or releasing one logical handle does not issue a kernel shutdown. MCP is an adapter to this runtime; it must not acquire a second kernel lifecycle model.

The current daemon couples ordinary-peer membership to two runtime policies: the first peer can auto-launch a trusted local kernel (`crates/runtimed/src/notebook_sync_server/peer_connection.rs:340`), and the last peer leaving schedules idle teardown. Runtime-agent connections use a separate handler and do not increment that ordinary peer count. Teardown rechecks peer count and connection generation before its shutdown RPC. This is a daemon idle policy, not an effect of choosing another notebook. See `crates/runtimed/src/runtime_agent.rs:1`, `crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs:177`, and `crates/runtimed/src/notebook_sync_server/peer_eviction.rs:130`.

Preserve independent MCP attachment ownership during migration. New ID operations borrow internal peers without minting a permanent logical attachment per call. Let integrations manage peer reuse and observation retention; ordinary agents should not need MCP lease bookkeeping to manage Python. If explicit retention remains useful, describe it as peer/resource ownership and release only that owner's interest. Kernel keepalive, execution, interruption, and restart remain authoritative runtime policies.

Pool bounds must preserve existing owners: a replica with any live handle/retention owner is not eviction-eligible. Protect in-flight calls, unsaved source, active watches, and queued/running executions, including execution that outlives its tool call. A local RuntimeStateDoc observation alone is insufficient to race-proof eviction; establish the protection with the authoritative execution/daemon lifecycle.

Evicting the sole ordinary peer of a headless notebook can eventually discard idle Python variables through daemon policy. Treat that as a behavior change requiring an explicit daemon-owned idle/retention contract, not a cache implementation detail. Until that contract is settled, use capacity refusal rather than evicting a peer needed to uphold those promises. Do not choose a guessed TTL or require agents to manage kernel leases. No `disconnect_notebook(notebook_id)` may release everyone else's peers or watches. Expose actual kernel generation/state changes so users and agents can recognize an authorized collaborator's restart.

## Realtime has three distinct consumers

1. **Notebook state:** existing Automerge and runtime/comment/comms synchronization drives the live human view.
2. **Observation:** a consistent baseline plus a bounded change cursor supplies affected cells, progress and terminal execution facts. Native MCP subscriptions invalidate resources; older hosts use legacy subscription support or a bounded wait. Preserve terminal results through authoritative readback, coalesce noisy progress, and signal overflow/rebaseline.
3. **Model context:** the host adapter selects small relevant facts: notebook address, selected cells, observed revision, changed cells, exact run status, and comments. It replaces context for the view, respects user removal, and does not start a model turn for every keystroke.

A notebook ID survives reconnect where recovery is possible; an old cursor or subscription does not. Keep cursor identity as an observation epoch plus sequence, separate from document heads: the journal also captures comments, connection state and coalesced runtime changes (`crates/runt-mcp/src/observation.rs:194`). Heads can support document-diff recovery, but do not by themselves reproduce that observation history. Active watches retain their observation state independently of ordinary request borrowers. Bound any retention between waits explicitly; if history expires or a replica/journal is replaced, return a new consistent baseline with `resync_required`, never `unchanged`. Establish the watch and baseline without a missed-change window. Canceling observation must not interrupt computation.

An ordinary resource notification is not an idle-agent wakeup guarantee. Event-triggered work is a separate later capability. OpenAI currently documents a draft Events webhook integration for selected cloud Work/dot contexts; that is a possible hosted extension after persistent subscriptions, authorization, deduplication, expiration, and loop prevention are designed. It is not a local stdio dependency. [Events documentation](https://developers.openai.com/plugins/build/mcp-events)

## OpenAI extensions: first useful slice

Start with a thread notebook tab bound to an explicit live notebook address. Reuse shared cell/output rendering, show live run state and comments, and let a human choose cells to add to chat. Begin read-first; qualify host routing and context removal/remount before editing and bidirectional widgets.

Add notebook/cell mentions, a global notebook browser, and file entrypoints afterward. An empty thread/global entrypoint opens a picker or empty state. It never restores another chat's current notebook from a shared MCP variable.

For files, distinguish joining a live notebook, opening a local file through daemon recovery, and importing a separate copy. Apps receive opaque resource URIs; supported host-to-server calls may include the actual local path. Only use documented mappings. A host-file export requires writable support and an observed ETag. Do not run competing host-file and daemon autosave writers against the same notebook.

All extension features require observed host capabilities. The pinned OpenAI extension revision is `faf1c46830c4b43bf8f9d69b79798335adba86b5`; MCP core is current `2026-07-28`, while the stable Apps UI dialect is `2026-01-26`. They are different layers. Generic Apps do not automatically establish core subscription forwarding. [Pinned OpenAI extension specification](https://github.com/openai/mcp-extensions/blob/faf1c46830c4b43bf8f9d69b79798335adba86b5/docs/spec.md), [core statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic#statelessness), [stable Apps](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx)

OpenAI documents model visibility for both content and structuredContent; component-only result metadata is a separate supported-host contract. Measure actual transcript payloads and preserve current renderer compatibility while moving large UI hydration off the model path. Audience hints are not access control. [Tool results](https://developers.openai.com/plugins/reference#tool-results)

## Alternatives

| Option | Decision |
| --- | --- |
| Keep handles mandatory for every operation | Safe explicit targeting, but makes ordinary notebook work depend on acquisition/expiry bookkeeping; retain as compatibility path |
| Bare notebook IDs with a global disconnect/cache | Reject: loses independent ownership and authority qualification |
| Notebook addresses plus internal replicas and separate optional leases | Recommended: matches existing room routing while retaining lifecycle correctness |
| Route all clients through MCP | Reject: adds protocol overhead to working realtime sync/Node integrations |
| Full notebook editor/extension rewrite first | Defer: usable reads, identity, receipts and observation are prerequisite contracts |

## Delivery stages

| Stage | Concrete change | Completion evidence |
| --- | --- | --- |
| 1. Correctness and basic usability | Unique local replica actors preserving auth/attribution; robust reuse; known outcome preservation; bounded advertised inspection; fix inconsistent resource links | Deterministic actor regression becomes passing desired-behavior test; supported host can read what it edits; no source/runtime authority changes |
| 2. Notebook-address resolver | Shared address semantics; non-launching reads; bridge canonical-address/capability metadata; captured access; compatible pool with explicit headless retention; exact old-handle adapter | Same cell UUID in two notebooks and same notebook ID under two authorities never cross-route; reading an inactive room launches no kernel; one owner release leaves others usable |
| 3. Observation and migration | Stable addressed resources, snapshot/cursor consistency, recovery, canonical catalog and compatibility | Overflow, cancellation, restart, delayed sync, scope changes and stale catalogs tested across local/hosted adapters |
| 4. Live notebook tab | Read-first selected notebook/cells, run progress, comments, compact model context | Real installed-host UI and model-context evidence, including two tabs/chats and remount |
| 5. Rich collaboration | Mentions, file binding/export, full editing/widgets; optional hosted Events/Tasks experiments | Capability-specific host proof and explicit authorization/lifecycle contracts |

Keep existing handle calls and resource aliases as exact-lifetime compatibility adapters. Prefer exactly one target form per request; reject mixed or missing selectors before effects. Do not reinterpret expired handles as fresh ID lookups. Live child capability checks remain separate from cached schema publication. Advertise migration through standard catalog mechanisms, test real host refresh, and preserve a deliberate reconnect fallback without implicit targeting.

Delete obsolete active-slot/rejoin machinery only after resolver and adapter tests establish coverage. A successful UI demo is not a reason to remove recovery gates.

## Acceptance matrix

Run the same behavioral assertions through local stdio, direct hosted MCP/WebSocket, bridged hosted access, and relevant Node/client fixtures.

- Interleave/barrier-overlap operations on notebooks containing the **same cell ID**, distinct content and kernels, including opening a third notebook and failed open. Read authoritative content and exact results from each target.
- Force separate replicas after create/reconnect, simultaneous acquisition, unhealthy reuse and optional listing failure. Valid edits converge without actor collisions.
- Two peers intentionally edit one cell. Assert valid collaboration, target correctness and truthful resulting source, not both replacement intentions winning.
- Release one lease, close one UI, and cancel one watch while another keeps editing/running/watching. Preserve independent ownership and bounded counts. Read an inactive room without kernel launch; exercise headless queued/running execution and idle variables under pool pressure and the agreed daemon retention policy.
- Delay sync before execution; distinguish safe known non-admission from lost-reply uncertainty. Preserve execution source/results after cell edit and rerun.
- Restart worker/daemon or interrupt remote connectivity. Reacquire the original notebook or return unavailable; never create a blank replacement, resurrect an old cursor, or duplicate an uncertain write.
- Verify hosted viewer/editor/owner/runtime scopes, principal isolation, revocation and authority-qualified IDs with real authenticated service checks before claiming hosted qualification. Address one hosted notebook both directly by its canonical ID/domain and through its local bridge alias; report the same canonical authority while preserving route-specific capabilities.
- Qualify legacy/native catalogs, resource failure fallback, actual model payload size, App capabilities, selected context/removal, remount, file ETag conflict and output/widget isolation.
- Record time to readable baseline, edit-to-authority receipt, execution completion-to-visible result, context freshness and retained peers under churn. Agree budgets from a measured baseline; no invented realtime SLA.

## Open decisions and evidence limits

- Headless idle-kernel retention, capacity refusal, and any ownerless warm-pool eviction policy require an explicit daemon contract and measurement before Stage 2 ships. No timeout is chosen here.
- Isolated local daemon and fake hosted/proxy fixtures qualify the first implementation. No new live hosted service, installed Codex UI, or extension tests are claimed. Prior swarm/probe receipts retain their stated scope.

The first slice adopts explicit ID/domain targeting with deliberate bounded retention and no eviction. General cold acquisition and ownerless peer eviction remain separate decisions. Host-specific rendering, file binding, and event-triggered work remain separately qualified stages.
