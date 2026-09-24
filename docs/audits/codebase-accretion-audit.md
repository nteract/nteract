# Codebase accretion and agent-guidance audit

**Status:** Audit, 2026-09-24. Source baseline:
`886a10f8b884c2dc68d30180ebc5b74d5de78922`. History window: 2026-05-14 to
2026-09-24 (the local clone is shallow; nothing earlier was visible).

This audit looks for bad patterns that are *accreting* — growing faster than
the code around them — and for places where agent guidance is too thin, too
thick, or wrong. It combines pattern trends at four revisions, fix-chain
history, invariant enforcement checks, and an adversarial pass that tried to
refute the strongest findings. It changes no code.

Line numbers are pinned to the baseline. Re-verify at HEAD before acting.

## Using this audit

- Treat every finding as evidence at the baseline, not as a standing rule.
  Confirm it at HEAD before changing code.
- Work the [follow-ups](#follow-ups) list. When an item lands, check it and
  cite the PR.
- Re-run the [measurements](#re-measuring) after a cleanup to see whether a
  pattern is still growing.
- Do **not** turn the durability journal's call contract
  (`commit_daemon_notebook_mutation`) into agent guidance. The direction is to
  replace that layer, not to teach agents to build on it. See
  [Durability](#durability-desktop-vs-cloud).
- One dependency-trust finding from this audit is handled outside this
  document.

## Summary

Five patterns account for most of the repeat-fix work.

| Pattern | Where | Evidence |
|---|---|---|
| Bespoke persistence state machines | `runtimed` durability cluster; cloud checkpointing | 26 PRs touched the cluster since 2026-07-14; 10 are `fix`, 1 is `feat`. Full-snapshot writes on every edit batch in both hosts. |
| Twin host shells | `apps/notebook/src/App.tsx`, `apps/notebook-cloud/viewer/notebook-viewer.tsx` | Top two TS repeat-fix files (22 of 88 TS fix commits in 3 months). Features land as hand-synced copies with different state mechanisms. |
| Lints with narrow reach | Tokio lock lint, lifecycle lint, `vite.config.ts` ignore list | Real violations sit just outside each lint's scope. |
| Stringly-typed errors | Rust daemon, cloud auth, MCP | Error-site lines 402 → 826; typed error derives 13 → 27. Fixes add more substring matching. |
| Hand-written cross-language copies | `.pyi` stubs, `index.d.ts`, `_constants.py`, package-name normalizers, MIME priority | A dead Python `shutdown()` call and a missing error reason passed review because nothing compares the copies. |

## Durability: desktop vs cloud

### What exists

The `runtimed` durability cluster is about 13k lines:
`notebook_sync_server/{durability,recovery,persist,file_checkpoint,lifecycle,load}.rs`.
It arrived in #4010 (2026-07-14) and grew through #4180, #4193, and #4203. It
was an exploratory direction that kept growing. The intended direction is to
lean on Automerge and celld primitives instead.

`crates/automerge-store` landed in #4180. It uses the automerge-repo layout:
incremental chunks and snapshots in SQLite, with compaction. Nothing outside
the crate uses it (only `xtask/src/bump.rs`). Its ADR,
[`automerge-document-storage.md`](../adr/automerge-document-storage.md), is
"In progress" and says the slice "changes no authorization policy, save,
eviction, or legacy-authority behavior" (`:290`).

The two storage ADRs disagree.
[`room-source-lifecycle-and-file-recovery.md`](../adr/room-source-lifecycle-and-file-recovery.md)
Decision 3 makes the journal the durable acceptance boundary.
`automerge-document-storage.md:266` rejects keeping full snapshots in an
append-only journal.

### Desktop (local `runtimed`)

The requirements are real on a laptop:

- ack-after-durable with rollback on a failed append
  (`peer_notebook_sync.rs:128-160`);
- crash safety for untitled and unsaved notebooks;
- causal `.ipynb` checkpoints (`exported_heads` vs `durable_heads`) that path
  binding depends on;
- degradation kinds that gate shutdown and room reaping.

The implementation is the problem. Per peer edit batch, under
`room.doc.write()` inside `block_in_place`:

- three full `save()` calls (`peer_notebook_sync.rs:56,127`,
  `durability.rs:1075`);
- one full doc clone (`peer_notebook_sync.rs:62`);
- one full `AutoCommit::load` of the durable snapshot (`durability.rs:1062`);
- three fsyncs (journal, manifest temp file, directory). Rust's `sync_all` maps
  to `F_FULLFSYNC` on macOS.

The frontend debounces edits at 20 ms, so fast typing can keep the lock busy.
No benchmark exists. The journal also writes a parallel `.automerge` mirror
every 500 ms quiet / 5 s max, which is now only needed as a blob-GC root.

What the fix history says: of 11 cluster fixes since 2026-07-14, the journal
*format* caused 2 (`66ba353a4` manifest overflow, `78e1d635b` the upgrade
takeover that added the 704-line `service_repair.rs`). The per-file source
generation and phase state machine caused 3–4 (`8d82819e5`, `732ce4fcd`,
`dbdacff13`). **A storage swap alone will not remove the main bug source.**
The phase machine needs its own simplification.

`automerge-store` is not a drop-in replacement yet:

- `commit` calls `load_document` every time and rebuilds the doc from all
  chunks (`automerge-store/src/lib.rs:227`, `:488-557`). That trades write
  bytes for O(history) CPU per commit.
- It sets `synchronous=FULL` but not `PRAGMA fullfsync`, so it is weaker than
  the journal against power loss on macOS (`:403-413`).
- Compaction has no trigger policy (`:334`).

### Cloud (celld)

Hosted rooms run on [celld](https://celld.dev), self-hosted on AWS with S3.
Each Durable Object cell has its own SQLite database, one epoch-fenced writer,
and LTX replication to the bucket. The cost is EC2 nodes, S3 requests and
bytes, and maintainer time for the platform. There is no per-request provider
bill.

The cloud path does not use the journal. It has the opposite shape:

- Changed frames fan out first. A checkpoint is then scheduled with
  `state.waitUntil` (`notebook-room.ts:1464-1466`, `:1597`). A failed
  checkpoint only logs a warning (`:1606-1613`).
- Each checkpoint writes full snapshots of all four documents with five
  `storage.put` calls (`room-materializer.ts:284-312`).
- The storage ADR explicitly scopes durable-before-fan-out out for hosted rooms
  (`automerge-document-storage.md:112-115`).

Inference, not measured: full-blob puts change pages on the order of all four
snapshot sizes per changed frame, and LTX ships those pages to S3. Chunk rows
would change roughly the size of the new changes.

### Direction

Keep the ack-after-durable contract, rollback, `DegradationKind`,
`file_checkpoint.rs`, and the checkpoint metadata (moved into the store's
`application_state`). Delete, after migration, the `recovery.rs` record
format and scan code, the snapshot-union merge in `durability.rs`, the
manifest sidecar, the overflow takeover in `service_repair.rs`, and the
`.automerge` writer (only after blob GC enumerates the store).

One chunk model can plausibly back both hosts: local SQLite through
`automerge-store`, and Durable Object `ctx.storage.sql` through a host-neutral
core plus a Worker adapter. The rusqlite code itself cannot run in a Worker.

Risks to carry into the work:

- macOS power-loss durability regresses until the store sets `fullfsync`.
- Blob GC roots are live rooms plus `.automerge` files (`daemon.rs:6662`).
  Journals are not roots. Removing the mirror first could orphan attachment
  blobs of closed untitled notebooks.
- Strict sync receipts (`peer_writer.rs:278-296`) are documented on the wire as
  "accepted", not "durable" (`protocol.rs:789-791`). Their restart test uses a
  clean stop, not a kill.

## Enforcement gaps

| Invariant | Enforcement | Gap | Violations at baseline |
|---|---|---|---|
| No tokio lock guard across `.await` | `crates/runtimed/tests/tokio_mutex_lint.rs` | Scans only `runtimed/src` and `runtimed-py/src`. Misses guards in `if let`/`match` scrutinees. | `notebook/src/lib.rs:2298`, `:2358` (held across `ShutdownKernel`, up to 30 s; blocks `send_frame_bytes` for that window). `mcp-supervisor/src/main.rs` at 911, 1310, 1321, 1647, 1659, 2079, 2100, 2277, 2469. 2079 and 2100 hold a read guard across a child RPC with no timeout; tokio's fair `RwLock` then blocks later readers behind a queued writer. |
| No cancel-unsafe reads in `select!` | `tests/tokio_select_cancel_safe.rs` | Only `recv_typed_frame`/`send_typed_frame` are listed. `recv_frame`, `send_frame`, `recv_json_frame`, `recv_control_frame`, `recv_preamble` are missing. | `runtimed/src/sync_server.rs:77` races `recv_frame` (`read_exact`) against `changed_rx`. Its own `changed_tx.send` wakes the other branch, so it triggers often. A lost length prefix ends the settings connection. `sync_task.rs:243-247` already documents this hazard. |
| Lifecycle mutations only under `lock_transition` | `tests/lifecycle_transition_lint.rs` | Matches single-line tokens; rustfmt splits them. | No violation today, but 7 functions are invisible to the lint (`begin_source`, `record_prepared_artifacts`, `note_prepared`, `note_journaling`, `publish_projection_ready`, `note_published_batch`, `publish_recovered_projection_ready`). |
| Commands vs queries routing | `tests/rpc_routing.rs` | Tests a local copy of the router, not `runtime_bridge.rs`. | Copy lacks per-request timeouts and the empty-sender path. |
| Execute by synced `cell_id` | Type-level: `ExecuteCell { cell_id }` | Bindings rely on convention. | None found. |
| TS lint and format coverage | `vite.config.ts` via `vp check` | `"**/lib/**"` (line 23) is ignored for both fmt and lint. | About 120 source files skip lint and format, including `apps/notebook/src/lib` (100 files, core desktop sync), `src/lib`, `apps/mcp-app/src/lib`. |
| No raw `console.*` / `println!` | Prose (`.claude/rules/logging.md`) | No `no-console`, no clippy `print_*`. | `apps/notebook/src/App.tsx:1306`. |
| Dependency metadata at `metadata.runt.uv` | Prose | The reader silently accepts the old top-level shape. | Four manual-QA fixtures in `crates/notebook/fixtures/trust-tests/`. |
| Iframe sandbox allowlist | Strong: `frame-config.test.ts`, `sandbox-source.test.ts`, CSP tests | `sandbox-source.test.ts` scans only `src/`. | None. |

## Accreting patterns

Counts are line matches in production code (tests excluded where feasible).
Treat them as approximate; the trend matters more than the exact figure.

### Rust

| Pattern | 05-14 | 06-23 | 08-22 | HEAD | Per kLOC |
|---|---|---|---|---|---|
| `Result<_, String>` | 148 | 215 | 269 | 309 | 1.20 → 1.58 |
| `anyhow!` / `bail!` | 178 | 236 | 330 | 364 | 1.44 → 1.86 |
| `Err(format!(` | 76 | 120 | 140 | 153 | 0.62 → 0.78 |
| Literal durations | 196 | 220 | 268 | 321 | 1.59 → 1.64 |
| `sleep(` | 70 | 80 | 98 | 110 | flat (+57% absolute) |
| `legacy` | 216 | 246 | 277 | 459 | +182 in one month |
| `compat` | 84 | 95 | 109 | 140 | rising |
| `.unwrap()` | 21 | 20 | 24 | 50 | low; lint-enforced |
| `Arc<Mutex/RwLock<` | 153 | 161 | 171 | 181 | falling |

The `legacy` jump comes from the CLI unification (#4231) and the journal
upgrade (#4193). No shim says when it can be removed.

Sleeps stand in for synchronization in the MCP layer:
`runt-mcp/src/tools/kernel.rs:99` (500 ms), `:115` (8 s wait for rejoin),
and 100 ms / 50 ms polling in `tools/session.rs:263-300`.

God files that grew more than 50% since 2026-05-14: `notebook_sync_server/room.rs`
(+163%), `runtimed-wasm/src/lib.rs` (+122%), `runtime_agent.rs` (+113%),
`runt-mcp/src/tools/session.rs` (+95%), `xtask/src/main.rs` (+78%, 97 new
helpers, 7 new commands), `notebook_sync_server/load.rs` (+76%),
`notebook_sync_server/tests.rs` (+71%), `runt-mcp-proxy/src/proxy.rs` (+67%).
`runtimed/src/daemon.rs` is 11.4k lines with 13 fix commits in 3 months.

### TypeScript

| Pattern | 05-14 | 06-23 | 08-22 | HEAD | Per kLOC |
|---|---|---|---|---|---|
| `.catch(() => {}/undefined/null)` | 19 | 49 | 54 | 64 | 0.31 → 0.36, still rising |
| Lint suppressions (non-test) | 7 | 6 | 9 | 13 | doubled since June |
| `new *Subject` (RxJS) | 14 | 29 | 45 | 46 | 0.23 → 0.26 |
| `useLayoutEffect(` | 2 | 9 | 14 | 15 | rising |
| `useSyncExternalStore` | 64 | 89 | 92 | 95 | 1.05 → 0.53 |
| `as any`, `: any`, state-sync effects, `console.*` | — | — | — | — | all falling |

Swallowed promise errors concentrate in `packages/notebook-host/src/tauri/index.ts`
(10), `apps/notebook-cloud/src/index.ts` (7), `notebook-room.ts` (5),
`live-sync.ts` and `cloud-viewer-session.ts` (4 each).

New state is being built on Subjects, ad-hoc store classes, and context rather
than one store primitive. Host branching inside shared `src/` is only 3 lines;
desktop/cloud divergence lives in the app shells.

### Python, CI, e2e

- `Client._shutdown_daemon()` calls `self._native.shutdown()`
  (`python/runtimed/src/runtimed/_client.py:110`). The native method is
  exported as `_shutdown_daemon` (`crates/runtimed-py/src/async_client.rs:193`).
  The stub declares `shutdown`, so type checks pass and the call fails at
  runtime.
- `Execution.done` treats only `done` and `error` as terminal
  (`_execution.py:106`). The daemon writes `cancelled`, so `wait()` spins to
  timeout. Status properties swallow every exception and return `"unknown"`.
- `get_cell_sync` builds a new tokio runtime per call
  (`async_session.rs:1436,1443`).
- CI: `windows-arm64` is in `needs` (`build.yml:1625`) and the summary table
  (`:1725`) but not in the `track_result` calls (`:1669-1684`). Its failures
  report green.
- `#[ignore]` grew 8 → 19. Seven notebook-sync daemon tests and four conda
  channel tests never run in CI. JS skips cite no issue.
- wdio excludes 11 of 12 specs by default. `conda-inline`,
  `trust-dialog-dismiss`, and `uv-inline` have no runner and no Playwright
  replacement.
- Timeouts only go up: browser e2e 20 → 45 min; readiness 300 s → 900 s.

## Repeated-fix areas

Scope ratios from conventional-commit prefixes over the window (596 `fix`
vs 267 `feat` overall):

| Scope | feat | fix | fix:feat |
|---|---|---|---|
| notebook-cloud | 68 | 188 | 2.8 |
| notebook | 25 | 92 | 3.7 |
| runtimed | 17 | 52 | 3.1 |
| cloud | 19 | 38 | 2.0 |
| mcp | 10 | 23 | 2.3 |
| mcp-app | 2 | 19 | 9.5 |
| renderer | 1 | 11 | 11 |

`fix(notebook)` includes about 24 design-polish commits on 05-30 and 05-31.

Root-cause classes across 84 classified fix commits:

| Class | Count | Examples |
|---|---|---|
| Race / ordering | 12 | `662aaba84`, `061271fc1`, `363b5764b` |
| Durability / recovery | 11 | `8d82819e5`, `66ba353a4`, `78e1d635b` |
| Stale React state / identity churn | 9 | `1cc0af1ab`, `a16db4ed5`, `0098f20a9` |
| CRDT convergence / sync | 8 | `f6decc73a`, `2ec047b59`, `d67223df8` |
| Desktop / cloud divergence | 7 | `f0344f4b8`, `6a6f516ad`, `3960878f9` |
| Wire / protocol compat | 6 | `bb1ae56fc`, `ad9c0aba9` |
| Env / path / platform | 6 | `7604e8a2b`, `1a1725dc4` |
| Missing cleanup / leak | 6 | `4b33a3b42`, `695cb1a15` |
| Error swallowed / string-matched | 4 | `9882fc60a`, `d5192f442` |
| Guidance was wrong | 4 | `833c174dd`, `a4df02054`, `c5368f85d` |

The longest chains:

1. Save and durability, 14 PRs (`7c2a255be` … `58cd5b211`). `58cd5b211`
   removes the sidecars `9e65c6011` added seven weeks earlier.
2. Autosave-zeroing guard, 12 commits in one day (`3410fab3f` … `01d00f672`).
   Each review round found another missed set/clear point for one flag.
3. Cloud live sync, 15 commits (`fbfe6ef5f` … `41829fa77`). Frames and
   projections lost across reconnects.
4. Kernel launch and queue (`e396bddf1` … `34e1994fe`). The final test retries
   on the exact message `"Kernel launch was cancelled by shutdown"`, and its
   comment names an open product race.
5. MCP session recovery (`83bb60f2c` … `8970e18b9`), including five `fix(mcp)`
   commits on 2026-09-07.

Error-string coupling is growing through fixes: `d67223df8` matches
wasm-bindgen panic text in two hosts; `c8438dad5` classifies launch failures
by seven substrings; `c805f3a6f` emits a `notebook_not_ready:` prefix that
`runt-mcp` matches. No guidance or review rubric forbids it.

## Duplication and drift

- **Twin shells.** Comment wiring is written twice (`App.tsx:419-1036`,
  `notebook-viewer.tsx:584-1495`). `sourceCommentThreadsByCell` is a
  near-copy in both. Desktop uses stores for comments, metadata, and presence;
  cloud uses `useState` or a class. `cloud-viewer-session.ts:249` keeps a
  write-only `ResolvedCell[]` state just to force re-renders.
- **MIME priority.** `src/components/outputs/mime-priority.ts` ranks the
  nteract traceback and markdown types first.
  `packages/runtimed/src/mime-priority.ts` lists neither.
- **Package-name normalizers.** Four rules for one concept:
  `trusted_packages.rs:320` (PEP 503), `inline_env.rs:514` (`_` only),
  `typosquat.rs:315` (`_` and `.`), `notebook-doc/src/metadata.rs:737`
  (lowercase only). `zope.interface` matches trust but misses the prewarmed
  pool entry `zope-interface`.
- **Pool hash.** The writer (`warm_env.rs:118-153`) and reader
  (`daemon.rs:481-711`) each define the hash and its constants. Daemon tests
  use the daemon copy on both sides, so drift cannot fail a test.
- **Bindings.** Node and Python each cache `kernel_started` outside
  RuntimeStateDoc. After the kernel dies elsewhere, every later run gets
  `NoKernel` until restart. Defaults and error shapes differ: Python waits
  60 s and raises; Node waits 120 s and resolves `status: "timeout"`. Node's
  `queueCell(source)` creates a cell; Python's `queue_cell(cell_id)` does not.
- **Hand-written contracts.** `KernelErrorReason` in Python lacks
  `environment_prepare_failed`, which Rust writes in 20+ places. `index.d.ts`
  types interrupt/shutdown/restart as `void`; the native functions return
  `boolean`. Generated protocol TS has a drift check; these copies do not.

## Guidance

### Wrong (contradicts code)

- `execution-pipeline` skill: the required-heads timeout "processes anyway".
  `peer_writer.rs:356-389` returns an error after 10 s.
- `daemon-dev` skill and `kernel-env/AGENTS.md`: rooms are "removed" after
  30 s. The 30 s step is kernel teardown; rooms are reaped after 24 h or under
  a 32-room cap (`daemon.rs:483-493`).
- `notebook-wire/AGENTS.md:293`, `daemon-dev` skill: crash recovery uses
  `{hash}.automerge` files and ephemeral outputs. The code uses `.recovery`
  journals and a separate execution store.
- `execution-pipeline` skill: response shapes `CellQueued { execution_id,
  position }` and `AllCellsQueued { cell_execution_ids }`. The code has
  `{ cell_id, execution_id }` and `{ queued: Vec<QueueEntry> }`
  (`notebook-protocol/src/protocol.rs:840,865`).
- `frontend-dev` skill: plain `cargo test` regenerates TS bindings. ts-rs is
  behind the `ts-bindings` feature.
- `src/components/ui/AGENTS.md:73`: raw Tailwind palette classes are "lint
  failures". No such lint exists.

### Stale

About 20 dead names or paths, including the `.claude/rules/environments.md`
globs (`crates/notebook/src/{pyproject,pixi,environment_yml,trust}*` do not
exist), `scheduleMaterialize`, `materializeFromBatch`, `FIXTURE_SPECS`, and
`notebook-docs/snapshots/`. Nine of fifteen spot-checked line citations had
drifted, mostly in the `mcp-session-lifecycle` and `automerge-sync` skills.

### Overspecified

- Line-number citations that rot within weeks. Cite symbols instead.
- Dated baselines and commit narration in AGENTS files and skills. The review
  rubric already asks reviewers to flag this.
- Five copies of xtask command tables. The root `AGENTS.md` already points to
  `cargo xtask help`.
- Four different Python-binding install commands across `runtimed/AGENTS.md`,
  `daemon-dev`, `CONTRIBUTING.md`, and `testing`.
- Room lifecycle stated in four places, two of them wrong. Canonical owner:
  `crates/runtimed/AGENTS.md`.

### Underspecified

- The durability cluster and its phase machine. Per the direction above, the
  fix is a migration plan, not a rule that entrenches the journal.
- `lifecycle_transition_lint.rs` enforces a lock order that no guidance
  mentions.
- No AGENTS file for `python/`, `runt-mcp`, `runt-mcp-proxy`, or `mcp-app`,
  though MCP recovery is a top repeat-fix area. The kernel launcher runs inside
  every user kernel and has no guidance.
- `packages/runtimed/src/sync-engine.ts` (1.7k lines) has no real guide.
- Rule globs miss governed files: `logging.md` omits `crates/notebook/**`,
  `src/**`, and `packages/runtimed/**`; `ui-components.md` covers only
  `src/components/ui/**`; `mcp-servers.md` uses `globs:` instead of `paths:`.
- Nothing tells agents to prefer typed errors over string matching, or to
  avoid `.catch(() => undefined)`.

Guidance changes lag fixes. Durability guidance did not change while
#4047–#4085 landed. `crates/comments-doc/AGENTS.md` did not change during the
CommentsDoc identity chain.

## Follow-ups

Priority is by blast radius, then by cost.

### P0

- [x] Fix settings-sync cancellation by retaining the raw length-prefixed
      read across broadcasts. The typed `FramedReader` is not a drop-in for
      the untyped settings protocol
      ([#4306](https://github.com/nteract/nteract/pull/4306)).
- [x] Fix `Client._shutdown_daemon()` and make `Execution.done` treat
      `cancelled` as terminal
      ([#4305](https://github.com/nteract/nteract/pull/4305)).
- [x] Add `windows-arm64` to the long-tail `track_result` calls in
      `build.yml` ([#4304](https://github.com/nteract/nteract/pull/4304)).
- [ ] Replace `"**/lib/**"` in `vite.config.ts` with build-output paths, then
      run `cargo xtask lint --fix` and fix what surfaces.

### P1

- [ ] Widen `tokio_mutex_lint.rs` to every `crates/*/src`, then fix the
      `notebook` and `mcp-supervisor` sites (clone `RelayHandle` under a
      short lock; release supervisor guards before child RPCs).
- [ ] Complete the `select!` extras list; rename the free `recv_frame` so it
      can be blocklisted without hitting the cancel-safe trait method.
- [x] Make `lifecycle_transition_lint.rs` whitespace-insensitive and add
      regression cases for multiline mutations and lock ordering
      ([#4307](https://github.com/nteract/nteract/pull/4307)).
- [ ] Cover `task_claimed.swap` in lifecycle mutation detection.
      `begin_source` holds the transition lock today, but the scanner only
      recognizes `task_claimed.store`. Keep the scanner's limits explicit:
      matching an earlier lock call does not prove the guard stays alive.
- [ ] Point `rpc_routing.rs` at the real router.
- [ ] Durability slice 1: make `automerge-store` commits O(changes), set
      `fullfsync` on macOS, add a compaction trigger, and benchmark a store
      commit against a journal append on a ~300 KB notebook. No daemon
      behavior change.
- [ ] Reconcile the two storage ADRs so agents get one answer about the
      acceptance boundary.
- [x] Correct execution-pipeline required-heads timeout, response shapes,
      and startup-queueing guidance; document the `ts-bindings` feature
      required for TypeScript settings exports
      ([#4307](https://github.com/nteract/nteract/pull/4307)).
- [ ] Fix the remaining wrong guidance listed above: room lifecycle, crash
      recovery, and palette lint.
- [ ] Drop `kernel_started` caches in both bindings; read RuntimeStateDoc.
- [ ] One package-name normalizer, used by trust, pool match, typosquat, and
      metadata.

### P2

- [ ] Durability slice 2: route NotebookDoc commits through the store with a
      read-through migration from journals and the `.automerge` mirror. Move
      blob-GC roots to the store before removing the mirror.
- [ ] Cloud: decide the checkpoint shape on celld (incremental chunk rows in
      `ctx.storage.sql` vs full-snapshot puts) and whether hosted fan-out
      should wait for durability. Measure S3 PUTs and bytes per edit first.
- [ ] Extract shared comment, metadata, and presence wiring from the twin
      shells into hooks next to the components.
- [ ] Generate or drift-check `.pyi`, `index.d.ts`, and `_constants.py`
      against Rust.
- [ ] Unify the two MIME priority lists.
- [ ] Add review-rubric lines against string-matched errors and swallowed
      promise rejections. Start typed error enums at the MCP and launch
      boundaries.
- [ ] Give every `#[ignore]` and JS skip a tracking issue, or delete it.
      Delete or port the orphaned wdio specs.
- [ ] Replace line citations in skills with symbol names. Collapse duplicated
      xtask, install, and room-lifecycle text into pointers.
- [ ] Add AGENTS files for `python/` and the MCP crates. Repair the
      `.claude/rules` globs.
- [ ] Split `xtask/src/main.rs` by area (artifacts, dev lifecycle, lint,
      packaging).
- [ ] Add a removal condition to each `legacy` shim added by #4193 and #4231.

## Re-measuring

Pick revisions by date and count matches. Adjust paths to taste.

```bash
for d in 2026-05-14 2026-06-23 2026-08-22; do
  git log -1 --format="%h $d" --before="$d 23:59" HEAD
done

# Rust error sites at a revision
git grep -c -E 'Result<[^>]*, String>|anyhow!|bail!|Err\(format!' <rev> -- 'crates/**/*.rs' ':!**/tests/**'

# TS swallowed promise errors
git grep -c -E '\.catch\(\(\) => (\{\}|undefined|null)\)' <rev> -- '*.ts' '*.tsx' ':!**/*.test.*' ':!**/node_modules/**'

# Repeat-fix files in the last 3 months
git log --since='3 months ago' -E --grep='^fix' --name-only --pretty=format: | sort | uniq -c | sort -rn | head -30
```

Deepen the clone first (`git fetch --unshallow`) for trends older than
2026-05-14.

## Method and limits

- Static analysis and git history only. No test or build was run for the
  findings. `cargo test -p automerge-store` did not link on this machine
  (`ld64.lld` cannot parse the MacOSX 27 SDK `libSystem.tbd`); that is an
  environment problem, not a code defect.
- The clone is shallow. "Since 05-14" means "at least since".
- Pattern counts are line matches, and some were hand-summed. Root-cause
  classes rest partly on commit subjects.
- celld durability properties come from its public documentation, not from a
  test in this repository.
- Findings were produced by parallel read-only audits, then the highest-impact
  claims were re-checked against the checkout. One claim was refuted and
  removed: lazy creation of the root `metadata` map cannot conflict, because
  every constructor loads a genesis seed that already contains it.
