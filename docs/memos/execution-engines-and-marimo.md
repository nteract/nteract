# Execution Engines and Built-in marimo Support

**Status:** Draft memo, 2026-07-13. Architecture proposal and implementation
framing; no execution-engine interface or marimo integration has been accepted
yet. Tracked by [issue #4002](https://github.com/nteract/nteract/issues/4002).

Neighbors:

- [execution-pipeline.md](../adr/execution-pipeline.md) — durable execution and
  output-ordering invariants.
- [document-split.md](../adr/document-split.md) — NotebookDoc,
  RuntimeStateDoc, and CommsDoc ownership.
- [captured-environment-lifecycle.md](../adr/captured-environment-lifecycle.md)
  — environment capture and kernel-launch behavior.
- [deployment-topology.md](../adr/deployment-topology.md) — local and hosted
  runtime placement.

## Summary

nteract should model notebook execution as a composition of an execution
engine, an executor adapter, a runtime projector, and an environment provider.
The existing explicit Jupyter path becomes one profile of that model. marimo
ships as a built-in Python profile whose engine owns reactive notebook
semantics and whose executor evaluates the authorized work. A local
`RuntimeAgent` or a hosted process attached as a `runtime_peer` may host that
composition; the room protocol remains the hosted boundary.

This memo specifies marimo support as the product and architecture boundary.
The shipped integration must use a supported marimo surface or establish the
smallest appropriate surface upstream.

This is a memo rather than an ADR because several choices still need spike
evidence: the supported marimo embedding boundary, the exact engine/executor
API, the representation of reactive plans, restart semantics, and interactive
UI-value transport. Once those are proven, the durable compatibility and
authority rules can graduate into an ADR.

## Why execution engines

Today the runtime-agent path combines four concerns that happen to align for a
Jupyter kernel:

- `KernelState` owns an explicit FIFO queue with one running execution;
- `KernelConnection` and `JupyterKernel` own Jupyter process and ZeroMQ I/O;
- the runtime agent translates Jupyter lifecycle and output messages into
  RuntimeStateDoc, CommsDoc, and blob writes;
- launch code selects a Python or Deno environment and constructs the process.

That path is intentionally nteract-specific. It provides stronger lifecycle,
provenance, output durability, and programmatic waiting semantics than a raw
Jupyter connection. It is also not a suitable definition of all notebook
execution. `KernelConnection` requires Jupyter ports, comms, completion, and
history, while a reactive runtime needs the complete notebook graph and may
turn one user intent into several cell executions.

marimo makes the mismatch concrete. Its documented contract is reactive: when
a cell runs or a UI value changes, dependent cells run or become stale;
execution order follows variable dependencies rather than visual position.
See [marimo's reactive programming
overview](https://docs.marimo.io/#a-reactive-programming-environment). Treating
that as a single Jupyter-style `execute(cell_id, source)` call would discard
the notebook semantics we intend to support.

The broader model also clarifies raw Jupyter and future reactive runtimes. A
raw kernelspec is normally another executor beneath nteract's explicit engine,
not another scheduling model. A future Pluto integration is another reactive
engine and native executor, not an IJulia kernelspec with notebook semantics
layered on afterward.

## Proposed vocabulary

```text
Compute implementation
├── local RuntimeAgent or hosted runtime_peer adapter
└── EngineSession
    ├── ExecutionEngine       notebook planning, scheduling, failure, quiescence
    ├── ExecutorAdapter       process and protocol integration
    ├── RuntimeProjector      RuntimeStateDoc, CommsDoc, output and blob writes
    └── EnvironmentProvider   uv, Conda, Pixi, Julia Pkg, external environments
```

**RuntimeAgent** remains local daemon machinery for supervising compute near
the daemon that spawned it. It is not a cross-machine API or hosted product
role.

**runtime_peer** remains the host-neutral room role for compute. A hosted
engine-bearing process attaches through the scoped room protocol, receives
accepted work, and publishes allowed runtime and output state. It does not
expose the local `RuntimeAgent` socket across machines.

Both implementations may host the same **EngineSession** composition and share
engine/profile abstractions in-tree.

**ExecutionEngine** defines what an execution intent means: which cells run,
their ordering, failure propagation, cancellation scope, reactive extensions,
and when the notebook has reached quiescence.

**ExecutorAdapter** is the engine-facing bridge to a concrete evaluator or
protocol. “Kernel adapter” is too narrow because a reactive notebook runtime
owns more than a Jupyter kernel connection.

**RuntimeProjector** converts engine events into nteract's durable execution
model. It preserves the existing output-before-terminal and control-plane
separation rules regardless of engine.

**EnvironmentProvider** resolves and prepares the process environment. Captured
UV, Conda, or Pixi environment lifecycle mutations remain daemon-owned. An
executor-internal policy may let an evaluator own environment state inside its
process, but it does not grant direct mutation authority over daemon-managed
caches or notebook dependency metadata.

**RuntimeProfile** is the persisted composition of language, engine, executor,
and environment policy. These are separate facts, not aliases.

Illustrative profiles:

| Profile | Engine | Executor | Language |
|---|---|---|---|
| Existing nteract | `nteract.sequential` | managed `jupyter.zmq` | Python or TypeScript |
| Raw Jupyter | `nteract.sequential` | kernelspec-backed `jupyter.zmq` | Python, Julia, R, or another kernel language |
| Built-in marimo | `marimo.reactive` | marimo runtime adapter | Python |
| Future Pluto | `pluto.reactive` | Pluto workspace adapter | Julia |

The identifiers above are examples, not a schema decision. The first
implementation should use an in-tree dispatch boundary rather than promise a
stable third-party plugin ABI.

## Engine contract

The smallest useful engine session has this conceptual surface:

```text
describe() -> EngineDescriptor
sync_notebook(snapshot_or_delta)
propose(PlannerGrant) -> PlanProposal
execute(AuthorizedPlanRevision, EventSink)
cancel(execution | plan | session)
shutdown()
```

The core surface should remain small. Optional facets advertise functionality
that does not exist uniformly across engines:

- completion, inspection, history, and code-completeness queries;
- Jupyter comms;
- reactive values such as marimo UI-element state or Pluto bonds;
- environment requirements and dependency synchronization requests;
- snapshot recovery or explicit replay.

Capabilities describe behavior; they never relax document authority or output
ordering. An unsupported optional operation should be reported clearly rather
than represented by a mandatory no-op engine method.

Useful semantic capability axes include:

- scheduling: explicit serial, host batch, dependency DAG, reactive fixed
  point;
- planning: host-enumerated, engine-proposed, engine-proposed and extensible;
- notebook view: accepted execution entries or read-only notebook replica;
- cancellation: execution, plan, or session;
- triggers: explicit intent, committed source change, or reactive value;
- interaction: Jupyter comms, reactive values, or none;
- environment policy: host-provisioned, executor-internal, or hybrid;
- recovery: cold restart, snapshot restore, or explicit replay.

## Coordinator-authorized reactive plans

Notebook reactivity changes planning, but it does not transfer durable
execution authority. An **execution coordinator** remains the only component
that accepts root execution intent, reads canonical source, allocates durable
plan and execution IDs, assigns admission sequence numbers, records submitter
provenance, and writes accepted plan and execution records. The local daemon
fills this role for desktop notebooks; the hosted room host fills it for hosted
notebooks. A runtime peer may advance accepted executions and publish outputs;
it may not invent durable work.

An engine-proposed dependency closure is an explicit, scoped delegation. After
accepting a root intent, the coordinator issues a **PlannerGrant** bound to:

- the original submitter and cause;
- the selected engine ID and live engine-session generation;
- the root cell or trigger and the allowed reactive scope;
- a NotebookDoc code projection and any reactive-input generation;
- a bounded lifetime and extension policy.

The coordinator does not reimplement marimo's dependency graph to verify every
dependency reason. It verifies the proposal is within the grant: the engine and
session match, referenced cells and source hashes match the authorized
projection, the trigger policy permits the proposed closure, and an extension
does not introduce a new root intent. This makes planner authority explicit
without letting a runtime peer turn an unrelated engine request into execution.

The common protocol should be:

1. A client submits an intent against synced cell IDs and a specific
   NotebookDoc code projection. The coordinator validates the caller and
   captures the submitter, cause, engine session, and trigger policy.
2. A host-enumerated intent may proceed directly to acceptance. An
   engine-proposed intent receives a PlannerGrant, and the engine waits until
   its read-only NotebookDoc replica contains the grant's code projection.
3. The engine returns a proposal ID, PlannerGrant ID, base code projection,
   engine-session and reactive-input generations, stable cell IDs, source
   hashes, dependency reasons, and relevant edges or ordering constraints. The
   proposal ID is correlation only; it is not a durable plan ID.
4. The execution coordinator validates the proposal and grant against current
   notebook state, reactive-input state, engine-session generation, active
   executions, and trigger policy.
5. The coordinator allocates the durable plan ID and revision, reads source
   from the authorized NotebookDoc projection, captures an immutable source
   snapshot in each execution record, allocates one execution ID and admission
   sequence number per cell, writes all RuntimeStateDoc entries, and stamps each
   NotebookDoc execution pointer.
6. The engine receives the accepted plan revision and `cell_id -> execution_id`
   mapping plus the post-pointer NotebookDoc heads. For an engine-proposed plan,
   it waits until its replicas contain both the accepted execution records and
   those heads, then executes only the captured source snapshots in that
   mapping. A later edit does not change already authorized work. The existing
   sequential path may keep validating observed heads in the coordinator and
   discover accepted one-member work from RuntimeStateDoc without materializing
   a NotebookDoc replica.
7. Reactive work discovered during execution requests an append-only extension
   against the same PlannerGrant, plan ID, accepted revision, and causal basis.
   It cannot introduce a new root intent. The coordinator rejects stale,
   superseded, out-of-scope, or post-seal extensions.
8. After every member in an accepted revision is terminal and its outputs are
   durable, the engine reports quiescence for that exact code, input, graph, and
   engine-session basis. The coordinator then seals the revision. Sealing is
   monotonic: a later source edit, UI interaction, or other trigger creates a
   new plan instead of reopening a completed one.

The existing explicit cell path is the trivial one-member host plan. Run All is
a host-enumerated membership set whose engine supplies any semantic dependency
ordering. A marimo run is an engine-proposed dependency closure. Using the same
acceptance contract for all three keeps authority uniform without forcing their
scheduling semantics to be identical.

Coordinator-issued execution `seq` remains a monotonic admission and projection
order. The sequential engine uses it as FIFO execution order. Reactive engines
follow the accepted plan's dependency edges and ordering constraints instead;
they must not accidentally inherit visual order or current FIFO behavior.

NotebookDoc and RuntimeStateDoc synchronize independently, so a proposal must
carry enough causal context to reject stale work. Full NotebookDoc heads are
correct but may reject a plan after an unrelated markdown or metadata edit. A
deterministic fingerprint over ordered code-cell IDs, sources, and relevant
engine metadata may be the better authorization boundary; this needs a spike.
Reactive UI work additionally needs an engine-session-scoped input generation
or event token so a stale value event cannot authorize work against newer
engine state.

## marimo runtime profile

The built-in marimo profile should feel like choosing a notebook runtime, not
launching another notebook application or server.

- NotebookDoc remains the canonical source and cell identity model.
- The adapter projects code-cell additions, edits, deletions, and relevant
  metadata into marimo's graph.
- The marimo engine uses supported marimo dependency and reactive-execution
  semantics; nteract does not implement a lookalike Python dependency analyzer.
- Each cell evaluated during a reactive pass receives its own
  coordinator-issued execution ID, lifecycle, output list, and NotebookDoc
  pointer.
- Console output, MIME results, and structured errors enter the existing
  RuntimeStateDoc and blob pipeline.
- Graph-analysis errors are surfaced as notebook/runtime diagnostics rather
  than hidden process logs.
- Reactive UI values use a typed optional interaction capability. Each trigger
  carries an engine-session-scoped input generation or event token into the
  PlannerGrant basis; values do not masquerade as generic Jupyter comms.
- Interrupt, shutdown, and restart operate on declared engine scopes and leave
  every accepted execution in a terminal or explicitly recoverable state.

marimo supports both automatic reactivity and a lazy mode that marks affected
cells stale. nteract should preserve that distinction rather than assume every
source change immediately executes expensive work. Whether the initial product
defaults to automatic reactivity, explicit cell commits followed by reactive
closure, or lazy mode remains an open product decision.

Notebook synchronization is projection-only and never authorizes work by
itself. If automatic mode reacts to a committed source edit, the execution
coordinator must first derive an intent carrying the editor's provenance, the
relevant NotebookDoc projection, and the selected trigger policy. The resulting
PlannerGrant may authorize a transitive dependency closure, but only for that
root cause and engine session. The engine may propose and execute a plan only
after that intent passes the same authorization path as an explicit Run Cell
request.

The first execution milestone should cover ordinary Python cells, dependency
ordering, stdout and stderr, MIME output, structured errors, interrupt, and
shutdown. UI-value interactions, SQL cells, package-install UX, app mode, and
marimo `.py` import/export should not block proving the execution boundary.

## Document and lifecycle invariants

Every engine must preserve these existing rules:

1. **NotebookDoc is canonical.** Engine-native notebook state is a projection,
   never a second editable source of truth.
2. **Execution references synced cell IDs and authorized source.** The
   coordinator captures source from the authorized NotebookDoc projection in
   immutable execution records. Engines execute those snapshots, not
   side-channel source or whatever later becomes live notebook state.
3. **The coordinator owns intent and durable plan identity.** Runtime peers
   cannot create executions, allocate durable plan IDs, widen a PlannerGrant,
   or rewrite accepted source, cell ID, sequence, or submitter provenance.
4. **Planner delegation is scoped.** Engine proposals and extensions remain
   bound to an accepted root cause, engine-session generation, code/input
   basis, trigger policy, and unsealed plan revision.
5. **Execution pointers are bindings, not authority.** The normal coordinator
   path stamps NotebookDoc pointers so cells select their current execution,
   but accepted RuntimeStateDoc plan/execution records are authoritative.
   Engines never infer authorization from a pointer alone.
6. **Every cell has its own execution.** A root record cannot aggregate all
   outputs from a reactive plan.
7. **Coordinator sequence is not reactive schedule.** `seq` provides monotonic
   admission/projection order. A reactive engine follows accepted dependency
   edges and ordering constraints.
8. **Control is not output transport.** Lifecycle, cancellation, and queue
   release remain reliable and independent of bounded or lossy output work.
9. **Terminal follows durable output.** Engine event projection must flush
   stream, display, and error state before publishing terminal execution state.
10. **Terminal sealing is monotonic.** Programmatic waits resolve only after the
    coordinator seals a revision whose members are terminal, outputs are
    durable, and engine quiescence matches the same causal basis. A sealed plan
    cannot be extended or reopened.
11. **Restart does not imply replay.** Side-effectful cells are not silently
   re-executed without an explicit, user-visible recovery policy.

Failure propagation is engine-owned. The existing sequential engine may stop
its remaining FIFO after an error. A dependency engine should prevent poisoned
descendants while allowing independent graph branches to proceed. RuntimeState
must represent those outcomes without erasing the original failure or its
causal relationship.

## Metadata and runtime projection

Notebook metadata needs an additive engine selection that remains orthogonal to
Jupyter `kernelspec` and `language_info`. RuntimeState likewise needs an engine
descriptor alongside the legacy kernel projection.

An illustrative shape is:

```text
metadata.runt.execution = {
  engine: "marimo.reactive",
  executor: "marimo",
  mode: "automatic" | "lazy"
}

RuntimeState.engine = {
  id,
  version,
  scheduling,
  capabilities
}
```

This is not yet a field-name decision. During migration, existing notebooks
without an engine selection continue to use the current sequential Jupyter
profile, and legacy `kernel.name`, `kernel.language`, and `kernel.env_source`
fields remain available to existing consumers.

Plan records will likely need a coordinator-issued plan ID and revision,
PlannerGrant reference, original cause and submitter, base code projection,
engine-session and reactive-input generations, member ordering or dependency
edges, extension state, and a coordinator-owned terminal seal. Individual
execution records will likely need a plan ID, plan revision, plan index, and
causal reason. Whether the plan is a coordinator-owned subtree of
RuntimeStateDoc or a separate document should be decided from expected write
cadence, retention, and authority rather than convenience alone.

## Delivery sequence

### 0. Prove the public integration boundary

- Identify the supported marimo API or managed sidecar boundary for graph
  updates, planning, execution, output events, interruption, and UI values.
- Pin a compatible marimo version for the spike.
- If the needed surface is not supported and stable enough, propose the
  smallest upstream interface needed by the integration.

### 1. Extract the existing engine without behavior change

- Introduce internal engine, executor, and runtime descriptors.
- Wrap the current `KernelState + JupyterKernel` behavior as the sequential
  Jupyter profile.
- Preserve Python and Deno execution, output, widget, completion, history,
  interrupt, restart, and reconnect behavior.
- Separate Jupyter process launch from protocol I/O so a kernelspec-backed
  launcher is a bounded follow-up.

### 2. Add notebook-aware planning

- Materialize the RuntimeAgent's read-only NotebookDoc replica; it currently
  receives NotebookDoc sync frames but does not apply them.
- Introduce PlannerGrant issuance, plan proposal, validation, coordinator-owned
  plan identity, causal-basis checks, monotonic sealing, stale-plan rejection,
  and append-only extension records.
- Make MCP and other programmatic execution responses and waits plan-aware.

### 3. Prove marimo ordinary execution

- Select the built-in marimo profile through notebook metadata.
- Synchronize stable NotebookDoc cell identities and sources into the engine.
- Start with a host-authorized Run All vertical slice.
- Project per-cell stdout, stderr, MIME results, structured errors, and
  lifecycle through existing durable paths.
- Verify graph errors, interruption, shutdown, and output-before-terminal.

### 4. Enable reactive cell plans

- Propose provider, stale, and dependent closures for a root cell intent.
- Bind every proposal to a scoped PlannerGrant and execute only
  coordinator-authorized mappings.
- Reject or recompute stale proposals after concurrent code edits.
- Preserve independent branches after an error.
- Add plan diagnostics and sealed-revision waiting.

### 5. Add interaction and recovery

- Synchronize UI values through a typed reactive-input capability with an
  engine-session-scoped input generation or event token.
- Authorize UI-triggered reactive work through the same plan path.
- Define rapid-edit cancellation and superseded-plan behavior.
- Integrate notebook-selected Python environments and dependency metadata while
  keeping captured-environment mutation daemon-owned.
- Define cold start, restart, reconnect, and explicit replay semantics.

Raw Jupyter kernels and Pluto should be separate follow-up issues. They are
valuable validation targets for the abstraction, but neither should enlarge the
first marimo milestone.

## Non-goals

- Reimplement marimo's graph or scheduler in nteract.
- Embed or fork the marimo editor as nteract's notebook shell.
- Replace NotebookDoc with marimo's Python file format.
- Define a stable third-party execution-engine ABI in the first iteration.
- Implement arbitrary Jupyter kernels or Pluto in the marimo issue.
- Emulate IPython-only syntax or magics when they conflict with marimo
  semantics.
- Silently replay side-effectful cells after restart.
- Weaken NotebookDoc, RuntimeStateDoc, or CommsDoc authority rules.

## Open questions

1. Which supported marimo interface provides the most durable embedded or
   managed-sidecar boundary?
2. Which responsibilities genuinely belong to a separate marimo executor, and
   which are inseparable from marimo's reactive engine?
3. What engine-selection metadata interoperates cleanly with standard Jupyter
   metadata and older nteract clients?
4. Should plan authorization use complete NotebookDoc heads or a narrower code
   projection fingerprint, and what reactive-input event token joins that
   causal basis?
5. Where do plan records live, and how long are grants, proposals, sealed
   revisions, and execution history retained?
6. How should skipped, blocked, superseded, and stale cells appear in
   RuntimeState and the notebook UI?
7. What is the default reactivity mode, and what user action commits an edit
   for execution?
8. What marimo version and environment policy provide reproducibility without
   freezing upgrades indefinitely?
9. Which UI-value interactions belong in the first user-facing milestone?
10. What state, if any, can be restored after a runtime-agent reconnect or
    process restart without replaying side effects?
11. Should marimo `.py` import and export preserve engine metadata, cell IDs,
    and nteract execution history, and in which later project should that live?

## Graduation to an ADR

An ADR should follow only after the existing sequential path runs through the
new seam and a marimo vertical slice proves the public integration surface. The
ADR should then record the stable decisions: local RuntimeAgent versus hosted
runtime_peer versus engine/executor ownership, scoped planner delegation,
coordinator-owned plan identity and sealing, engine identity schema, optional
capability model, and compatibility behavior for existing notebooks.
