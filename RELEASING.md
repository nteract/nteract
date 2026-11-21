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

> **Note:** Desktop releases also build `runtimed` Python wheels and publish them to PyPI via trusted publishing. Nightly releases publish a unique pre-release version, and stable releases publish the base version from `crates/runt/Cargo.toml`. `cargo xtask bump` still updates `python/runtimed/pyproject.toml`, and the release workflow stamps it again inside the ephemeral Actions checkout so PyPI publishing follows the Rust release version even if that file drifts.

### Release source and partial publication

- **Tag reservation:** Before builds start, the version job reserves the timestamped tag at the exact source SHA using `GITHUB_TOKEN`. It never force-pushes a tag. A denied reservation stops the builds, and a failed build can leave a source tag without a release. Never move that tag to repair a run.
- **Changelogs and retries:** Changelog generation excludes unpublished timestamped tags and the current release tag in a disposable checkout, leaving remote tags intact. Excluding the current tag also preserves release notes on a publication retry.
- **Triggers and concurrency:** Token-created tags do not trigger the stable tag-push workflow. Each channel serializes runs with `cancel-in-progress: false` so overlapping runs cannot overwrite each other's assets. GitHub keeps one pending run per channel by default; newer pending requests replace older pending requests without cancelling the active release.
- **GitHub release creation:** After all build and smoke gates pass, publication verifies that the reserved tag still matches the built source. The release uses the existing tag without `target_commitish`, because that field only supplies a commit when creating a missing tag. Passing the old SHA can trigger GitHub's workflow-write restriction if `main` workflows advance during the build (see [GitHub's release API contract](https://docs.github.com/en/rest/releases/releases#create-a-release)). A second tag check runs after GitHub publication.
- **Publication order and partial failures:** PyPI publication runs after GitHub release creation and asset upload, and before updater and plugin publication. This stops a GitHub 403 from publishing Python wheels first. A later PyPI or updater failure still leaves a partial release: keep existing artifacts and inspect the failed step before retrying. PyPI `--check-url` and npm identity checks guard retries, but registries are not a single atomic transaction.

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
| Notebook UI | `nteract-{channel}-notebook-ui.tar.gz` + `.sha256` |
| Updater manifest | `latest.json` |

- **macOS:** Builds are signed and notarized. Standalone `runtimed` assets are published outside the notarized `.app`, so they carry no notarization; an embedding host must sign them under its own identity.
- **Windows:** Builds use Azure Trusted Signing via `trusted-signing-cli` and `signtool.exe`.
- **Linux:** Desktop releases publish AppImage only. DEB, RPM, and APT installs are not supported because `runtimed` is a per-user daemon.

Linux users can also install the released AppImage with:

```bash
curl -fsSL https://sh.nteract.io | bash
```

## Attribution handoff for embedders

Releases ship verified notices and a full dependency inventory with explicit exceptions, rather than withholding every artifact over incomplete upstream material. Missing notice evidence does not mean redistribution is prohibited. The shipped notices and SBOM disclose known gaps; neither claims complete attribution or legal approval.

### Generated files and toolchain

- **Notebook UI archive:** Includes `LICENSE.nteract`, `THIRD_PARTY_NOTICES.txt`, and `sbom.cdx.json`. Its schema-1 manifest adds `license`, `notices`, and `sbom` paths.
- **Standalone daemon targets:** Publish the same three files as adjacent sidecars: `<binary asset>.LICENSE.nteract`, `<binary asset>.THIRD_PARTY_NOTICES.txt`, and `<binary asset>.sbom.cdx.json`. Keep `.exe` before these suffixes on Windows. Nightly daemon names include `runtimed-nightly`; stable names remain `runtimed`.
- **Native `@runtimed/node` tarballs:** Generated from the same release checkout and default-feature `runtimed-node` build as the `.node` file. The three files ship inside each platform tarball, not as external release sidecars. Packing verifies the source commit, npm version, target, and binary hash after installation. Historical sources without attribution support fail explicitly. Publish a new qualified release instead of attaching a newer dependency graph to an older binary; changing a version number alone does not retrofit old binaries.
- **Generation and SBOM scope:** Release jobs generate these files after building, using `cargo-about 0.9.2`, locked target-specific Cargo graphs, and installed pnpm dependencies. Missing or invalid attribution stops packaging. The CycloneDX SBOM is a conservative dependency inventory, not proof of exact linkage or a substitute for license texts and copyright notices.
- **MPL-2.0 (`option-ext@0.2.0`):** Checked native Cargo graphs select `option-ext@0.2.0` under MPL-2.0. Generated notices identify its exact source archive; preserve that source-access information in the host's legal screen or resources. Using an unchanged MPL dependency does not make the host's independent files MPL-licensed, but modifications to covered files require separate attention.
- **ZeroMQ / `win_uds` provenance:** Commit `90bd83bdfe62ff702c10413daa851dea58abcd51` upgraded `jupyter-zmq-client` to 3.0.1 and `zeromq` to 0.7.0, removing the `win_uds` dependency with its Unlicense declaration (already present in Kilo's inspected source pin `cea400364a391f6aee5753bf2a5ef6ea79d2991d`). Partners still need a new qualified artifact release for attribution files; changing a version number alone does not retrofit old binaries.

### Notice exceptions and upstream supplements

Four MIT-declared Plotly dependencies have reviewed, exact-version, digest-bound exceptions: `draw-svg-path@1.0.0`, `array-normalize@1.1.4`, `color-alpha@1.0.4`, and `jison-lex@0.3.4`.

- **Tracking and review:** Exceptions are tracked in [#4858](https://github.com/nteract/nteract/issues/4858) (owned by nteract maintainers, next review `2026-12-05`). Preserve the exception report when consolidating notices for an embedding application. CI warns when a review date is overdue, without silently expiring permission or blocking publication.
- **Maintenance rules:** Obtain upstream clarification covering the released sources or qualify a newer bundle. Do not invent copyright holders from npm author fields. New gaps, changed package versions, and changed artifact hashes require review. Native Node attribution uses a separate Cargo-only graph and does not depend on Plotly.
- **Supplemental notices (`scripts/licenses/`):** Bind reviewed package versions, payloads, and license text with SHA-256. Upgrades that change those inputs require a new review; do not replace a failed digest without checking the upstream license. KaTeX font notices are separate from its JavaScript MIT license, and Vega-Lite adapted utility functions carry their own MIT notices.
- **Maintainer preparation scripts:**
  - `node scripts/prepare-npm-license-supplements.mjs --check` verifies ordinary npm supplements offline after a frozen install and runs in CI under **Release validation**. Omit `--check` to fetch pinned upstream texts.
  - `node scripts/prepare-plotly-attribution.mjs` audits pinned Plotly, Mapbox, and MapLibre source locks, verifies public package archive integrity, and prepares the reviewed supplement.
  - Fetching and preparation modes in both scripts are maintainer steps, not release-time network fallbacks. Every gap needs verified material or an explicit reviewed exception; arbitrary missing material fails. Unit tests do not replace a real attribution run.

### Windows MSVC and SDK terms

Windows MSVC builds statically link Microsoft runtime code. Build and attribution must run in the same activated Visual Studio developer environment, and Windows producer discovery and final packaging require native CI verification.

- **Recorded evidence:** Attribution records producer edition, toolset, SDK, compiler, and static-library hashes. It preserves the Visual Studio and Windows SDK redistribution terms, plus installed `Redist.txt` and `ThirdPartyNotices.txt` as supplemental evidence only (never substitutes for the full grant).
- **Checked-in MSVC terms (`scripts/licenses/msvc*`):** Retain original DOCX files and extracted text with SHA-256 provenance for Visual Studio 2022 Enterprise/Professional 17.14 (MSVC 14.44) and Visual Studio 2026 Enterprise/Professional 18.x (MSVC 14.51). The [published VS2026 terms](https://visualstudio.microsoft.com/license-terms/vs2026-ga-pro-enterprise/) explicitly cover updates and revisions unless different terms apply. Preview builds and other toolset families require review; an edition name alone does not prove a full-use license.
- **SDK fallback (26100 family):** Covers installed product `10.1.26100.*`, library directory `10.0.26100.0`, and x64/arm64 static UCRT. Preserved Microsoft SDK package metadata links to the retained SDK terms, which cover updates unless other terms accompany them. Metadata establishes license applicability, not the origin of installed library bytes. Exact servicing versions and static-library hashes remain in the evidence, so a monthly servicing change alone does not require a new grant. The observed CI runner image manifests report SDK `10.1.26100.9457` ([Windows x64 image](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/Windows2025-VS2026-Readme.md) and [Windows ARM64 image](https://github.com/actions/runner-images/blob/win11-vs2026-arm64/20261101.203/images/windows/Windows11-VS2026-Arm64-Readme.md)); those come from runner documentation rather than registry observations from failed jobs.
- **Precedence and overrides:** Installed terms take precedence. Maintainers must review changed or separately supplied terms (including current published VS2026 terms) before release. Other SDK families require review or matching installed terms. If automatic discovery cannot locate the terms, set `NTERACT_MSVC_LICENSE_FILE` and `NTERACT_WINDOWS_SDK_LICENSE_FILE` to the plain-text terms files. Missing evidence stops Windows attribution. The Microsoft runtime is not BSD-licensed, and preserving these files does not replace reviewing the applicable Microsoft terms and REDIST lists.

### Embedder obligations

Embedding partners must:

- Pin the release and source commit, verify the UI checksum, and keep attribution paired with the exact UI and target-specific daemon they redistribute.
- Ship license and notice texts in an accessible third-party notices location, including when repackaging or signing binaries under their own identity.
- Make corresponding MPL-2.0-covered source (including changes to covered files) available to recipients and explain how to obtain it. Retain exact source versions and review supplied source references before distribution.
- Review their own additions and distribution obligations separately. Downloaded kernels and tools are outside this artifact scope. `@runtimed/node` platform tarballs carry separate binding-specific attribution; daemon notices do not cover the binding. These materials do not establish complete product compliance.

## Crate publishing

Many crates are **not published to crates.io** (`publish = false`), including
`runt`, `runtimed-py`, `mcp-supervisor`, `runt-mcp`, `runt-mcp-proxy`,
`nteract-mcp`, `runtimed-node`, `runt-publish`, `nteract-markdown-engine`,
`nteract-markdown-wasm`, `sift-wasm`, `sift-csv-wasm`, and `xtask`. Check
`Cargo.toml` for the current list.

## Published Bindings

The `runtimed` Python package is released by the stable and nightly release workflows. Nightly builds publish the next patch alpha version (for example, `2.4.7a202605082121`), and stable builds publish the checked-in Rust release version (for example, `2.4.6`).

The `publish-npm.yml` workflow publishes npm packages from the exact source of a successful stable or nightly release:

- **Packages:** `@runtimed/node` and its native platform packages, `@nteract/sift`, `@nteract/sift-csv`, and `@nteract/pi` (stable-only).
- **Versioning and tags:** Stable uses each package's checked-in version under npm's `latest` tag. Nightly uses `<package version>-nightly.<upstream run ID>` under the `nightly` tag.
- **Job isolation:** Sift and Sift CSV pack and publish independently of the Node SDK and of each other, so a native build failure does not hold them back.
- **Manual recovery:** Requires a successful upstream release run ID and attempt. See the [npm publishing runbook](docs/runbooks/npm-publishing.md) for retry behavior, account prerequisites, consumer qualification, and the distinction between package pins and daemon compatibility.

### ARM64 npm bootstrap

Linux and Windows ARM64 npm publication each require a one-time bootstrap. Until a platform's repository variable is `true`, CI builds, tests, and uploads its tarball, but skips publishing it and omits that optional dependency from the published wrapper. Existing npm platforms continue publishing. Desktop, CLI, Python, and agent-plugin ARM64 releases do not use these gates.

| Platform | Package | Repository variable |
|---|---|---|
| Linux ARM64 | `@runtimed/node-linux-arm64-gnu` | `NPM_LINUX_ARM64_ENABLED` |
| Windows ARM64 | `@runtimed/node-win32-arm64-msvc` | `NPM_WINDOWS_ARM64_ENABLED` |

To enable either ARM64 npm platform:

1. Download `npm-package-linux-arm64-gnu` or `npm-package-win32-arm64-msvc` from a successful **Publish npm packages** run for the intended source commit. Inspect the tarball's package name, version, and channel first. Linux bootstrap uses the publisher's audited Ubuntu 22.04 package; the Ubuntu 24.04 **Release validation** artifact is for API smoke testing only.
2. With an authenticated npm maintainer account, run `npm publish <tarball> --tag <latest-or-nightly> --access public`, using `nightly` for a nightly version and `latest` for a stable version. Inspect existing tags first so bootstrap does not move a channel backwards.
3. Configure the package's npm trusted publisher for organization `nteract`, repository `nteract`, workflow `publish-npm.yml`, allowing `npm publish`.
4. Verify the package is readable from npm and its trusted-publisher settings are correct, then set the platform's repository variable to `true`. The next npm release publishes it and adds it to the wrapper. Because npm versions are immutable, if that wrapper version was already published without the platform, use a new successful nightly run or bump the stable package version first.

### Placeholder npm bootstrap (Sift, Sift CSV, and WASM)

npm configures trusted publishers on an existing package, so these packages bootstrap from a code-free `0.0.1` placeholder instead of a CI tarball:

| Package | Repository variable | CI artifact | Status |
|---|---|---|---|
| `@nteract/sift` | `NPM_SIFT_ENABLED` | `npm-package-sift` | Active (`true`); nightlies publish with provenance |
| `@nteract/sift-csv` | `NPM_SIFT_CSV_ENABLED` | `npm-package-sift-csv` | Active (`true`); nightlies publish with provenance |
| `@runtimed/wasm` | `NPM_WASM_ENABLED` | `npm-wasm-<release run ID>-<release attempt>` | Defaults off |

Package-specific notes:

- **Disabled gate behavior:** While a Sift gate is off, CI builds the WASM, runs packed-consumer checks, and uploads the artifact without publishing. Releases from sources without the CSV package skip `@nteract/sift-csv`.
- **`@runtimed/wasm` packaging:** Its separate **Build WASM npm package** workflow packs and tests retained release WASM without recompiling, even while disabled. Successful tarballs are kept for 90 days and reused on publisher retries; expired or deleted candidates require a new release identity. WASM jobs are independent of all other npm jobs. The workflow does not create the placeholder, change npm trust or credentials, or enable its own gate. See the [WASM publishing runbook](docs/runbooks/npm-publishing.md#runtime-wasm) for retry and consumer verification details.

Use these steps when bootstrapping a new package or re-creating a trusted publisher:

1. An org owner (`@nteract` or `@runtimed`) publishes a code-free `<package>@0.0.1` placeholder with `npm publish --access public`. Because `0.0.1` sorts below every version CI publishes, it never blocks or collides with a release.
2. Configure the package's npm trusted publisher for organization `nteract`, repository `nteract`, and workflow `publish-npm.yml`. Leave Environment name blank and allow direct `npm publish` (new configurations default to staged publishing only).
3. Verify the registry package and trusted-publisher settings, then set the repository variable to `true` right away. Complete the first trusted publish within two days of setup under npm's [current setup requirements](https://docs.npmjs.com/trusted-publishers/) by letting the next nightly run or dispatching **Nightly Release**.
4. The first nightly publishes `<version>-nightly.<run ID>` under `nightly`, and the next stable release moves `latest` off `0.0.1`. Once `latest` points to a real version, deprecate the placeholder (for example, `npm deprecate @nteract/sift@0.0.1 "Placeholder with no code; install a real version."`) and check `npm view @nteract/sift dist-tags`.

These bootstrap publications, npm permissions, and trusted-publisher settings require separate maintainer qualification. They are not established by a source change or a local test run.

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

# 3. Remove old settings (optional; recreated with defaults)
rm -rf ~/Library/Application\ Support/runt-notebook  # macOS
rm -rf ~/.config/runt-notebook                        # Linux

# 4. Install nteract (registers the new daemon automatically)
```
