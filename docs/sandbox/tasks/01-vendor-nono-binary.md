# Task 01: Vendor the nono binary

## Framing

The nteract distribution must ship a known-good `nono` binary so users do not need to install it separately. This task adds nono to the build pipeline, sets up binary discovery from the daemon, and ensures it works in development, CI, and packaged releases.

This is foundational — tasks 04, 07, and 12 cannot proceed until the daemon can locate and invoke a vendored `nono` reliably.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-1 (distribution)**, **D-2 (license)**, **D-12, D-13**
- `docs/sandbox/nono-sh-investigation.md` — sections on the CLI and how it's normally distributed
- `docs/sandbox/nono-empirical-tests.md` — the exact CLI surface confirmed via testing

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

- nono.sh is published at `github.com/always-further/nono` under Apache-2.0.
- The CLI binary is published as `nono-cli` on crates.io at version `0.62.0` (as of June 2026).
- nono is **macOS and Linux only** (uses macOS Seatbelt and Linux Landlock). No Windows support.
- The CLI surface is pre-1.0 and may have breaking changes between minor releases.

The MVP only needs the `nono` CLI binary. We are **not** consuming the `nono` or `nono-proxy` Rust crates as Cargo dependencies in this task.

## Technical steps

### 1. Pin a nono version

Pick a single nono version (recommend `0.62.0` or whatever is current at implementation time). Document the version in a top-level location the daemon can read at runtime. Suggested: a constant in `crates/runtimed/src/nono/mod.rs::NONO_VERSION` with a doc comment explaining the empirical truths from `decisions.md` were validated against this version.

### 2. Acquire the binary at build/install time

Pick **one** of these strategies and document the choice in the task PR description:

- **Option A — `cargo install nono-cli` into a vendored bin directory** during `cargo xtask` build steps. Cleanest for development.
- **Option B — Download prebuilt binaries** from nono's GitHub releases for each supported target triple (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`) and check them into a `vendor/nono/<version>/<target>/nono` tree. Best for reproducibility.
- **Option C — Add `nono-cli` as a workspace dev dependency** so `cargo build` produces it in `target/<profile>/nono`. Simplest but only works if the workspace can build it on every supported platform.

The recommendation is **Option A** for development and **Option B** for release packaging. Pick whichever you can implement cleanly and leave a TODO comment if the production path differs.

### 3. Implement binary discovery

Add a module `crates/runtimed/src/nono/mod.rs` with at minimum:

```rust
/// Returns the path to the bundled nono binary.
///
/// Resolution order:
/// 1. NONO_BIN env var (developer override, useful for testing newer nono builds)
/// 2. Bundled location next to the runtimed binary
/// 3. PATH lookup as a last-resort fallback
///
/// Returns NonoUnavailable if no binary is found.
pub fn binary_path() -> Result<PathBuf, NonoUnavailable>;

#[derive(Debug, thiserror::Error)]
#[error("nono binary not found (tried env, bundled, PATH)")]
pub struct NonoUnavailable;
```

The bundled location depends on packaging:
- Tauri app bundle: alongside the runtimed binary in the app's `Resources/` or platform-equivalent
- Headless install: alongside `runtimed` itself
- `cargo xtask dev-daemon`: somewhere predictable in the workspace `target/`

### 4. Smoke-check at daemon startup

Add a one-shot startup check that runs `nono --version` and logs the result. This must **not** fail daemon startup if the binary is missing (sandbox is opt-in per **D-3**); it only logs a warning. The check should:

- Resolve the binary via `binary_path()`
- Run `nono --version` with a 5s timeout
- Compare the reported version against `NONO_VERSION`; warn (not error) on mismatch
- Surface the result through a status field that other tasks can consult

### 5. Ensure CI builds and tests work

- The CI matrix must include macOS and Linux. Skip nono integration tests on Windows.
- Linting and formatting (`cargo xtask lint --fix`) must pass.
- A unit test should verify `binary_path()` resolves correctly when `NONO_BIN` is set.

### 6. Document the bundling for releases

Add a section to `crates/runtimed/AGENTS.md` (or create a NONO.md sibling) explaining how the binary is bundled, where it lives at runtime, and how to override it via `NONO_BIN`.

## Interfaces produced

This task **must** produce:

- `runtimed::nono::binary_path() -> Result<PathBuf, NonoUnavailable>` — public from `crates/runtimed`
- `runtimed::nono::NONO_VERSION: &str`
- A bundled binary that exists in dev (`cargo xtask dev-daemon`) and in release builds
- A documented `NONO_BIN` env var override

These are consumed by tasks 04 and 12 verbatim. Do not change the signatures without coordinating.

## Success criteria

- `cargo xtask dev-daemon` produces a daemon that can locate `nono`
- `runtimed::nono::binary_path()` returns a working path on macOS and Linux
- `nono --version` runs successfully from the resolved path
- `NONO_BIN=/path/to/other/nono` overrides the bundled binary
- Daemon startup logs the nono version (info-level) when found, warning when absent
- `cargo xtask lint --fix` passes
- All existing tests still pass

## In scope

- Pinning a nono version
- Picking and implementing a vendoring strategy
- The `runtimed::nono` module skeleton with binary discovery
- Daemon startup smoke check
- CI updates for macOS + Linux
- Documentation in AGENTS.md

## Out of scope

- Spawning nono as a child process for kernels — that is task 04
- Any logic that reads notebook metadata — that is task 03
- Profile generation — that is task 05
- Anything beyond the binary discovery API: do **not** add `Supervisor`, `events`, `profile` submodules in this task
- Windows support
- Adding `nono` or `nono-proxy` as Rust crate dependencies (we are not using the Rust SDK in MVP per **D-11**)
- Sandbox feature toggle in settings (sandbox is per-notebook opt-in via metadata; see **D-3**)
