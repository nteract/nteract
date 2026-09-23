# On-demand Python for celld cloud notebooks

Status: experimental implementation plan, 2026-09-22. Branch: `quod/preview-python`.

## Outcome and scope

Users of cloud notebooks on our celld deployment can allocate lightweight backed Python compute without pairing a workstation or providing a compute key. This is an explicitly enabled celld-only dev tier. Desktop, generic Cloudflare deployments, installed runtimes, and existing selected workstations retain their behavior. Runtime peers coordinate through Automerge; ZeroMQ and a Jupyter kernel process are not required.

The provider offers a logical Preview Python workstation per owner/deployment and an isolated interpreter per notebook runtime session. Authorized collaborators share notebook content and outputs through the existing room. Execution remains owner-authorized under current policy; editing permission does not grant compute spending authority.

## Source-grounded starting points

- `crates/runtimed-wasm/src/lib.rs`: RuntimeStatePeerHandle authors allowed runtime/output changes for room-accepted executions. NotebookDoc remains room-owned content; runtime peers never invent execution intent.
- `apps/notebook-cloud/src/index.ts`: workstation registration, liveness, attachment and runtime-session fencing.
- The local `runtimed/intheloop` and `runtimed/runtime-agents` repositories demonstrate direct Pyodide execution and IPython display formatting without ZeroMQ. Learn from the execution/display separation; do not copy their old transport or broad worker capabilities. Suppress duplicate final-expression outputs, clean up PyProxy values, and retain attribution to execution IDs.
- The separate celld Python Workers worktree already boots pinned Pyodide 0.28.3 / CPython 3.13.2, packages compiled Wasm, and tests hard termination/invalidation. Reuse verified patterns and pinned artifacts without changing that task's checkout. Full Workers SDK/ASGI compatibility is not a prerequisite for notebook execution.

## Boundaries

A trusted supervisor owns registration, credentials, runtime-peer transport, scheduling and output validation. User Python lives in a dedicated loaded isolate with no cloud credentials, storage bindings, or ambient network access. A globals dictionary or Python object is not a tenant isolation boundary. The notebook room retains accepted source snapshots, execution IDs, session fencing and output authority checks.

Use fresh warmed interpreters once: allocate to one session, retain its variables while active, then dispose. Do not sanitize and recycle a used interpreter across users. Pin interpreter/package assets and load locally. Pool size, active-session count, output size, CPU deadlines and idle TTL are bounded. Hard termination discards the interpreter and fences late results; automatic replay is forbidden. Notebook documents and accepted outputs survive interpreter expiry; Python heap persistence is not promised.

## Implementation sequence

1. Direct notebook execution adapter: persistent globals, stdout/stderr, final-expression output, rich display, structured tracebacks and async code. Start with real local celld execution, then add IPython formatting and pinned scientific packages. Keep transport independent.
2. Session supervisor: clean warm allocation, serialized execution, admission limits, expiry/reset, isolate termination/replacement and metrics. Prove two-session separation and failure containment.
3. Runtime-peer adapter: consume accepted RuntimeStateDoc work, publish existing output manifests, handle blobs, convergence and reconnect. Execute only synced notebook cell IDs through room requests.
4. Celld-only managed provider: explicit disabled-by-default deployment configuration, server-derived owner, idempotent registration, lazy authorized attachment and preservation of explicit compute selections. Bind sessions to deployment, owner, notebook and runtime-session generation.
5. Local collaborative browser smoke: owner and collaborator see the same source and outputs; unauthorized compute allocation fails; restart/expiry are visible. Use shared cloud UI contracts.
6. Reproducible latency/capacity evidence, failure tests, Kilo review, CI and draft PR maintenance. Keep experimental limitations explicit.

## Finish verifier

A clean checkout can build and run the configured local celld provider and execute a synced notebook through the actual runtime-peer path. Verify persistent variables, stdout/stderr, expression and rich outputs, errors followed by recovery, a dataframe/plot, two-client convergence, unauthorized requests, cross-session isolation, bounded infinite-loop termination, replacement/session fencing, reconnect and idle disposal. Record cold and warm allocation-to-first-output distributions, process RSS and incremental session memory, and concurrent allocation behavior; no numerical latency claim is accepted from HTTP-only fixtures.

Failures retain a minimal reproduction and evidence. Diagnose and fix the next failing boundary without weakening the verifier. Do not merge, release, or alter live deployments. Deliver coherent commits and a draft PR with review/CI evidence.
