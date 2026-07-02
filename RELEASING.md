# Releasing

## Release Streams

| Stream | Tag | Trigger | Destination |
|--------|-----|---------|-------------|
| **Stable** | `v{version}-stable.{timestamp}` | Tag push (`v*`) or manual | GitHub Releases |
| **Nightly** | `v{version}-nightly.{timestamp}` | Cron (daily, 24h cadence) or manual | GitHub Pre-releases |
| **runtimed Python package** | same as stable/nightly | Stable/nightly release workflow | PyPI + GitHub Releases |
| **npm packages** | same commit as stable | Successful stable release or manual | npm |

Timestamps are UTC in `YYYYMMDDHHMM` format, e.g. `v2.0.0-stable.202507010900`.

## Desktop App (nteract)

The desktop app, `runt` CLI, and `runtimed` daemon are all built and released together via reusable workflow `.github/workflows/release-common.yml`, invoked by `.github/workflows/release-stable.yml` and `.github/workflows/release-nightly.yml`.

Stable releases run when a `v*` tag is pushed (or manually), and nightly pre-releases run every 24 hours. Both can also be triggered manually.

> **Note:** Desktop releases also build `runtimed` Python wheels and publish them to PyPI via trusted publishing. Nightly releases publish a unique pre-release version; stable releases publish the base version from `crates/runt/Cargo.toml`. `cargo xtask bump` still bumps `python/runtimed/pyproject.toml`; the release workflow stamps it again inside the ephemeral Actions checkout so PyPI publishing follows the Rust release version even if that file drifts.

### Artifacts

| Platform | File |
|----------|------|
| macOS ARM64 (Apple Silicon) | `nteract-{channel}-darwin-arm64.dmg` |
| macOS x64 (Intel) | `nteract-{channel}-darwin-x64.dmg` |
| macOS ARM64 updater | `nteract-{channel}-darwin-arm64.app.tar.gz` + `.sig` |
| macOS x64 updater | `nteract-{channel}-darwin-x64.app.tar.gz` + `.sig` |
| Windows x64 | `nteract-{channel}-windows-x64.exe` + `.sig` |
| Linux x64 AppImage | `nteract-{channel}-linux-x64.AppImage` + `.sig` |
| Installer script (Linux x64, macOS) | `install-linux-release` |
| CLI (macOS ARM64) | `runt-darwin-arm64` |
| CLI (macOS x64) | `runt-darwin-x64` |
| CLI (Linux x64) | `runt-linux-x64` |
| Standalone daemon (Linux x64) | `runtimed-linux-x64` |
| Standalone MCP server (Linux x64) | `nteract-mcp-linux-x64` |
| Updater manifest | `latest.json` |

macOS builds are signed and notarized. Windows builds use Azure Trusted Signing
via `trusted-signing-cli` and `signtool.exe`. Linux desktop releases publish
AppImage only; DEB/RPM/APT installs are not currently supported because
`runtimed` is a per-user daemon.

Linux users can also install the released AppImage with:

```bash
curl -fsSL https://sh.nteract.io | bash
```

### Crate publishing

Many crates are **not published to crates.io** (`publish = false`), including
`runt`, `runtimed-py`, `mcp-supervisor`, `runt-mcp`, `runt-mcp-proxy`,
`nteract-mcp`, `runtimed-node`, `runt-publish`, `nteract-markdown-engine`,
`nteract-markdown-wasm`, `sift-wasm`, and `xtask`. Check `Cargo.toml` for the
current list.

## Published Bindings

The `runtimed` Python package is released by the stable and nightly release workflows.

Nightly builds publish the next patch alpha version, for example `2.4.7a202605082121`, and stable builds publish the checked-in Rust release version, for example `2.4.6`.

The `publish-npm.yml` workflow publishes `@runtimed/node`, its native platform packages, and `@nteract/pi` to npm after a successful stable release. It can also be run manually to fill in missing packages.

## Development

### Building from source

```bash
pnpm install
cargo xtask build
```

### Testing with local library changes

To test against unpublished jupyter-zmq-client/jupyter-protocol changes, add to the root `Cargo.toml`:

```toml
[patch.crates-io]
jupyter-zmq-client = { path = "../runtimed/crates/jupyter-zmq-client" }
jupyter-protocol = { path = "../runtimed/crates/jupyter-protocol" }
```

## Migration from runt-notebook

If you have an older install from before the nteract rebrand:

```bash
# 1. Stop old daemon
launchctl bootout gui/$(id -u)/io.runtimed  # macOS
systemctl --user stop runtimed.service        # Linux

# 2. Remove old service config
rm ~/Library/LaunchAgents/io.runtimed.plist   # macOS

# 3. Remove old settings (optional — recreated with defaults)
rm -rf ~/Library/Application\ Support/runt-notebook  # macOS
rm -rf ~/.config/runt-notebook                        # Linux

# 4. Install nteract — registers the new daemon automatically
```
