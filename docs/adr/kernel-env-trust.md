# Kernel Environment Trust Model

**Status:** Draft, 2026-05-23.

## Related ADRs

- `docs/adr/typed-frame-v4-wire-protocol.md` - wire shape for sync and request frames that carry trust signals.
- `docs/adr/document-split.md` - NotebookDoc carries the dependency declaration; RuntimeStateDoc carries the resolved trust state.
- `docs/adr/execution-pipeline.md` - kernel launch is the gate this ADR guards.
- `docs/adr/blob-storage-and-content-addressing.md` - parallel content-addressed scheme for environments lives alongside the blob CAS.
- `docs/adr/captured-environment-lifecycle.md` - captured env identity, cache repair, launch retry, and manual reset. This ADR decides whether dependency installation is allowed; the lifecycle ADR decides how an allowed captured env is materialized and repaired.
- `docs/adr/identity-and-trust.md` - room-level identity and ACLs. This ADR sits underneath it: env trust decides whether a kernel can launch with a given dependency list, regardless of who is in the room.

## Context

A notebook can declare arbitrary package dependencies in `metadata.runt.{uv,conda,pixi}`. Opening the notebook and clicking "Run" is enough to make the daemon resolve and install those packages into a real environment, then spawn a kernel inside that environment with full OS permissions. Dependency lists are therefore a supply-chain attack surface: any notebook shared by email, pulled from GitHub, or received via MCP can ship arbitrary `pip install`-equivalent payloads inside a metadata field.

The room-level identity model (`docs/adr/identity-and-trust.md`) closes one direction of that surface: it gates *who* can edit a room and *who* can ask the daemon to launch a kernel in it. It does not gate *what packages* the daemon agrees to install. A legitimate room owner can still ask for a kernel built from a hostile dep list. Environment trust is the second gate, sitting underneath room trust, deciding whether the daemon will materialise an environment from a given declared dep set.

The constraints that shaped the design:

- **Trust is local.** A package that one user has reviewed on their laptop is not approved on someone else's laptop. Shared notebooks must be untrusted on the recipient's machine until that recipient consents.
- **Trust is per-package, not per-notebook.** Once a user has agreed to install `pandas`, every future notebook that wants `pandas` should be silent. Re-prompting per notebook trains people to click through.
- **Trust persists across sessions.** The decision survives daemon restarts and notebook close/reopen.
- **Source identity matters for Conda.** "Pandas from conda-forge" is not the same supply-chain decision as "Pandas from an arbitrary URL". Channel approval is its own identity.
- **The notebook doc itself is not the source of truth.** A field like "this notebook is trusted" written into NotebookDoc would replicate across peers; one editor approving on their machine would silently approve the same notebook on every other machine. The trust signal has to live outside the synced document.
- **Identity is deliberately out of scope.** `kernel-env` knows what to install; it does not know who is asking. Linking environments to user identity (e.g., "trust this env only when quill is the room owner") is a future overlay on top of the room ACL, not part of this trust model.

## Decision 1: Capture is structural, not authoritative

`kernel-env` (`crates/kernel-env/src/`) is the layer that turns a declared dependency list into a working interpreter. Its surface is structural:

- `UvDependencies`, `CondaDependencies`, `pixi::*` - parsed dep specs with optional pins, channels, and Python version.
- `kernel_env::uv::compute_unified_env_hash` and `kernel_env::conda::compute_unified_env_hash` - two ecosystem-specific functions (`crates/kernel-env/src/uv.rs:94`, `crates/kernel-env/src/conda.rs:99`). Each is sha256 over sorted deps + resolver fields + per-notebook `env_id`, truncated to 16 hex chars. These are the *unified* hash used by the captured-deps reopen path; the live `prepare_environment_in` cache path still uses the legacy `compute_env_hash` until callers are migrated (commented intent in `uv.rs:80-93`).
- `prepare_environment`, `prepare_environment_in` - install into a cache path keyed by the per-ecosystem env hash.
- `UV_BASE_PACKAGES` (`crates/kernel-env/src/uv.rs:71`) and `CONDA_BASE_PACKAGES` (`crates/kernel-env/src/conda.rs:57`) - two distinct constant sets:
  - UV: `ipykernel`, `ipywidgets`, `anywidget`, `nbformat`, `pyarrow>=14`, `uv`.
  - Conda: `ipykernel`, `ipywidgets`, `anywidget`, `pip`, `nbformat`, `pyarrow>=14`. Includes `pip`, omits `uv`.
- `strip_base(installed, base)` - inverse function used at capture time to derive the user-intent dep set from a pool env's full install list.

What `kernel-env` deliberately does not capture:

- **No user identity.** No `principal`, no `user_id`, no room URI. An env hash is the same value regardless of which authenticated peer asked for it.
- **No room scope.** The hash is per-notebook (via `env_id`) but not per-room. Two clones of the same notebook in two different rooms share an env on the local cache when their `env_id` matches.
- **No trust verdict.** `prepare_environment` will install whatever it is asked to install. The decision to call it is upstream.

This separation matters: if `kernel-env` carried identity or trust, every consumer (pool warmer, capture step, cache lookup, hot-sync) would have to pass identity through. Keeping it identity-blind lets the same crate serve the daemon, the desktop app's setup wizard, and any future tool that wants to materialise an env without learning the trust model.

The trust gate lives one layer up, in `runtimed`. `kernel-env` is what gets called once the gate clears.

## Decision 2: Trust is an SQLite allowlist of normalized package identities

The authoritative trust store is a per-machine SQLite file at `runt_workspace::daemon_base_dir().join("trusted-packages.sqlite")` (`crates/runtimed/src/lib.rs:69`). Channel-aware: stable channel writes under `runt/`, nightly under `runt-nightly/`, dev worktree under `runt/worktrees/{hash}/`.

The schema (`crates/runtimed/src/trusted_packages.rs:37-43`):

```sql
CREATE TABLE trusted_packages (
    ecosystem TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (ecosystem, normalized_name)
)
```

Four ecosystems are tracked: `pypi`, `conda`, `conda-channel`, `pixi-channel`. PyPI and Conda packages share a name namespace per ecosystem; channels are tracked as their own ecosystem rows so that approving `pandas` from conda-forge does not silently approve `pandas` from `http://evil.example`.

`normalized_name` collapses spec variants to a single key:

- Strip env-marker tail (`; python_version >= '3.11'`).
- Strip channel prefix (`conda-forge::numpy` -> `numpy`).
- Strip URL form (`requests @ https://...` -> `requests`).
- Strip extras and version operators (`requests[security]>=2` -> `requests`).
- Lowercase, collapse `-`/`_`/`.` runs to a single `-`.

These rules apply to **package** identities (the `pypi`, `conda` ecosystems, plus the pixi-pypi / pixi-conda mapping below). Channel identities (`conda-channel`, `pixi-channel`) are only `trim()`ed — case and separators are preserved (`trusted_packages.rs:278`). `conda-forge` and `Conda-Forge` are distinct channel rows; rename collisions matter at the channel layer in a way they do not for packages.

The result is that the user approves `pandas` once and is covered for `pandas>=2`, `pandas[performance]`, `Pandas`, `pandas==2.1.0`, etc. The store is keyed by identity, not by spec.

Pixi cross-ecosystem mapping: Pixi notebooks declare both conda-style and PyPI-style deps. The conda-style ones are recorded under the `conda` ecosystem; the PyPI-style ones under `pypi` (`trusted_packages.rs:243-244`). So approving `pandas` from a UV notebook *does* satisfy a Pixi notebook's `pypi` `pandas`; approving `pandas` from a Conda notebook also satisfies a Pixi notebook's `conda` `pandas`. The four ecosystem rows are the SQLite schema; the trust-namespace shape is closer to three (`pypi`, `conda`, plus channels).

Filesystem hardening on Unix: the parent directory is created with mode `0o700` if the daemon created it, and the SQLite file itself is `chmod 0o600`. On Windows the file gets a DACL granting `SYSTEM`, the local admins group, and the owner. The store is owner-only.

### Fail-closed when the store is unavailable

`TrustedPackageStore::unavailable(reason)` is the disk-failure or schema-mismatch path. Two distinct failure modes:

- `add_from_info` on an unavailable store returns an error. The trust dialog handler propagates that error to the client; the dialog does not return success while the allowlist silently stayed empty.
- `all_dependencies_approved` on an unavailable store returns `Ok(false)`. Notebooks with deps stay `Untrusted`.

The daemon does not crash on store failure. It logs the reason once at startup via `log_store_unavailable` and keeps running; kernels with deps simply cannot launch until the store is back.

## Decision 3: Three trust states, finalized at metadata snapshot time

`runt_trust::TrustStatus` has exactly three values (`crates/runt-trust/src/lib.rs:20-32`):

- `NoDependencies` - the notebook declares no UV, Conda, or Pixi deps. There is nothing to install, so the trust gate is satisfied by definition.
- `Trusted` - every dep name and every channel in the declared lists is present in the local allowlist.
- `Untrusted` - at least one name or channel is missing, or the allowlist could not be queried.

There is no `NeedsApproval` variant on `TrustStatus`. From the daemon's point of view, "the user has not approved this yet" and "the user has actively rejected this" are the same condition: deps are not in the allowlist. The frontend renders the same approval dialog in both cases; declining the dialog is the absence of an `ApproveTrust` request, not a recorded `Rejected` row.

The "needs approval" concept does exist as a **derived projection** on the persisted runtime-state, not as a separate enum state. `TrustRuntimeState.needs_approval` is a `bool` field on `RuntimeStateDoc.trust` (`crates/runtime-doc/src/doc.rs:244`), written by the daemon as `trust_needs_approval(&status)` = `!matches!(status, Trusted | NoDependencies)` (`metadata.rs:31, :84`). Persisted, but derived. The frontend reads `needs_approval` directly; it does not re-evaluate the enum.

Trust is finalized by `finalize_trust_status(info, store)` in `crates/runtimed/src/notebook_sync_server/metadata.rs`:

1. If `info.status == NoDependencies`, return `NoDependencies`.
2. Otherwise ask the store `all_dependencies_approved(info)`:
   - `Ok(true)` -> `Trusted`.
   - `Ok(false)` -> `Untrusted`.
   - `Err(_)` -> log a warn and return `Untrusted`. Fail-closed.

The flow from declaration to verdict (the actual call order, `metadata.rs:1291`+):

1. `runt_trust::extract_trust_info(metadata)` reads `metadata.runt.{uv,conda,pixi}` (with legacy `metadata.uv`/`metadata.conda` fallback) and returns a `TrustInfo` with raw dep lists and a tentative `status`.
2. `trust_state_from_metadata` calls `finalize_trust_status(info, store)` **first** — verdict is computed.
3. `TrustedPackageStore::enrich_info(&mut info)` runs after, populating `approved_*_dependencies` and `approved_*_channels` with the subset that is already approved. These feed UI rendering ("3 of 5 approved").

The order is verdict-then-enrichment, not enrichment-then-verdict. The two halves are independent: enrichment is purely for the UI surface; the verdict is what the launch gate consults.

The verdict is cached on the room (`room.trust_state: RwLock<TrustState>`) and re-derived on every notebook sync message via `check_and_update_trust_state` (`metadata.rs:992`). Whenever the verdict changes, the daemon writes a `TrustRuntimeState` into RuntimeStateDoc.

## Decision 4: Trust propagates to clients through RuntimeStateDoc

The trust state is not a NotebookDoc field. NotebookDoc carries the dep *declaration* (`metadata.runt.uv.dependencies` etc.), which is by definition shared and replicated. The *verdict* lives in RuntimeStateDoc as `TrustRuntimeState` (`crates/runtime-doc/src/doc.rs:240`):

```rust
pub struct TrustRuntimeState {
    pub status: String,                  // "trusted", "untrusted", "no_dependencies"
    pub needs_approval: bool,            // UI flag to surface the approval dialog
    pub approved_uv_dependencies: Vec<String>,
    pub approved_conda_dependencies: Vec<String>,
    pub approved_conda_channels: Vec<String>,
    pub approved_pixi_dependencies: Vec<String>,
    pub approved_pixi_pypi_dependencies: Vec<String>,
    pub approved_pixi_channels: Vec<String>,
}
```

RuntimeStateDoc is the per-room runtime view for the local daemon topology. Two
local consequences:

1. **Different peers see different verdicts.** Each daemon (each machine) owns its own RuntimeStateDoc for the room. A user on machine A who has approved `pandas` will see `status: trusted`; a user on machine B who has not will see `status: untrusted`. The two RuntimeStateDocs are not synced across machines; only the local daemon writes its own.
2. **Frontend never re-derives.** The UI reads `runtime_state.trust` and decides whether to render the approval dialog. The `needs_approval` flag is precomputed by the daemon as `!matches!(status, Trusted | NoDependencies)`. Frontend logic is "if needs_approval, open dialog; else proceed."

The `approved_*` fields are diagnostic: they let the dialog render "you have already approved 3 of these 5 packages" without the frontend having to query the store itself. The frontend has no SQLite access; everything it knows about the allowlist arrives through RuntimeStateDoc.

Hosted rooms use the same projection shape but a different authority path. The
room host owns the shared runtime/trust projection for the hosted notebook, and
runtime peers may write only the policy-limited runtime/output surface. Local
per-machine allowlists remain daemon-owned; a hosted deployment must decide how
room-host trust, remote credentials, and local desktop approvals compose before
letting a peer mutate trust or environment state.

## Decision 5: Approval is a NotebookRequest, not a doc mutation

The approval surface is the `NotebookRequest::ApproveTrust` RPC (`crates/runtimed/src/requests/approve_trust.rs`). The handler:

1. Reads the current NotebookDoc metadata snapshot.
2. If the caller passed `observed_heads`, validates that the dep list at those heads matches the current dep list. This prevents the "I approved a different set of deps than what is in the doc now" race when a collaborator edits deps while the dialog is open. Mismatch yields `GuardRejected { reason: "Dependencies changed while the trust dialog was open. Review before approving." }`.
3. Calls `TrustedPackageStore::add_from_info(&info, "trust_dialog")`. This inserts the normalized identities; existing rows have their `approved_at` and `source` columns updated via `ON CONFLICT DO UPDATE` (`trusted_packages.rs:99-101`).
4. Broadcasts a sync state change and calls `check_and_update_trust_state(room)` so the new verdict lands in RuntimeStateDoc immediately.

Not every approval entry point runs all four steps. The four sources in the store are `trust_dialog`, `daemon-default`, `mcp_create_notebook`, `project_env_dialog`. The differences:

| Entry | Allowlist write | Broadcast / recheck | Conflict policy |
|---|---|---|---|
| `ApproveTrust` (dialog) | yes | yes | `ON CONFLICT DO UPDATE` |
| `seed_trust_from_doc_metadata` (MCP) | yes | yes (via subsequent notebook-doc frame) | `ON CONFLICT DO UPDATE` |
| `seed_defaults` (startup) | yes, scoped to `pypi` and `conda` only (not channels) | no (no room exists at startup) | `ON CONFLICT DO NOTHING` so user approvals are preserved (`trusted_packages.rs:171`) |
| `ApproveProjectEnvironment` (`environment.yml`) | yes | **no broadcast, no recheck** (`approve_project_environment.rs:38`) | `ON CONFLICT DO UPDATE` |

`ApproveProjectEnvironment` not triggering a recheck means the user has to send a subsequent sync-driving action (cell edit, refresh) before the verdict updates. Worth flagging.

The notebook doc is not mutated. The allowlist is the source of truth; the doc only declares what is wanted. Two implications:

- Approval on machine A does not propagate to machine B via Automerge sync. There is nothing to sync; the allowlist write was local SQLite.
- "Un-approving" is not a user-facing operation in v1. Removing a row from the allowlist would require either a separate request or direct SQLite editing. The user-facing reset is "delete the SQLite file" or a future "manage trusted packages" surface.

Three other approval entry points exist alongside the dialog:

- `seed_trust_from_doc_metadata(room, source)` - the daemon seeds the allowlist when the caller is asserting that the deps already in the doc came from a consent-bearing channel. The MCP `create_notebook` tool uses this when the user has explicitly passed `dependencies` to the tool call: the act of typing those deps into the prompt is the consent. The same path is used by other paths that synthesize a notebook with known-good deps.
- `seed_defaults(ecosystem, specs)` - the daemon pre-approves a user-configured default set on startup (`pandas`, `matplotlib`, etc., from synced settings). Source column reads `daemon-default`. This is what makes "open a fresh notebook, run a cell" silent for the user's curated default set.
- `ApproveProjectEnvironment` - separate request for project-file consent (`crates/runtimed/src/requests/approve_project_environment.rs`). Records the *project file's* declared deps (today: only `environment.yml`) into the allowlist with source `project_env_dialog`. This is its own dialog because the deps in a project file are not in NotebookDoc; the regular trust dialog can't see them.

## Decision 6: Kernel launch consults the trust gate; sync_environment also gates

`launch_kernel::handle` (`crates/runtimed/src/requests/launch_kernel.rs:51`) starts with:

```rust
if let Err(rejection) = guarded::ensure_trusted(room).await {
    return rejection.into_response();
}
```

`ensure_trusted` (`crates/runtimed/src/requests/guarded.rs:26`) re-runs `check_and_update_trust_state` to pick up any concurrent dep edits and then reads `room.trust_state`. Pass condition is `status in {Trusted, NoDependencies}`. On rejection it returns `GuardRejected { reason: "Trust changed before the action could run. Review the notebook again." }`.

`sync_environment::handle` uses the same gate plus an extra observed-heads check: hot-syncing packages mid-session also requires trust, and a stale `observed_heads` field gets `"Dependencies changed while the trust dialog was open. Review before syncing."`.

Auto-launch paths (the daemon launching a kernel on its own when a notebook opens with deps already declared and approved) also consult the same verdict before any solver runs. Several call sites in `metadata.rs` (e.g., `trust_allows_auto_launch_error_publish`) explicitly suppress auto-launch error publication when trust no longer allows launch, so a deps-changed-mid-launch race does not leave a misleading "environment prepare failed" banner.

There is no separate trust check at `prepare_environment` time inside `kernel-env`. The crate's contract is "the caller has already decided; install what I tell you to install." Sneaking around the launch handler to call `prepare_environment` directly would bypass the gate, but no daemon path does this; the pool warmer installs only base packages plus the user's `default_packages` (which are auto-approved by `seed_defaults`).

## Decision 7: Dep changes invalidate trust automatically

Trust is a function of the current declared deps. If the dep list changes:

1. `check_and_update_trust_state` runs on the next sync message (any peer authoring a NotebookDoc change triggers it via `peer_notebook_sync.rs:112`).
2. `extract_trust_info` produces a new `TrustInfo` with the new deps.
3. `finalize_trust_status` rechecks every name and channel. If any new name is not in the allowlist, the verdict flips from `Trusted` to `Untrusted`.
4. `write_trust_to_runtime_state` updates RuntimeStateDoc; the frontend's `needs_approval` flag flips and the dialog reappears.

This is the right default because adding `requests` to a previously-trusted `pandas`-only notebook is a *new* supply-chain decision. The user needs to see and approve the new dep. Removing deps does not flip trust; a strict subset of approved names stays approved.

The hot-sync flow at room eviction (the daemon flushing post-launch deps that were added via `sync_environment` mid-session back into metadata) preserves this property: by the time the doc is saved and the deps are reflected in metadata, the user has already approved those deps via `sync_environment`, so the next reopen finds `Trusted` again.

## Decision 8: Environment cache identity is independent of trust

The cache-path hash is content-addressed: same deps + same `env_id` -> same path on disk. Today the live `prepare_environment_in` path uses the legacy `compute_env_hash` (see Decision 1); the newer `compute_unified_env_hash` flows through the captured-deps reopen path. Trust does not participate in either hash.

This is deliberate. A trusted env and an untrusted env with the same dep set are byte-identical on disk; deduplicating them by hash saves space and avoids two prepare runs of the same packages. Trust gates the *act of preparing or launching*, not the *storage layout*. The result: a user on machine A who approves `pandas` and a user on machine B who has not yet approved `pandas` end up with the same hash if they ever do approve. Re-approval does not invalidate the on-disk env.

The corollary: rotating the allowlist (removing approvals) does not delete cached envs. That is a separate GC concern handled by `kernel-env::gc`, which has its own age-based and pressure-based policies independent of trust.

## Worked examples

### Quill approves pandas for the first time

1. Quill opens `analysis.ipynb`, which declares `metadata.runt.uv.dependencies = ["pandas"]`.
2. Daemon reads metadata, calls `extract_trust_info` -> `{uv_dependencies: ["pandas"], status: Untrusted}`.
3. `finalize_trust_status` asks `store.all_dependencies_approved(info)`. No `pypi/pandas` row -> `Untrusted`.
4. Daemon writes `TrustRuntimeState { status: "untrusted", needs_approval: true, ... }` into RuntimeStateDoc.
5. Frontend reads `runtime_state.trust.needs_approval` and renders the approval dialog with the dep list.
6. Quill clicks "Approve". Frontend sends `NotebookRequest::ApproveTrust { observed_heads: <current> }`.
7. Handler validates heads, calls `store.add_from_info(info, "trust_dialog")`. Row `(pypi, pandas, <now>, trust_dialog)` is inserted.
8. Handler calls `check_and_update_trust_state` -> `Trusted`. RuntimeStateDoc updates.
9. Frontend dismisses the dialog, runs the cell. `LaunchKernel` passes `ensure_trusted` and proceeds.

### Quill shares the same notebook with Brian

1. Brian opens the same `.ipynb` on his laptop. Different SQLite store; no `pypi/pandas` row.
2. Daemon on Brian's machine writes `TrustRuntimeState { status: "untrusted", needs_approval: true }`.
3. Brian sees the dialog. He has not made the same supply-chain decision Quill made.
4. He clicks "Approve". His allowlist now also has `pypi/pandas`.

The notebook doc is unchanged. There is no field that says "this notebook is trusted." Trust is a property of (recipient machine, dep set), not of the notebook itself.

### A collaborator adds requests mid-session

1. Notebook is in `Trusted` state on Quill's machine (`pandas` approved).
2. Brian, working in the same Anaconda-hosted room as a collaborator, adds `requests` to the dep list.
3. The CRDT change syncs to Quill's daemon.
4. `peer_notebook_sync.rs` handler calls `check_and_update_trust_state`.
5. `extract_trust_info` -> `{uv_dependencies: ["pandas", "requests"], status: Untrusted}`.
6. `finalize_trust_status` -> `pandas` is approved, `requests` is not -> `Untrusted`.
7. RuntimeStateDoc updates. The frontend re-shows the dialog with `requests` highlighted as the unapproved one.
8. Until Quill approves, `LaunchKernel` fails the `ensure_trusted` gate.

### MCP create_notebook with explicit dependencies

1. Claude calls `create_notebook(path, dependencies=["polars"])` via MCP.
2. The user explicitly typed `polars` into the prompt. That typing is the consent.
3. The daemon creates the notebook with `metadata.runt.uv.dependencies = ["polars"]`, then calls `seed_trust_from_doc_metadata(room, "mcp_create_notebook")`. The allowlist now has `(pypi, polars, ..., mcp_create_notebook)`.
4. First sync message triggers `check_and_update_trust_state` -> `Trusted`.
5. Auto-launch proceeds. No dialog appears.

If Claude later asks `manage_dependencies(add=["requests"])`, the same MCP-level consent argument applies and the same seeding path runs for `requests`.

### environment.yml that needs building

1. Notebook lives in a directory with `environment.yml` declaring `pandas` from `conda-forge`. The named conda env does not exist on disk yet.
2. Daemon detects this in `missing_conda_env_yml_decision` -> non-`None`.
3. Frontend shows a "build this env" dialog with the `conda env create -p ... -f ...` command and the dep list from the YAML.
4. User clicks "Approve and build". Frontend sends `ApproveProjectEnvironment { project_file_path }`.
5. Handler parses the YAML, calls `environment_yml_trust_info(&config)`, and inserts the deps+channels into the allowlist with source `project_env_dialog`.
6. Next auto-launch check sees `project_environment_build_approved -> true` and proceeds to build the env.

## Open Questions

1. **Per-version approval.** Today the allowlist is keyed by package *name*. Approving `pandas` covers every version, including future malicious releases. Pinning approval to a version range or a wheel hash is a stronger model but adds significant UX cost (every minor bump re-prompts). Tracked but not decided.
2. **Revocation surface.** v1 has no UI for removing rows from the allowlist. "Untrust this package" requires editing SQLite manually. A management surface (probably under settings) is on the punchlist.
3. **Source attribution for PyPI.** Conda channels are tracked as their own identity; PyPI does not have an equivalent in `extract_trust_info`. If a user starts publishing notebooks that pull from a custom PyPI index (`--index-url`), today the index is not part of the trust identity. The deps would still be name-checked, but the index switch would be invisible. Probably wants a `pypi-index` ecosystem alongside `conda-channel` and `pixi-channel`.
4. **Cross-machine trust sync.** A power-user setup (laptop + desktop + cloud workspace) wants to share an allowlist across machines. The natural shape is a synced settings entry: "trusted packages" as a user-scoped synced doc, with the local SQLite as a cache. Out of scope for v1; tracked.
5. **Identity-scoped trust.** This ADR treats trust as a per-machine question. A future overlay could scope trust to identity: "I have approved `pandas` for myself, but not for an MCP agent acting on my behalf." Pairs with the operator suffix in the identity model. Not v1.
6. **Lockfile-based trust.** A `uv.lock` or `conda-lock.yml` is a stronger statement than a raw dep list: every transitive package and version is pinned. Trust against a lockfile hash (rather than dep names) would close the "approved pandas but pandas pulled a malicious transitive" gap. Open question how to surface that in the dialog without overwhelming the user.
7. **Pre-resolution preview.** The user approves names, but the daemon resolves and installs full transitive trees. Showing the resolved tree before install (so the dialog can warn about surprise transitives) is a UX direction that needs solver cooperation.
8. **Channel ordering.** `conda_channels` is treated as a set today: approving `[conda-forge, defaults]` is the same as `[defaults, conda-forge]`. Channel order affects which copy of a package wins, which is a separate supply-chain decision the current model does not capture.

## Tracked follow-ups (from the retired cleanup punchlist)

These items were migrated from `docs/adr/cleanup-punchlist.md` when it was
retired (2026-06-10). Severity: **Targeted PR** = one-or-two-file fix ready
to implement; **Design** = needs a decision in this ADR before code moves.

- **MSL-2** (Design; `crates/runtimed/src/daemon.rs:1436-1450`): `seed_defaults` seeds startup base packages into `pypi` and `conda` only — not into the channel ecosystems (`conda-channel`, `pixi-channel`). A user with a notebook on a non-default channel will see all channel approvals as fresh prompts even after several uses.
