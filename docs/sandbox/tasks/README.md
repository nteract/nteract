# Sandbox Integration Tasks

Implementation tasks for integrating [nono.sh](https://nono.sh) as a network proxy and credential injector for nteract Python kernels.

## Rules for implementers

**You will be assigned exactly one task file (e.g. `01-vendor-nono-binary.md`). Read only that file.**

Do **not** read other task files in this directory. Each task is designed to be self-contained, given:

- This README
- `docs/sandbox/decisions.md` — locked architectural decisions
- The assigned task file
- Specific design docs that the task file points you at

If your task seems to overlap with another task's territory, that's a coordination bug — flag it in your PR rather than reading the other task. The coordination contract is the "Interfaces produced" and "Interfaces consumed" sections in each task file.

## Task graph

```
                       ┌──────────────────────────────────┐
Phase 0 (foundation):  │  01-vendor-nono-binary           │
                       │  02-runtime-state-cell-annotations│
                       │  03-notebook-metadata-sandbox    │
                       └──────────────┬───────────────────┘
                                      │
                       ┌──────────────▼───────────────────┐
Phase 1 (daemon core): │  04-nono-process-supervisor      │  (depends on 01)
                       │  05-profile-translator           │  (depends on 03)
                       │  06-stderr-and-audit-tail        │  (depends on 04)
                       │  07-launch-kernel-integration    │  (depends on 04, 05)
                       │  08-error-enrichment-pipeline    │  (depends on 02, 06, 07)
                       └──────────────┬───────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
Phase 2:  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
(parallel)│ 09-mcp-tools    │ │ 10-ui-credential│ │ 11-ui-sandbox-status│
          │                 │ │   -manager      │ │   -and-annotations  │
          └─────────────────┘ └─────────────────┘ └─────────────────────┘

Phase 3:  ┌──────────────────────────────────────────────────┐
(after 1) │  12-end-to-end-tests                             │
          └──────────────────────────────────────────────────┘
```

### Phase 0 — Foundations (do these first, can run in parallel)

| File | What it does | Blocks |
|---|---|---|
| [01-vendor-nono-binary.md](./01-vendor-nono-binary.md) | Bundle nono inside nteract; binary discovery; build/CI integration | 04, 07, 12 |
| [02-runtime-state-cell-annotations.md](./02-runtime-state-cell-annotations.md) | Add `cell_annotations` to `RuntimeStateDoc` (Rust + TS bindings) | 08, 09, 11 |
| [03-notebook-metadata-sandbox.md](./03-notebook-metadata-sandbox.md) | Add `metadata.runt.sandbox` schema and read/write paths | 05, 07, 09, 10 |

### Phase 1 — Daemon core integration (sequential within phase, blocks Phase 2)

| File | What it does | Depends on |
|---|---|---|
| [04-nono-process-supervisor.md](./04-nono-process-supervisor.md) | Two-PID lifecycle: spawn nono, find kernel grandchild, manage signals | 01 |
| [05-profile-translator.md](./05-profile-translator.md) | Convert notebook `metadata.runt.sandbox` → nono profile YAML temp file | 03 |
| [06-stderr-and-audit-tail.md](./06-stderr-and-audit-tail.md) | Parse `-vv` stderr, locate and tail `~/.nono/audit/<id>/audit-events.ndjson` | 04 |
| [07-launch-kernel-integration.md](./07-launch-kernel-integration.md) | Wire 04+05 into the kernel launch path; opt-in by metadata | 04, 05 |
| [08-error-enrichment-pipeline.md](./08-error-enrichment-pipeline.md) | Convert raw signals → `CellAnnotation` → write to `RuntimeStateDoc` | 02, 06, 07 |

### Phase 2 — Surfaces (parallel after Phase 1 lands)

| File | What it does | Depends on |
|---|---|---|
| [09-mcp-tools.md](./09-mcp-tools.md) | `list_credentials`, `set_notebook_sandbox_profile`, `get_sandbox_status` MCP tools; surface annotations in execution results | 02, 03 |
| [10-ui-credential-manager.md](./10-ui-credential-manager.md) | UI for managing keychain credentials and authoring notebook profiles | 03 |
| [11-ui-sandbox-status-and-annotations.md](./11-ui-sandbox-status-and-annotations.md) | Sandbox badge, annotation overlays in cells, degraded-state toast | 02 |

### Phase 3 — Validation

| File | What it does | Depends on |
|---|---|---|
| [12-end-to-end-tests.md](./12-end-to-end-tests.md) | E2E tests covering all four error scenarios + happy path | All Phase 1 + 2 |

## Coordination contracts

Tasks communicate **only** through these named artifacts. If a task in Phase 2 needs a behavior not produced by Phase 1, file a separate coordination issue — do not modify another task's territory.

| Producer task | Artifact | Consumer tasks |
|---|---|---|
| 01 | `nono` binary at a known path; helper `runtimed::nono::binary_path()` | 04, 07, 12 |
| 02 | `RuntimeStateDoc::set_cell_annotation()`, TS `CellAnnotation` type | 08, 09, 11 |
| 03 | `RuntMetadata::sandbox` field; `SandboxProfile` Rust struct | 05, 07, 09, 10 |
| 04 | `runtimed::nono::Supervisor` (spawn, monitor, signal both PIDs) | 06, 07 |
| 05 | `runtimed::nono::profile::write_temp_profile(profile) -> PathBuf` | 07 |
| 06 | `runtimed::nono::events` (typed stream of stderr + audit events) | 08 |
| 07 | Sandbox-aware kernel launch in `jupyter_kernel.rs` | 08, 12 |
| 08 | `CellAnnotation` written to `RuntimeStateDoc` for sandbox events | 09, 11, 12 |

## Out of scope for this entire effort

These are explicitly deferred and must not be implemented in any task below:

- Filesystem sandboxing (only network proxy + credentials in MVP)
- Real-time accept/reject prompts for novel domains
- Agent-driven sandbox expansion at runtime
- Workspace-level or global profiles (only per-notebook in MVP)
- Windows support (nono is macOS/Linux only)
- Audit log Merkle integrity verification surfaced in UI
- Dynamic credential rotation in a running kernel session
- Multi-machine deployments (daemon and kernel assumed co-located)
- Deno/JavaScript kernels (Python only in MVP)

If a task description appears to require any of the above, stop and ask — it is a scoping bug.
