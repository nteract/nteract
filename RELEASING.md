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
| Notebook UI | `nteract-{channel}-notebook-ui.tar.gz` + `.sha256` |
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

### Attribution handoff for embedders

Ship verified notices and the full dependency inventory with explicit notice
exceptions, rather than withholding every artifact over incomplete upstream
material. Four MIT-declared Plotly dependencies have reviewed, exact-version,
digest-bound exceptions: `draw-svg-path@1.0.0`, `array-normalize@1.1.4`,
`color-alpha@1.0.4`, and `jison-lex@0.3.4`. Missing notice evidence is not a finding
that redistribution is prohibited. The shipped notices and SBOM disclose these
gaps; neither claims complete attribution or legal approval.

The exceptions are tracked in [#4858](https://github.com/nteract/nteract/issues/4858),
owned by nteract maintainers, with the next review on 2026-12-05. Preserve the
exception report when consolidating notices for an embedding application. CI
warns when a review date is overdue; the date does not silently expire permission
or block publication. Obtain
upstream clarification covering the released sources or qualify a newer bundle.
Do not invent copyright holders from npm author fields. New gaps, changed package
versions, and changed artifact hashes still require review. Native Node attribution
has a separate Cargo-only graph and does not depend on Plotly. Windows producer
discovery and final packaging still require native CI verification.

The notebook UI archive includes `LICENSE.nteract`, `THIRD_PARTY_NOTICES.txt`,
and `sbom.cdx.json`. Its schema-1 manifest adds `license`, `notices`, and `sbom`
paths. Every standalone daemon target publishes the same three files as adjacent
sidecars: `<binary asset>.LICENSE.nteract`, `<binary asset>.THIRD_PARTY_NOTICES.txt`,
and `<binary asset>.sbom.cdx.json`. Keep `.exe` before these suffixes on Windows.
Nightly daemon names include `runtimed-nightly`; stable names remain `runtimed`.

Release jobs generate these materials after building, using cargo-about 0.9.2,
locked target-specific Cargo graphs, and installed pnpm dependencies. Missing or
invalid attribution stops packaging. The CycloneDX SBOM is a conservative
dependency inventory, not proof of exact linkage or a replacement for license
texts and copyright notices.

The checked native Cargo graphs select `option-ext@0.2.0` under MPL-2.0.
Generated notices identify its exact source archive. Preserve that source-access
information when consolidating notices into the host's legal screen or resources.
Using an unchanged MPL dependency does not make the host's independent files
MPL-licensed; modifications to covered files require separate attention.

Supplemental upstream notices live under `scripts/licenses/`. They bind reviewed
package versions, payloads, and license text with SHA-256. Dependency upgrades
that change those inputs require a new review; do not replace a failed digest
without checking the upstream license. KaTeX's font notices are separate from
its JavaScript MIT license. Vega-Lite's adapted utility functions have their own
MIT notices.

`node scripts/prepare-npm-license-supplements.mjs --check` verifies the ordinary
npm supplements offline after a frozen install. The same command without
`--check` retrieves their pinned upstream texts. For Plotly's prebundled code,
`node scripts/prepare-plotly-attribution.mjs` audits the pinned Plotly, Mapbox,
and MapLibre source locks, verifies public package archive integrity, and prepares
the reviewed supplement. This preparation is a maintainer step, not a release-time
network fallback. Every gap must have verified material or an explicit reviewed
exception; arbitrary missing material still fails. Unit tests do not replace a
successful real attribution run.

Windows MSVC builds statically link Microsoft runtime code. Build and attribution
must use the same activated Visual Studio developer environment. Attribution
records the producer edition, toolset, SDK, compiler, and static-library hashes.
It also preserves the producer's Visual Studio and Windows SDK redistribution
terms, plus installed `Redist.txt` and `ThirdPartyNotices.txt` as supplemental
evidence, never as substitutes for the full grant. Checked-in official terms
cover Visual Studio 2022 Enterprise/Professional 17.14 / MSVC 14.44 and
Visual Studio 2026 Enterprise/Professional 18.x / MSVC 14.51. The
[published VS2026 terms](https://visualstudio.microsoft.com/license-terms/vs2026-ga-pro-enterprise/)
explicitly cover updates and revisions unless different terms apply. The original
DOCX and complete extracted text are retained with SHA-256 provenance under
`scripts/licenses/msvc*`. Preview installations and other toolset families require
review; an edition name alone does not prove a valid full-use license.

The SDK fallback covers the reviewed 26100 product family: installed product
`10.1.26100.*`, library directory `10.0.26100.0`, and x64/arm64 static UCRT.
The preserved Microsoft SDK package metadata links to the retained SDK terms,
which expressly cover updates unless other terms accompany them. The package
metadata establishes license applicability, not the origin of the installed
library bytes. Exact detected servicing versions and static-library hashes remain
in the evidence; a monthly servicing change alone does not require a new grant.
The failing CI image manifests report SDK `10.1.26100.9457`:
[Windows x64 image](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/Windows2025-VS2026-Readme.md)
and [Windows ARM64 image](https://github.com/actions/runner-images/blob/win11-vs2026-arm64/20261101.203/images/windows/Windows11-VS2026-Arm64-Readme.md).
These are runner documentation, not registry observations from the failed jobs.

Installed terms take precedence. Maintainers must review changed or separately
supplied terms, including the current published VS2026 terms, before release.
Other SDK families require review or matching installed terms.
If automatic discovery cannot locate those terms, set
`NTERACT_MSVC_LICENSE_FILE` and `NTERACT_WINDOWS_SDK_LICENSE_FILE` to the correct
plain-text terms files. Missing evidence stops Windows attribution. The
Microsoft runtime is not BSD-licensed; preserving these documents does not replace
review of the applicable Microsoft terms and REDIST lists.

Embedding partners must:

- Pin the release and source commit, verify the UI checksum, and retain attribution
  with the exact UI and target-specific daemon they redistribute.
- Ship the license and notice texts in an accessible third-party notices location,
  including when repackaging or signing binaries under their own identity.
- Make corresponding MPL-2.0-covered source, including changes to covered files,
  available to recipients and tell them how to obtain it. Retain exact source
  versions and review the supplied source references before distribution.
- Review their own additions and distribution obligations separately. Downloaded
  kernels/tools are outside this artifact scope. `@runtimed/node` platform tarballs
  carry separate binding-specific attribution; daemon notices do not cover the
  binding. These materials do not establish complete product compliance.

Native npm builders generate attribution from the same release checkout and
default-feature `runtimed-node` build as the `.node` file. The three files are
inside each platform tarball, not external release sidecars. Packing verifies the
source commit, npm version, target, and binary hash after installation. Historical
source without attribution support fails explicitly; use a new qualified release,
not a newer dependency graph attached to an older binary.

The ZeroMQ dependency change is already in source: commit
`90bd83bdfe62ff702c10413daa851dea58abcd51` upgrades `jupyter-zmq-client` to
3.0.1 and `zeromq` to 0.7.0, removing the `win_uds` dependency with its
Unlicense declaration. Kilo's inspected source pin
`cea400364a391f6aee5753bf2a5ef6ea79d2991d` already contains that change.
The partner still needs a new qualified artifact release for the attribution
files; changing a version number alone does not retrofit old binaries.

### Crate publishing

Many crates are **not published to crates.io** (`publish = false`), including
`runt`, `runtimed-py`, `mcp-supervisor`, `runt-mcp`, `runt-mcp-proxy`,
`nteract-mcp`, `runtimed-node`, `runt-publish`, `nteract-markdown-engine`,
`nteract-markdown-wasm`, `sift-wasm`, `sift-csv-wasm`, and `xtask`. Check
`Cargo.toml` for the current list.

## Published Bindings

The `runtimed` Python package is released by the stable and nightly release workflows.

Nightly builds publish the next patch alpha version, for example `2.4.7a202605082121`, and stable builds publish the checked-in Rust release version, for example `2.4.6`.

The `publish-npm.yml` workflow publishes `@runtimed/node` and its native platform packages, `@nteract/sift`, and `@nteract/sift-csv`, from the exact source of a successful stable or nightly release. Stable uses each package's checked-in version and npm's `latest` tag; nightly uses `<package version>-nightly.<upstream run ID>` and the `nightly` tag. `@nteract/pi` remains stable-only. Sift and Sift CSV each pack and publish independently of the Node SDK and of each other, so a native build failure does not hold them back. Manual recovery requires a successful upstream release run ID and attempt. See the [npm publishing runbook](docs/runbooks/npm-publishing.md) for retry behavior, account prerequisites, consumer qualification, and the distinction between package pins and daemon compatibility.

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

The first nightly publishes `<Sift version>-nightly.<run ID>` under `nightly`. The next stable release publishes the checked-in Sift version and moves `latest` off the placeholder; the publisher allows that because the checked-in version sorts above `0.0.1`. After it, an owner runs `npm deprecate @nteract/sift@0.0.1 "Placeholder with no code; install a real version."` and checks `npm view @nteract/sift dist-tags`.

`@nteract/sift-csv` uses the same placeholder bootstrap with its own `NPM_SIFT_CSV_ENABLED` gate and `npm-package-sift-csv` artifact. Releases from sources without the CSV package skip that package entirely.

`@runtimed/wasm` uses its own `NPM_WASM_ENABLED` gate, defaulting off. Its separate
**Build WASM npm package** workflow packs and tests the retained release WASM
without compiling it again, even while publication is disabled. Successful
tarballs are retained as `npm-wasm-<release run ID>-<release attempt>` for 90 days
and reused on publisher retries; expired/deleted successful candidates require a
new release identity. The WASM jobs are independent of all existing npm jobs.

An `@runtimed` owner must publish a code-free `@runtimed/wasm@0.0.1` placeholder,
configure its trusted publisher for organization `nteract`, repository `nteract`,
workflow filename `publish-npm.yml`, leave Environment name blank, and allow
direct `npm publish`. Verify the
registry package and publisher settings, then set `NPM_WASM_ENABLED=true`.
Complete the first trusted publish within two days of creating the configuration
under npm's [current setup requirements](https://docs.npmjs.com/trusted-publishers/).
After the first stable package moves `latest` to a real version, deprecate the
placeholder. The workflow does not create the placeholder, change npm trust or
credentials, or enable its own gate. See the [WASM publishing runbook](docs/runbooks/npm-publishing.md#runtime-wasm)
for immutable retry and consumer verification details.

Both packages are past this bootstrap: their gates are `true` and their nightlies publish with provenance. The steps above are for a new package, or for re-creating a trusted publisher.


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
