# Handoff: transport-agnostic `runtime_agent` (#16)

You are a fresh autonomous session continuing nteract work. You have this repo, this
doc, the ADR (`docs/adr/remote-workstation-doc-agents.md`), and the lifecycle
analysis (`docs/handoffs/16-lifecycle-analysis.md`). You do **not** have the prior
conversation. Work headlessly: execute the plan, commit incrementally, push, open a
PR. Do not wait for input. This work round-trips — another session will take it back
to finish — so **leave a clear trail of decisions** (see "Round-trip discipline").

**Base:** these docs live on branch `quod/runtime-agent-transport-handoff` (= `main`
plus this handoff). Check it out and branch your phase work off it, so the handoff +
ADR + analysis ride along:
`git fetch origin quod/runtime-agent-transport-handoff && git checkout quod/runtime-agent-transport-handoff`.

**You may use subagents and the other CLIs on this host** (`claude`, `pi`, `opencode`)
freely — e.g. fan out a subagent per file to map the seam, or have `pi`/`opencode`
adversarially review a diff before you commit. Parallelize and cross-check where it
helps; just fold the results back into one clear trail.

## Mission

Make the daemon's `runtime_agent` transport-agnostic so a daemon-managed kernel can
sync its RuntimeStateDoc/NotebookDoc to a **cloud notebook room over WebSocket**, not
only the local Unix socket. The daemon stays the kernel manager (env pools, launcher,
supervision). **Start with Phase 1**, which is self-contained: pure Rust + `cargo
test`, no network or secrets.

## Why we're here (context you don't otherwise have)

nteract cloud-hosted notebooks (preview.runt.run) get compute from a workstation that
attaches as a `runtime_peer`. Already merged to `main`:

- **#3399** hosted ExecuteCell dispatch in `runtimed-wasm`: a `REQUEST` frame from an
  editor/owner becomes a queued execution in the room's RuntimeStateDoc.
- **#3397** `runt-cloud-peer`: an outbound WS client that dials a cloud room and syncs
  NotebookDoc + RuntimeStateDoc as a peer.
- **#3400** actor-identity projection refactor.

A spike (closed PR **#3408**, branch `quod/runtime-peer-kernel-host`) **proved the
full loop end to end, including cross-machine**: a `runtime_peer` hosting a python
kernel ran a cloud-submitted cell on a remote Linux box, and the output rendered in
the cloud viewer. **That spike's `kernel_host.rs` reimplements the daemon's kernel
drive — it is a proof, not the product. Do not carry it forward.**

The decision (see the ADR): reuse the daemon (it already owns env pools, the launcher,
and kernel supervision) and make `runtime_agent`'s **transport** pluggable. A bare
peer with no supervisor misses lifecycle events; a daemon-managed runtime that merely
syncs to a different sink does not.

## Design

- **`FrameTransport` trait** — the sync wire, abstracted. Two impls:
  - **UDS + length-preamble framing**: the daemon's current transport, moved out of
    `runtime_agent` unchanged in behavior.
  - **Cloud WS** (Phase 2): header auth + `cloud_room_ready` + one typed frame per WS
    binary message (no preamble) + the consumer-side receive.
- **`runtime_agent` becomes generic over the transport.** Its `select!` loop, queue
  dispatch, `KernelConnection`, `RuntimeStateHandle`, `BlobStore`, `kernel_state`, and
  `reconnect_with_backoff` all stay. Only frame send/recv routes through the trait.
- **The kernel, launcher, and env pool stay the daemon's job.** This is also what lets
  a desktop kernel emit to the cloud later.

### Crate layering

- `FrameTransport` trait **and** the UDS impl go in `notebook-protocol`
  (`crates/notebook-protocol/src/connection/`) — it already owns the framing,
  `FramedReader`, `send_typed_frame`, `send_preamble`, and `Handshake`. No new deps.
- The cloud-WS impl (Phase 2) goes in a small lib crate that depends on
  `notebook-protocol` + `tokio-tungstenite`, so `notebook-protocol` stays
  tungstenite-free and wasm-safe, and the daemon never depends on a binary.

### The exact seam (verified file:line)

- `crates/runtimed/src/runtime_agent.rs:670,672` — `AgentReader` / `AgentWriter` are
  `tokio::io::{ReadHalf,WriteHalf}<UnixStream>`. These become the trait.
- `crates/runtimed/src/runtime_agent.rs:703` — `connect_and_handshake`: splits the
  stream, `send_preamble`, then a `Handshake::RuntimeAgent` JSON frame. Stays
  transport-specific (each impl owns its connect/handshake).
- `crates/runtimed/src/runtime_agent.rs:92` — `FramedReader::spawn(reader, 16)`; the
  loop reads via `framed_reader.recv()` (`:156`-ish) and sends via
  `send_typed_frame(writer, NotebookFrameType::..., &bytes)` (`:491`, `:636`, `:695`).
- `crates/notebook-protocol/src/connection/framing.rs` — `send_typed_frame<W:
  AsyncWrite+Unpin>(writer, NotebookFrameType, &[u8]) -> io::Result<()>` (`:82`);
  `FramedReader::spawn<R>(reader, capacity)` (`:254`); `FramedReader::recv() ->
  Option<io::Result<TypedNotebookFrame>>` (`:284`); `TypedNotebookFrame` has
  `.frame_type` + payload.
- `NotebookFrameType` is in `crates/notebook-wire` (`lib.rs:121`).

A workable trait shape (adjust to fit the real types):

```rust
#[async_trait::async_trait] // or use impl-trait-in-trait if the toolchain allows
pub trait FrameTransport: Send {
    async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>>;
    async fn send_frame(&mut self, ty: NotebookFrameType, payload: &[u8]) -> std::io::Result<()>;
}
```

The UDS impl holds the `FramedReader` + the `WriteHalf`; `recv_frame` delegates to
`FramedReader::recv`, `send_frame` to `send_typed_frame`. On a framing error the loop
already rebuilds the `FramedReader` (`runtime_agent.rs:543`); keep that path working
(the impl can expose a `reconnect`/rebuild hook, or `connect_and_handshake` stays
outside the trait and reconstructs the transport).

## Phase 1 — DO THIS FIRST (self-contained, no network)

Goal: extract `FrameTransport`, port `runtime_agent` to it with the UDS impl, **zero
functional change**.

1. Define `FrameTransport` in `notebook-protocol::connection`.
2. Implement it for the UDS pair (`FramedReader` + `WriteHalf<UnixStream>`), a thin
   wrapper over what `runtime_agent` does today.
3. Make `runtime_agent` generic over `T: FrameTransport` (or hold a
   `Box<dyn FrameTransport>`). Replace the direct `framed_reader.recv()` /
   `send_typed_frame(writer, ...)` calls with the trait methods. `connect_and_handshake`
   constructs the UDS transport and stays UDS-specific.
4. Leave everything else (the `select!` loop, `KernelConnection`, `RuntimeStateHandle`,
   `BlobStore`, `kernel_state`, `reconnect_with_backoff`) unchanged.

**Verification (the contract):**
- `cargo test -p runtimed` stays green — the `runtime_agent` tests are the
  behavior contract for this refactor.
- `cargo build` and `cargo clippy -p runtimed --all-targets` clean (CI runs
  `-D warnings`).
- `cargo xtask lint --fix` before committing (CI rejects unformatted code).

Land it as a focused PR titled `refactor(runtimed): extract FrameTransport and port
runtime_agent (behavior-preserving)`. No functional change. Open it (non-draft) once
green. Keep this PR small and obviously-correct regardless of what comes next — if you
have time to continue, **stack** the later phases on this branch rather than growing
this PR (see "Working across multiple phases").

## Phase 2 — cloud-WS transport (needs preview creds; after Phase 1)

Lift the WS transport from the spike (`runt-cloud-peer/src/main.rs`, merged in #3397):
dial `wss://<host>/n/<id>/sync`; header auth (`Authorization: Bearer` + `X-Scope`, **no**
`Sec-WebSocket-Protocol`); read `cloud_room_ready`; one typed frame per WS binary
message (no preamble); and for RuntimeStateDoc use the consumer-side
`receive_sync_message_with_changes`, **not** the daemon-authoritative
`receive_sync_message` (which strips incoming changes — this bug cost hours). Put it in
the lib crate from "Crate layering". Add a daemon path to spawn `runtime_agent` with
the cloud transport for a room. Re-prove the cross-machine demo through the **real**
agent, not the spike. A cloud `runtime_peer` needs an explicit ACL row:
`POST /api/n/:id/acl {subject_kind:"principal", subject:"<principal>", scope:"runtime_peer"}`
with an owner token; owner alone is 403.

## Phase 3 — lifecycle safety net (REQUIRED before relying on cloud hosting)

Read `docs/handoffs/16-lifecycle-analysis.md` in full. Kernel-event detection (death,
hang, idle, error) is transport-independent and survives the swap. The fatal gap is a
**policy deadlock**: `kernel.lifecycle`/activity are `runtime_peer`-only-writable
(`crates/runtime-doc/src/policy.rs:403-405` blocks editor/owner as "daemon-owned"), so
when the runtime itself vanishes no surviving room participant can correct the doc, and
the room has no watchdog — a dropped workstation leaves a phantom-live kernel with cells
stuck `running`. Ordered must-haves (full detail in the analysis):

1. Sink-liveness heartbeat, and **do not** let a cloud-WS EOF fall into
   `kernel.shutdown()` (`runtime_agent.rs:565,658` — a clean WS close currently *kills a
   healthy kernel*; the framing-error branch at `:513-563` is the correct "keep alive,
   reconnect" policy to mirror).
2. WS reconnect/re-auth analog of `reconnect_with_backoff` (`:744`), kicking the
   full-resync on reconnect.
3. Cloud-room DurableObject watchdog that reconciles `state_doc` on `runtime_peer`
   departure: thread peer **scope** through `removePeer`
   (`apps/notebook-cloud/src/notebook-room.ts:635`), give `RoomHostHandle` a
   reconciliation mutator (it has none today), use a DO `alarm()` with a grace period.
4. Resolve the policy deadlock: grant the room host narrow authority to terminalize
   lifecycle + add a `Disconnected` `RuntimeLifecycle` / `last_seen`
   (`crates/runtime-doc/src/types.rs:272`).
5. Inbound request channel so interrupt/restart reach the agent.
6. Buffer + replay terminal deltas across a blip (don't `break` the loop on one writer
   error, `runtime_agent.rs:635`).

## Phase 4 — workstation endpoint

Daemon capability on the existing env pool + launcher: **list environments**, and
**allocate/start a runtime in env X for room Y** → which spawns `runtime_agent` with
the cloud transport. This is "a workstation you pick compute from."

## Working across multiple phases

If you have runway, continue past Phase 1. The phases depend on each other in order
(1 → 2 → 3), with 4 buildable once the transport exists. Because this runs headless
with no reviewer between phases, **stack** them rather than waiting:

- **One branch per phase, each stacked on the previous.** e.g. `quod/16-frame-transport`
  (Phase 1) off `main`; `quod/16-cloud-transport` (Phase 2) off the Phase 1 branch;
  `quod/16-lifecycle` (Phase 3) off Phase 2; `quod/16-workstation-endpoint` (Phase 4)
  off the transport. Open a PR per branch — target the previous phase's branch, or
  `main` with a note in STATUS that it stacks on PR #N. Every phase stays
  independently reviewable, and the takeback session merges/rebases them in order.
- **Verify per phase before moving on**, and re-run the prior phase's checks so a later
  phase can't hide an earlier regression.
- Keep each PR's STATUS current so the chain is legible end to end.

Per-phase verification, and what's fully headless vs. creds-gated:

| Phase | Verify with | Headless? |
|---|---|---|
| 1 — extract FrameTransport | `cargo test -p runtimed`, clippy, build | Fully |
| 2 — cloud-WS transport | `cargo test` + a unit test of the WS frame round-trip; live cross-machine demo needs `/tmp/stage-oidc.txt` | Code yes; live verify needs creds |
| 3 — lifecycle safety net | `cargo test -p runtimed` + notebook-cloud tests (`cd apps/notebook-cloud && node --import tsx --test test/*.test.ts`) for the room watchdog/policy | Fully (unit) |
| 4 — workstation endpoint | `cargo test -p runtimed` + a local list-envs / allocate smoke | Fully (unit) |

You can write and unit-test all four phases headless. Only Phase 2's **live**
cross-machine re-proof is creds-gated — and this host (lab2) is itself a workstation,
so if `/tmp/stage-oidc.txt` is present you can run the daemon's `runtime_agent` against
a cloud room here and close the loop end to end. If creds are absent, write the code,
unit-test it, and leave the live verification as the resume point.

## Build / test on this host (lab2)

- `cargo` is at `~/.cargo/bin/cargo`. Use an isolated target dir so you don't clobber a
  running daemon: `CARGO_TARGET_DIR=$HOME/.cache/runt-agent-target`.
- Phase 1 guardrail: `cargo test -p runtimed`.
- The repo uses direnv (`.envrc` sets `RUNTIMED_DEV`, `RUNTIMED_WORKSPACE_PATH`).
- Phases 2+ need a staging OIDC bearer at `/tmp/stage-oidc.txt` (provided separately —
  not in this repo). Don't attempt them without it.

## Guardrails

- Conventional Commits. `cargo xtask lint --fix` before every commit.
- **Don't break desktop**: the UDS path must keep working. Phase 1 is
  behavior-preserving; the daemon tests are the contract. Hold a `tokio::sync::Mutex`
  guard only within synchronous blocks (never across `.await`) — CI lints this.
- Branch off `main`; never commit to `main` directly.

## Round-trip discipline (so the work can be handed back)

- **Keep a decision log: `docs/handoffs/16-decisions-log.md`.** It's seeded with the
  decisions from the session that wrote this handoff. Append to it as you make choices —
  one short entry per non-obvious call (what you chose, the alternative, why). This
  committed log is the primary trail the takeback session relies on; favor it over prose
  buried in PR descriptions. Commit it alongside the code that realizes each decision.
- Stack one branch per phase (see "Working across multiple phases"); push frequently.
- Keep a **STATUS** section at the top of each PR description, updated as you go: what's
  done, what's verified (`cargo test -p runtimed` result), what's next, and any blocker
  with your chosen workaround. The next session reads that to take over.
- If you hit a genuine ambiguity or blocker, make the most reasonable call, **document
  it in the PR + a code comment**, and continue. Do not stall waiting for input.
- When you stop (Phase 1 done, or blocked), make the final commit + PR status reflect
  the exact resume point.
- A later interactive session may cherry-pick, rebase, or re-author these commits
  freely — optimize for a clear, reviewable trail over commit-hash stability.

## Pointers

- Spike / reference: branch `quod/runtime-peer-kernel-host` (PR #3408). The WS transport
  to lift is in `crates/runt-cloud-peer/src/main.rs`; `kernel_host.rs` is the kernel
  drive (reference only — the daemon's `JupyterKernel` is the real driver).
- Daemon kernel drive: `crates/runtimed/src/{jupyter_kernel.rs,runtime_agent.rs,kernel_state.rs}`.
- Framing: `crates/notebook-protocol/src/connection/framing.rs`. `NotebookFrameType`:
  `crates/notebook-wire/src/lib.rs`.
- Design: `docs/adr/remote-workstation-doc-agents.md`. Lifecycle requirements:
  `docs/handoffs/16-lifecycle-analysis.md`.
