---
name: releasing
description: Release and version the project. Only invoke manually.
disable-model-invocation: true
---

# Releasing

## Version Scheme

Published desktop, CLI, daemon, and `runtimed` Python artifacts share the same
base version. Python release jobs stamp the wheel version from the Rust release
source during the workflow, after `cargo xtask bump` has updated the checked-in
version files.

| Artifact | Version source |
|---|---|
| nteract desktop app | `crates/notebook/tauri.conf.json` |
| `runt` CLI | `crates/runt/Cargo.toml` |
| `runtimed` daemon | `crates/runtimed/Cargo.toml` |
| `runtimed` Python package | `python/runtimed/pyproject.toml`, then stamped from `crates/runt/Cargo.toml` during release |
| `nteract` Python package | `python/nteract/pyproject.toml` |

### Internal Compatibility Markers

Two independent version numbers (incrementing integers, not semver):

- **Protocol version** (`PROTOCOL_VERSION` in `crates/notebook-protocol/src/connection/handshake.rs`, re-exported by `connection.rs`) — Wire compatibility. Validated by magic bytes preamble at connection time.
- **Schema version** (`SCHEMA_VERSION` in `notebook-doc/src/lib.rs`) — Automerge document compatibility. Stored in doc root.

These evolve independently from each other and from the artifact version.

## Bumping Versions

```bash
# Update the checked-in release sources to the same version:
#   crates/runtimed/Cargo.toml
#   crates/runt/Cargo.toml
#   crates/notebook/Cargo.toml
#   crates/notebook/tauri.conf.json
#   python/runtimed/pyproject.toml
#   python/nteract/pyproject.toml

# Then let Cargo.lock catch up:
cargo check
```

Commit the version bump, then tag to trigger the release.

## Release Types

### Stable Release

```bash
git tag v2.1.0
git push origin v2.1.0
```

Triggers `release-stable.yml` which:
1. Builds desktop app (macOS, Windows, Linux)
2. Builds `runt` CLI binaries
3. Builds Python wheels stamped to the base version from `crates/runt/Cargo.toml`
4. Publishes `runtimed` wheels to PyPI (stable)
5. Creates GitHub Release with all artifacts
6. Updates `stable-latest` Tauri updater channel
7. Posts to Discord

### Nightly Release

Runs automatically at 9am UTC daily via `release-nightly.yml`, or manually via workflow dispatch.

- Desktop version gets `-nightly.{timestamp}` suffix
- Python wheels get alpha stamp: `2.0.1a202507150900` (PEP 440)
- App branded "nteract Nightly" with separate bundle ID
- GitHub Release marked as prerelease
- CLI binary named `runt-nightly`

Install nightly Python: `pip install runtimed --pre`

### Python Release Policy

`runtimed` Python wheels ship from the stable and nightly release workflows.
Nightly builds stamp the next patch alpha version (PEP 440), and stable builds
stamp the base version from `crates/runt/Cargo.toml`. `cargo xtask bump` still
updates `python/runtimed/pyproject.toml`; workflow stamping is a guardrail so a
stale pyproject cannot publish the wrong wheel version.

## Tag Reference

| Tag pattern | Workflow | What it publishes |
|---|---|---|
| `v*` | `release-stable.yml` | Desktop app + CLI + `runtimed` Python (stable) |
| _(cron)_ | `release-nightly.yml` | Desktop app + CLI + `runtimed` Python (pre-release) |

## Protocol Version Change Procedure

1. Bump `PROTOCOL_VERSION` in `crates/notebook-protocol/src/connection/handshake.rs`
2. Update the `PROTOCOL_V*` string constant if the version string changes
3. Update `crates/notebook-wire/AGENTS.md`
4. Decide version bump type based on user impact

Magic bytes preamble rejects mismatched protocol versions at wire level, before JSON parsing.

## Schema Version Change Procedure

1. Bump `SCHEMA_VERSION` in `crates/notebook-doc/src/lib.rs`
2. Add migration logic in daemon's doc loading path (detect old schema, convert in-place)
3. Update document schema comment in `notebook-doc/src/lib.rs`

Schema changes don't require a protocol bump — wire format for sync frames stays the same.

## CI Internals

`release-common.yml` accepts inputs:
- `github_release_prerelease: true` — applies PEP 440 alpha stamp to Python version
- `github_release_prerelease: false` — stamps Python version from `crates/runt/Cargo.toml`

Python wheels are always built (macOS arm64, macOS x64, Linux x64, Windows x64) and published.

Desktop version: `{runt version}-{suffix}.{timestamp}` stamped into `tauri.conf.json` and `Cargo.toml` at build time (not committed).

### Trusted Publishing

PyPI uses OIDC trusted publishing (no API tokens). GitHub Actions workflow identity registered as trusted publisher on PyPI for `runtimed` package.

## Pre-Release Checklist

- [ ] All version sources bumped and in sync
- [ ] `cargo check` passes (Cargo.lock updated)
- [ ] `PROTOCOL_VERSION` and `SCHEMA_VERSION` correct for this release
- [ ] CI is green on `main`
- [ ] Changelog-worthy items use conventional commit prefixes (`feat`, `fix`, `perf`)
