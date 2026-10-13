# Releasing

## Release Streams

| Stream | Tag | Trigger | Destination |
|--------|-----|---------|-------------|
| **Stable** | `v{version}-stable.{timestamp}` | Tag push (`v*`) or manual | GitHub Releases |
| **Nightly** | `v{version}-nightly.{timestamp}` | Cron (daily, 24h cadence) or manual | GitHub Pre-releases |
| **runtimed Python package** | same as stable/nightly | Stable/nightly release workflow | PyPI + GitHub Releases |
| **npm packages** | Each package's checked-in version, or `<version>-nightly.<run ID>` | Successful stable/nightly release or manual recovery | npm (`latest` / `nightly`) |

Timestamps are UTC in `YYYYMMDDHHMM` format, e.g. `v2.0.0-stable.202507010900`.

## Desktop App (nteract)

The desktop app, `runt` CLI, and `runtimed` daemon are all built and released together via reusable workflow `.github/workflows/release-common.yml`, invoked by `.github/workflows/release-stable.yml` and `.github/workflows/release-nightly.yml`.

Stable releases run when a `v*` tag is pushed (or manually), and nightly pre-releases run every 24 hours. Both can also be triggered manually.

> **Note:** Desktop releases also build `runtimed` Python wheels and publish them to PyPI via trusted publishing. Nightly releases publish a unique pre-release version; stable releases publish the base version from `crates/runt/Cargo.toml`. `cargo xtask bump` still bumps `python/runtimed/pyproject.toml`; the release workflow stamps it again inside the ephemeral Actions checkout so PyPI publishing follows the Rust release version even if that file drifts.

### Release source and partial publication

The version job reserves the timestamped tag at the exact source SHA before builds begin, using the workflow's existing `GITHUB_TOKEN`. It never force-pushes a tag. A denied reservation stops the builds; a failed build may leave a source tag without a release. Do not move that tag to repair a run. Changelog generation excludes unpublished timestamped tags and the current release tag from its disposable checkout, leaving remote tags intact. Excluding the current tag also preserves release notes on a publication retry. Token-created tags do not trigger the stable tag-push workflow. Each channel serializes release runs with `cancel-in-progress: false`, so overlapping runs cannot replace each other's assets. GitHub keeps one pending run per channel by default; newer pending requests replace older pending requests without cancelling the active release.

After all build and smoke gates pass, publication requires that reserved tag to still match the built source. The GitHub release uses the existing tag without `target_commitish`: that field only supplies a commit when creating a missing tag. Passing the old SHA can instead invoke GitHub's workflow-write restriction when main's workflows have advanced during the build. See [GitHub's release API contract](https://docs.github.com/en/rest/releases/releases#create-a-release). A second tag check follows GitHub publication.

PyPI publication follows successful GitHub release creation and asset upload, before updater and plugin publication. This prevents a GitHub 403 from publishing Python wheels first. A later PyPI or updater failure still leaves a partial release; preserve existing artifacts and inspect the exact failed step before retrying. The existing PyPI `--check-url` and npm identity checks protect their retry paths. This does not make the registries one atomic transaction.

### Artifacts

| Platform | File |
|----------|------|
| macOS ARM64 (Apple Silicon) | `nteract-{channel}-darwin-arm64.dmg` |
| macOS x64 (Intel) | `nteract-{channel}-darwin-x64.dmg` |
| macOS ARM64 updater | `nteract-{channel}-darwin-arm64.app.tar.gz` + `.sig` |
| macOS x64 updater | `nteract-{channel}-darwin-x64.app.tar.gz` + `.sig` |
| Windows x64 | `nteract-{channel}-windows-x64.exe` + `.sig` |
| Windows ARM64 | `nteract-{channel}-windows-arm64.exe` + `.sig` |
| Linux x64 AppImage | `nteract-{channel}-linux-x64.AppImage` + `.sig` |
| Linux ARM64 AppImage | `nteract-{channel}-linux-arm64.AppImage` + `.sig` |
| Installer script (Linux x64/ARM64, macOS) | `install-linux-release` |
| CLI (macOS ARM64) | `runt-darwin-arm64` |
| CLI (macOS x64) | `runt-darwin-x64` |
| CLI (Linux x64) | `runt-linux-x64`, `nteract-cli-linux-x64` |
| CLI (Linux ARM64) | `runt-linux-arm64`, `nteract-cli-linux-arm64` |
| Standalone daemon (Linux x64) | `runtimed-linux-x64` |
| Standalone daemon (Linux ARM64) | `runtimed-linux-arm64` |
| Standalone daemon (macOS ARM64) | `runtimed-darwin-arm64` |
| Standalone daemon (macOS x64) | `runtimed-darwin-x64` |
| Standalone daemon (Windows x64) | `runtimed-windows-x64.exe` |
| Standalone daemon (Windows ARM64) | `runtimed-windows-arm64.exe` |
| Standalone MCP server (Linux x64) | `nteract-mcp-linux-x64` |
| Standalone MCP server (Linux ARM64) | `nteract-mcp-linux-arm64` |
| Updater manifest | `latest.json` |

macOS builds are signed and notarized. Windows builds use Azure Trusted Signing
via `trusted-signing-cli` and `signtool.exe`. The standalone `runtimed` assets are
an exception: they are published outside the notarized `.app`, so they carry no
notarization. A host embedding one must sign it under its own identity. Linux desktop releases publish
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

The `publish-npm.yml` workflow publishes `@runtimed/node` and its native platform packages, and `@nteract/sift`, from the exact source of a successful stable or nightly release. Stable uses each package's checked-in version and npm's `latest` tag; nightly uses `<package version>-nightly.<upstream run ID>` and the `nightly` tag. `@nteract/pi` remains stable-only. Sift packs and publishes independently of the Node SDK, so a native build failure does not hold it back. Manual recovery requires a successful upstream release run ID and attempt. See the [npm publishing runbook](docs/runbooks/npm-publishing.md) for retry behavior, account prerequisites, consumer qualification, and the distinction between package pins and daemon compatibility.

Linux and Windows ARM64 npm publication each require a one-time bootstrap. Until a platform's repository variable is `true`, CI builds and tests its binding and uploads its tarball, but skips publishing it and omits that optional dependency from the published wrapper. Existing npm platforms continue publishing. Desktop, CLI, Python, and agent-plugin ARM64 releases do not use these gates.

| Platform | Package | Repository variable |
|---|---|---|
| Linux ARM64 | `@runtimed/node-linux-arm64-gnu` | `NPM_LINUX_ARM64_ENABLED` |
| Windows ARM64 | `@runtimed/node-win32-arm64-msvc` | `NPM_WINDOWS_ARM64_ENABLED` |

To enable either ARM64 npm platform:

1. Download `npm-package-linux-arm64-gnu` or `npm-package-win32-arm64-msvc` from a successful **Publish npm packages** run for the intended source commit. Inspect the tarball's package name, version, and channel before publishing. Linux bootstrap uses the publisher's audited Ubuntu 22.04 package; the Ubuntu 24.04 **Release validation** artifact is only for API smoke testing.
2. With an authenticated npm maintainer account, publish that tarball using `npm publish <tarball> --tag <latest-or-nightly> --access public`, selecting `nightly` for a nightly version and `latest` for a stable version. Inspect existing tags first so bootstrap does not move a channel backwards.
3. Configure the package's npm trusted publisher for organization `nteract`, repository `nteract`, workflow `publish-npm.yml`, allowing `npm publish`.
4. Verify the package is readable from the registry and its trusted-publisher settings are correct, then set that platform's variable to `true` in the repository's Actions variables. The next npm release publishes it alongside the other enabled platforms and includes it in the wrapper. If that wrapper version was already published without the platform, use a new successful nightly run or bump the stable package version before releasing; npm versions are immutable.

`@nteract/sift` is gated by the `NPM_SIFT_ENABLED` repository variable. Until it is `true`, CI builds the WASM, runs the packed-consumer checks, and uploads `npm-package-sift`, but does not publish it. npm configures trusted publishers in an existing package's settings, so Sift bootstraps from a placeholder instead of a CI tarball:

1. An `@nteract` owner publishes a code-free `@nteract/sift@0.0.1` with `npm publish --access public`. `0.0.1` sorts below every Sift version CI publishes, so it never blocks or collides with one. Deprecate it once a stable release has moved `latest` to a real version.
2. Configure the trusted publisher as in step 3 above. New configurations default to staged publishing only; allow `npm publish`.
3. Set the variable right away. A new trusted-publisher configuration expires unless it completes a publish within two days. Let the next nightly publish, or dispatch **Nightly Release**.

The first nightly publishes `<Sift version>-nightly.<run ID>` under `nightly`. The next stable release publishes the checked-in Sift version and moves `latest` off the placeholder.

These bootstrap publications, npm permissions, and trusted-publisher settings require separate maintainer qualification. They are not established by the source change or a local test run.

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
