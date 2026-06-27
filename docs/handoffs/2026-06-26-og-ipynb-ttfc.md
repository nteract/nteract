# OG ipynb TTFC handoff

Status: active investigation, not an architecture decision.
Branch: `quod/og-ipynb-ttfc`.
Date: 2026-06-26.

## Context

OG `.ipynb` loading regressed from the historical behavior where cells appeared
quickly while the notebook continued to initialize. The benchmark target is the
Matplotlib brochure binder notebooks copied from:

`/Users/kylekelley/code/src/github.com/matplotlib/mpl-brochure-binder`

Scratch artifacts are in `.context/og-ipynb-load/`. The full scratch directory is
about 67 MB because it includes copied per-run notebooks, so this handoff keeps
the durable summary here rather than moving every raw run into `docs/`.

## Benchmark Harness

Harness:

`.context/og-ipynb-load/benchmark-og-ipynb-load.mjs`

Primary source notebooks:

- `.context/og-ipynb-load/source/MatplotlibExample.ipynb`
- `.context/og-ipynb-load/source/_PreProcess.ipynb`

The harness runs the real browser/Vite/dev-daemon path, watches DOM cell counts,
captures browser console timing, and records result JSON under
`.context/og-ipynb-load/results/`.

## Key Results

| Result | Notebook | Median first cell | Median all cells | Median synced | Median runtime ready | Median materialize | Timeline shape |
|---|---|---:|---:|---:|---:|---:|---|
| `2026-06-26T15-27-52-004Z.json` | `MatplotlibExample.ipynb` | 993 ms | 993 ms | 1660 ms | 1067 ms | 284 ms | `0 -> 13` |
| `2026-06-26T15-27-52-004Z.json` | `_PreProcess.ipynb` | 926 ms | 926 ms | 955 ms | 651 ms | 10 ms | `0 -> 11` |
| `2026-06-26T16-37-03-763Z.json` | `MatplotlibExample.ipynb` | 884 ms | 1136 ms | 1933 ms | 1343 ms | 75 ms | `0 -> 3 -> 13` |
| `2026-06-26T16-37-03-763Z.json` | `_PreProcess.ipynb` | 945 ms | 945 ms | 976 ms | 644 ms | 10 ms | `0 -> 11` |
| `2026-06-26T17-41-51-091Z.json` | `_PreProcess.ipynb` | 938 ms | 938 ms | 966 ms | 656 ms | 9 ms | usually `0 -> 11`; first iteration streamed noisily |
| `2026-06-26T17-44-17-561Z.json` | `_PreProcess.ipynb` | 973 ms | 973 ms | 1005 ms | 692 ms | 10 ms | `0 -> 11` |
| `2026-06-26T22-37-06-873Z.json` | `MatplotlibExample.ipynb` | 873 ms | 1131 ms | 1782 ms | 1204 ms | 302 ms | stable `0 -> 3 -> 13` |
| `2026-06-26T22-37-06-873Z.json` | `_PreProcess.ipynb` | 801 ms | 969 ms | 1066 ms | 676 ms | 6 ms | stable `0 -> 3 -> 11` |

Interpretation:

- `MatplotlibExample.ipynb` benefits from the frontend progressive projection
  path: first cells appear at about 884 ms while all cells complete later.
- `_PreProcess.ipynb` generally does not benefit. It still paints as one
  structural update, so it pays some new load-path cost without getting a TTFC
  split.
- WASM/materialization is not the `_PreProcess` bottleneck. It remains about
  9-10 ms.
- After removing Rust's blocking no-reply drain and publishing a deterministic
  first structural slice before deferred full materialization, `_PreProcess`
  consistently shows `0 -> 3 -> 11` and improves median first-cell time by about
  172 ms versus the instrumented `17-44` run.

## Implemented Fix

Implemented on branch `quod/og-ipynb-ttfc`:

- Rust streaming load now drains only already-buffered client frames. It no
  longer waits 25 ms after every file-load batch when the browser cannot reply
  during bootstrap.
- The Rust tests cover both paths:
  - a buffered-reply client can still converge before `Ready`;
  - a no-reply client reaches `Ready` under a paused-clock guard without paying
    a 25 ms drain.
- The frontend now publishes a deterministic first structural slice for deferred
  initial materialization when the file load was streaming, then yields a paint
  before running the full async materialization.
- The existing streaming changeset path also avoids shrinking an already
  populated initial projection back to the first slice.

Verification after the fix:

- `node_modules/.bin/vp test run apps/notebook/src/lib/__tests__/frame-pipeline.test.ts apps/notebook/src/lib/__tests__/notebook-sync-store-bridge.test.ts packages/runtimed/tests/sync-engine.test.ts`: 157 passed.
- `cargo test -p runtimed file_backed_initial_load -- --nocapture`: 2 passed.
- `cargo test -p runtimed --test tokio_mutex_lint`: 2 passed.
- `cargo test -p notebook-protocol`: 89 passed.
- `node_modules/.bin/vp check`: formatting and lint passed.
- `cargo xtask lint --fix`: passed after rebasing onto `origin/main`.
- `git diff --check`: passed.
- `cargo test -p runtimed`: unit tests passed, then
  `test_settings_json_mirror_write_does_not_feedback_loop` failed once in the
  integration suite and passed on immediate targeted rerun.

## Rust Bottleneck Evidence

Temporary probes around `streaming_load_cells` showed this shape for
`_PreProcess.ipynb`:

- File parse: less than 1 ms.
- Cell batches: 4 batches of size 3, 3, 3, 2.
- Metadata sync also drains once after cell batches.
- Each `drain_incoming_frames` wait took about 26-27 ms, timed out, and received
  zero frames.
- Total streaming load was about 189-191 ms.
- Per-batch encoded sync payloads were only about 48-52 bytes.

Relevant source:

- `crates/runtimed/src/notebook_sync_server/load.rs`
  - `STREAMING_BATCH_SIZE` is 3.
  - `STREAMING_SYNC_REPLY_WAIT` is 25 ms.
  - `drain_incoming_frames_for` waits for a client `AutomergeSync` frame after
    each batch.
  - `streaming_load_cells` sends each batch and then drains replies before
    continuing.

Likely conclusion:

The Rust-side per-batch drain is real server-side waste for small notebooks, but
the tiny payloads matter more semantically than the wait itself: in the real
browser path, the batch syncs are not carrying useful cell changes because the
client has not replied with its Automerge sync state yet. The repeated waits
should be removed or made non-blocking, but that alone may not move first-cell
time much when the wasted server work overlaps browser startup.

## Browser Bootstrap Evidence

Relevant source:

- `packages/notebook-host/src/browser/index.ts`
  - `BrowserDevTransport` queues inbound daemon frames while `framesReleased` is
    false.
  - `releaseFrames()` delivers queued frames.
  - `notifySyncReady()` calls `releaseFrames()`.
- `packages/notebook-host/src/relay-bootstrap.ts`
  - `notifyRelayReady()` runs only after `bootstrap()` completes.
- `apps/notebook/src/hooks/useAutomergeNotebook.ts`
  - `bootstrap()` resets the engine and sends the frontend's initial
    `engine.flush()` sync message before the host releases queued daemon frames.

Likely conclusion:

In the Vite/browser benchmark path, Rust can start streaming before the browser
delivers inbound daemon frames to `SyncEngine`. The browser therefore does not
produce per-batch inline replies during Rust's 25 ms drain windows. Rust waits,
times out, and continues; the browser later sees a full `0 -> 11` structural
update after `initial_load=ready`.

## Fix Question

Do not blindly reduce the timeout without proving the sync semantics.

Open fix candidates:

1. Make Rust adaptive or non-blocking: pick up already-buffered client replies,
   but do not wait 25 ms between file-load batches when the real client cannot
   reply yet.
2. Consider collapsing the file-load path to "load all cells, send one initial
   doc sync, enter steady state" if benchmarks show per-batch Automerge
   streaming has no production TTFC value.
3. Make the frontend initial structural projection deterministic, so an initial
   cell-bearing changeset can publish the first batch before publishing all
   cells regardless of whether `initial_load` is still `streaming` or already
   `ready`.
4. Treat browser bootstrap reordering as higher risk. If attempted, it must
   prove frames cannot hit a missing or stale notebook handle and must beat the
   simpler frontend projection path in the real benchmark.

Rejected or risky as-is:

- Keeping unconditional 25 ms waits after every small batch: this hurts small
  notebooks and does not guarantee streaming in the browser path.
- Only shrinking the wait: it may hide the `_PreProcess` regression but leaves
  the underlying "no client ack, no useful batch sync" behavior intact.
- Relying on browser in-band replies as the only TTFC fix: for small notebooks,
  it can turn one steady-state sync round trip into several batch round trips
  and reopens handle-ordering hazards.
- Moving all raw `.context` runs into docs: the raw run directory is 67 MB and
  mostly copied notebooks. Keep durable evidence here; preserve scratch
  artifacts in `.context` while the branch is active.

## External Reviews

Requested on 2026-06-26:

- Claude Code via `claude -p`: completed.
- Codex explorer focused on Rust/Automerge streaming semantics: completed.
- Codex explorer focused on browser host/bootstrap ordering: completed.

### Codex Rust/Automerge Review

Conclusion:

- The 25 ms drain is the measured Rust bottleneck for `_PreProcess.ipynb`.
- The tiny batch frames are best understood as "no peer `have`/`need` yet" rather
  than only generic in-flight suppression. A fresh `sync::State` cannot send
  useful cell changes until a client sync message establishes remote state.
- The current Rust test covers the ideal path where the synthetic client reads
  every batch and immediately replies. It does not cover the real browser path
  where the daemon drains zero notebook frames during streaming.

Recommended Rust direction:

- Make streaming load ack-aware.
- Consume one initial NotebookDoc sync round before expecting progressive
  batches to work.
- Change `drain_incoming_frames` to report whether it consumed a NotebookDoc sync
  frame.
- If no ack arrives, stop paying per-batch waits. Finish the remaining load
  without progressive waits, send one final sync advertisement after metadata,
  and let the main peer loop process delayed client replies.

Rejected:

- Increasing the timeout.
- Resetting Automerge `sync::State` after timeout.
- Expecting TypeScript coalescing changes to fix missing change-bearing Rust
  frames.
- Streaming cells out of band from Automerge.

### Codex Browser Bootstrap Review

Conclusion:

- The browser host gates the frames that would produce inline replies:
  `BrowserDevTransport` queues binary frames until `notifySyncReady()` calls
  `releaseFrames()`.
- The current notify order is too late for streaming load. The coordinator calls
  `notifyRelayReady()` after `bootstrap()` resolves; the bootstrap body sends
  `engine.flush()` before returning.
- Releasing earlier is right, but only after the handle exists and the engine has
  reset for bootstrap. Releasing on WebSocket ready or current `prepareRelay`
  would be too early because frames can hit no handle or the wrong handle.
- The Vite relay is not the main blocker after typed bootstrap; the browser-side
  queue is.

Recommended frontend direction:

- Split bootstrap into phases:
  `prepareRelay -> create/replace handle -> engine.resetForBootstrap() -> notifyRelayReady()/releaseFrames() -> engine.flush()`.
- Move the initial `engine.flush()` out of the current bootstrap body and add a
  post-notify callback or equivalent coordinator phase.
- Keep a Rust adaptive fallback as a guard for clients that still do not reply
  during streaming.

Rejected:

- Relying only on the SyncEngine streaming no-coalesce change.
- Releasing frames on WebSocket ready or current `prepareRelay`.
- Moving the Vite `pipeTo` earlier as the primary fix.

### Claude Code Review

Conclusion:

- The no-cell batch behavior is the root cause for why Rust streaming does not
  deliver progressive cells to the real browser path. The first Automerge sync
  messages from a fresh `sync::State` advertise heads and bloom `have` state, but
  they do not carry cell changes until the peer has replied with its own sync
  state.
- The existing Rust streaming test is too optimistic because its synthetic client
  applies every batch and immediately replies. Real browser and Tauri clients
  gate replies behind bootstrap/release, so they do not exercise that path during
  file load.
- The 25 ms drains are still a real Rust regression, but they overlap browser
  startup and are not necessarily the dominant first-cell cost.
- `_PreProcess.ipynb` paints `0 -> 11` because the cell-bearing update arrives
  after `initial_load=ready` and takes the full initial materialize path. The
  progressive split currently depends on timing rather than a deterministic
  "initial structural load" rule.

Recommended direction:

- First, replace blocking drain waits with non-blocking collection of any
  already-buffered client frames, preserving in-band streaming for clients that
  can reply while removing the fixed no-reply delay.
- Then consider simplifying file-backed load to load all cells and send a single
  initial sync, if benchmark results confirm per-batch server streaming has no
  production value for OG notebooks.
- Move the real TTFC win to the frontend: ensure the initial cell-bearing
  changeset or full initial materialize path can publish an early first batch
  deterministically, so `_PreProcess.ipynb` reaches a stable `0 -> 3 -> 11`
  shape instead of racing between progressive and full materialization.

Rejected:

- Making the browser release frames earlier as the primary fix. Claude judged it
  risky for handle ordering and likely worse for small notebooks because it can
  serialize several batch round trips instead of one cell-bearing sync.
- Lowering the timeout as a standalone fix.
- Keeping Rust per-batch streaming unchanged and only patching frontend
  projection.

## Verification To Keep

Run the real benchmark after any fix:

```bash
RUNTIMED_VITE_PORT=7366 node .context/og-ipynb-load/benchmark-og-ipynb-load.mjs --iterations=5 --base-url=http://127.0.0.1:7366
```

Focused tests that should exist before trusting the fix:

- Rust integration test where the client does not reply during streaming; assert
  that small notebooks do not pay repeated 25 ms waits and still converge.
- Rust integration test where the client does reply during streaming; assert
  that progressive counts are still observed before `initial_load=ready`.
- Browser-host or SyncEngine test covering queued inbound frames and bootstrap
  release ordering.
- Benchmark comparison for both `MatplotlibExample.ipynb` and
  `_PreProcess.ipynb`.
