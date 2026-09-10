# Unified CLI release plan

Status: proposed release sequence; no release or version bump is authorized by
this document. Source and PR status checked on 2026-09-10.

Ship the unified `nteract` CLI through Nightly first, qualify the actual installed
artifacts, then promote that qualified source revision to Stable. Propose **2.8.0**
as the next base version: this introduces a public command and installation
contract while retaining the legacy commands. The checked-in base is currently
2.7.6. Version choice remains a release-owner decision.

## Scope and dependencies

| Change | Release relationship |
| --- | --- |
| [Unified CLI #4231](https://github.com/nteract/nteract/pull/4231) | Merged; independently releasable. Introduces `nteract open`, notebook operations, supervised `nteract mcp`, workstation commands, and safe command installation. Its release does not depend on the path shorthand follow-up. |
| Path and directory launch follow-up | Separate feature gate for directory semantics (including `nteract open <directory>`) and `nteract .`, `nteract <directory>`, and notebook paths without `open`. Include only after its own source and installed Desktop acceptance passes; otherwise release the unified CLI with explicit `nteract open <notebook.ipynb>`. |
| [Runtime lock errors #4230](https://github.com/nteract/nteract/pull/4230) | Independent improvement, not a prerequisite established by current evidence. Open at this audit, head `e5f5188650c690625c66a0a4aa0d43e8cc24ea2c`. Its reported Python kernel-readiness failure still needs disposition. The change distinguishes lock contention from I/O errors; it does not solve Desktop's service-install race. Recheck status before selecting the release SHA. |
| Atomic Desktop bootstrap | Separate service-lifecycle work. Desktop probes compatibility, but an endpoint appearing after the absence check can race with service installation. Do not describe this release as providing atomic, non-replacing Desktop startup. |

The CLI contract and that known race are documented in the
[CLI runbook](../runbooks/cli.md). Hosted MCP and workstation serving do not
require the local notebook daemon service; they can still need the `runtimed`
executable's agent entry points. Desktop and local notebook execution require a
local runtime. Hosted examples require a configured deployment and credentials;
this release does not announce a public hosted service.

## User-facing command vocabulary

Use **Install nteract CLI** for Desktop menu and rollout copy. The public command
is `nteract`; retain the concrete daemon name when diagnosing the runtime rather
than hiding it behind another new command name.

| Intent | Public command | Preserved behavior |
| --- | --- | --- |
| Open Desktop | `nteract open <path>` | Explicit notebook handoff. The follow-up adds directory semantics and path-only invocation. |
| Diagnose this installation | `nteract doctor`, `nteract doctor --json` | Alias for `nteract daemon doctor`; `--fix` remains an explicit repair action. |
| Inspect/manage the runtime service | `nteract status`, `nteract daemon status`, `nteract daemon start`, `nteract daemon stop`, `nteract logs` | Installation-scoped runtime operations remain available. Add `--channel stable` or `--channel nightly` to select a specific installation. |
| Operate on notebooks | `nteract notebooks`, `nteract nb tools`, `nteract nb call ...` | Uses the selected notebook runtime; discovery does not create a service. |
| Offer a workstation | `nteract workstation connect`, `nteract workstation run`, `nteract workstation status` | Pairing and serving remain distinct from local daemon management. |
| Serve MCP | `nteract mcp` | Canonical supervised entry point; existing `nteract-mcp` and `runt mcp` integrations remain supported. |

## Publication contract

The authoritative jobs are [release-common.yml](../../.github/workflows/release-common.yml),
[release-nightly.yml](../../.github/workflows/release-nightly.yml), and
[release-stable.yml](../../.github/workflows/release-stable.yml).

Nightly runs daily at 09:00 UTC or by dispatch. Stable runs on `v*` tag pushes or
by dispatch. Both call the same publishing workflow; they are not packaging-only
dry runs. The workflow builds with `RUNT_BUILD_CHANNEL` and
`NTERACT_BUILD_GIT_HASH` from the selected source revision. It computes a release
version from `crates/runt/Cargo.toml`, the channel, and a UTC minute timestamp.
Do not infer the source revision from the generated tag name: verify the tag's
resolved commit against the run's `head_sha` and embedded build identity.

| Surface | Expected artifact or behavior | Acceptance evidence |
| --- | --- | --- |
| Linux x64 | `nteract-cli-linux-x64` or `nteract-cli-nightly-linux-x64`; existing `runt`, `runtimed`, and `nteract-mcp` channel assets; `nteract-<channel>-linux-x64.AppImage` and updater signature | All names present; downloaded CLI reports expected version/channel/revision; installed backend is `<prefix>/bin/nteract-cli`. No DEB/RPM or Linux ARM64 release is implied. |
| macOS arm64 and x64 | `nteract-<channel>-darwin-<arch>.dmg`, signed/notarized `.app.tar.gz`, updater signature; app includes `runt`, `runtimed`, `nteract-cli`, `nteract-mcp` | Validate app signature/notarization and all bundled executables after installation. Canonical CLI comes from the signed bundle; no standalone canonical macOS CLI asset is promised. Raw legacy CLI/daemon assets remain compatibility artifacts. |
| Windows x64 | Signed `nteract-<channel>-windows-x64.exe` NSIS installer and updater signature; four bundled sidecars with `.exe` suffix | Native installation, first launch, menu installation, coexistence, upgrade, and uninstall tests. Canonical shim must invoke `nteract-cli.exe`, not Desktop's `notebook.exe`. No standalone canonical Windows CLI asset is promised. |
| Shell installer | Release asset `install-linux-release`, despite its historical Linux-only name | Its stamped `DEFAULT_CHANNEL` and `DEFAULT_TAG` match that release. Install from that immutable asset; compare installed executables with its release's binaries. |
| Updaters | Immutable release `latest.json` and the channel's `stable-latest` or `nightly-latest` manifest | Byte equality; platform URLs resolve to the intended immutable release; all signatures exist and installed updater succeeds. |
| Python | Four `runtimed` wheels: macOS arm64/x64, Linux x64, Windows x64 | Wheel metadata and PyPI files match the intended stamp and platform matrix; isolated install, notebook execution, and shutdown pass. This workflow does not publish the separate Python `nteract` package. |
| Agent plugins | Stable `plugins/nteract` or Nightly `plugins/nightly` in `nteract/agent-plugins`, with four platform MCP binaries and dispatch wrappers | Distribution commit records the same source SHA, correct channel configuration and manifest versions; actual MCP host starts the wrapper successfully. The other channel's subtree is preserved. |
| Notebook UI archive | `nteract-<channel>-notebook-ui.tar.gz` and `.sha256` | Checksum verifies; archive belongs to the same release. Its presence does not establish hosted service availability. |

The Python workflow uses the base version for Stable and **next-patch alpha** for
Nightly. With the proposed 2.8.0 base, Desktop Nightly would be
`2.8.0-nightly.<timestamp>`, Python Nightly `2.8.1a<timestamp>`, and Python Stable
`2.8.0`. Preserve this existing policy unless a separate decision changes it;
check wheel metadata rather than assuming identical full version strings.

Publication is not atomic. `publish-plugin` depends on Desktop build jobs but
does not wait for the release publication job. The latter publishes Python
wheels before creating the GitHub Release and then updates the rolling updater
manifest. A failed run can therefore already have changed plugins, PyPI, or
GitHub assets. A green subset of jobs is not a completed release.

## Installer and plugin migration

The [shell installer](../../scripts/install-linux-release) is published by
`release-common.yml`, which stamps its channel and exact tag. The separate
[`install-sh` bootstrap](https://github.com/nteract/install-sh/blob/d6f4c79028ab9739e5658c0a589b3e5e298cba88/lib/script.js)
already forwards all arguments. It normally fetches the **latest Stable
installer** first, even when forwarded arguments request a Nightly tag. It can
fall back to the main-branch installer on lookup failure or for older macOS
installer support.

Use the exact Nightly release's installer asset during qualification. An older
Stable installer selected by `sh.nteract.io` may not support the new `--cli`
behavior. After Stable publication, verify the public bootstrap resolves the
new Stable asset and forwards `--cli` and custom paths correctly. Changing the
bootstrap alone cannot supply the new binaries. Do not qualify from an
unrecorded main-branch fallback.

The older [install-nightly-release](../../scripts/install-nightly-release)
still installs and starts a local daemon service and only downloads legacy
commands. It is not the daemon-free CLI installer and is not the installer asset
published by this workflow. Release instructions should use the published
`install-linux-release` asset; retiring the older script is separate cleanup.

The [plugin assembly script](../../scripts/assemble-plugin-dist.sh) ships
`nteract-mcp` and platform wrappers, not a full CLI/runtime stack. The
[legacy MCP entry point](../../crates/nteract-mcp/src/lib.rs) still locates
`runt` or `runt-nightly` and launches `runt mcp`; existing
[Claude configuration](../../plugins/nteract/.mcp.json) and
[Codex configuration](../../plugins/nteract/.codex-mcp.json) keep that contract.
Preserve those backends in installers and app bundles. A plugin-only machine
without a discoverable legacy CLI is a negative test, not a supported
self-contained runtime installation. Correct any generated plugin instructions
that imply otherwise before promoting the release. Windows wrapper resolution
must be tested in the actual supported MCP hosts, including their `.cmd`
resolution; wrapper compilation alone cannot prove that behavior.

| Migration scenario | Required result |
| --- | --- |
| Clean `--cli` / `--headless`, Linux and macOS | Public command and helpers installed; no local daemon service registered, repaired, started, or restarted. Existing runtime/service state unchanged. macOS may retain the complete signed bundle under the prefix. Help/discovery still leave the daemon absent. |
| Desktop shell install versus `--no-start` | Default Desktop install may repair/install and start its service. `--no-start` still installs/repairs the service, so it is not equivalent to `--cli`. |
| Stable then Nightly; Nightly then Stable; update either | First managed public `nteract` selection survives. `--default-cli` or Desktop's **Install nteract CLI** selects deliberately; `--channel stable` or `--channel nightly` resolves the registered installed backend. Missing channel fails without switching silently. |
| Custom prefix/bin directory and unrelated PATH launcher | Channel records resolve the actual backend. Linux open uses that installation's AppImage or owned bundle launcher; an unrelated `nteract-desktop` is never executed. |
| Pre-unified Linux `nteract` AppImage alias, then `--cli` | Exact owned alias migrates to canonical CLI while retaining access to the already-installed AppImage; no recursive CLI launch. Unknown app launchers remain unchanged. |
| Current legacy `runt` link, then app relocation/update | Exact current target seeds ownership; a later recorded stale target repairs. Unknown, modified, unproven stale, regular-file, and broken-link aliases remain unchanged with actionable guidance. Only exact generated `nb` wrappers migrate. |
| Existing `runt mcp`, `nteract-mcp`, and plugin registrations | Initialize, list tools, connect, execute/read a synced cell, reconnect, and exit retain their existing worker/supervisor semantics. No forced client configuration rewrite. |
| Canonical `nteract mcp` | Supervisor stays on the selected installation, stdout remains protocol-only, target survives worker restart, and `--no-show` omits Desktop opening. Hosted connection does not start a local notebook daemon. |
| Windows coexistence and uninstall | Shared selection and channel records match installed targets; preserve unrelated `.exe`/`.cmd` commands. Uninstalling one channel never deletes another's selected command. Test selected-channel removal and useful remaining-channel recovery separately. |
| Runtime already running | Compatible runtime reused; incompatible, uncertain, or explicit unreachable endpoints cause useful errors without automatic repair. Record runtime PID/identity before and after. Explicit repair/updater transactions retain their documented behavior. |

## Qualification and promotion gates

1. **Select source and version.** Recheck the merged feature set, PR #4230 status,
   and current version files. Decide whether shorthand is included. If 2.8.0 is
   accepted, use the repository's coordinated version bump and commit it before
   Nightly qualification. Review protocol/schema markers independently; command
   naming alone does not require a wire or document-schema change. Capture the
   exact candidate SHA and require CI on that SHA.
2. **Pass source checks.** Run repository lint, CLI/parser and runtime/MCP tests,
   Desktop installation/admission tests, release installer fixtures and
   shellcheck, workflow validation, and Windows installer install/uninstall
   compilation. Include shorthand path parsing and argument forwarding tests
   only when that feature is included. Record failures and disposition; prior
   PR results are not evidence for a later release revision.
3. **Publish one Nightly candidate.** This is a real publication, including PyPI,
   plugins, and `nightly-latest`. After release authorization, select the intended
   ref explicitly and record the run ID, source SHA, generated tag, artifact
   hashes, wheel versions, and plugin distribution commit. Wait for all required
   jobs, including Fedora AppImage smoke and plugin publication.
4. **Qualify installed artifacts.** Complete the artifact and migration matrices
   above on supported platforms. Exercise the signed/notarized installed app,
   not a dev build, on macOS; use the signed Windows installer and actual Linux
   AppImage. Run a short cell and a roughly 30-second cell; require terminal
   completion, visible output, and empty execution queues. Reopen saved content
   and exercise MCP reconnect. Inspect active processes so an old app/runtime
   cannot masquerade as the candidate.
5. **Gate directory launch when included.** For `nteract open <directory>`,
   `nteract .`, and `nteract <directory>`, test both an absent Desktop
   process and an already-running one. Verify a notebook opens with the requested
   working directory and runtime, not merely that a process exits successfully.
   Include relative paths, paths with spaces, notebook files, same-named command
   directories addressed with `./`, both channels, and a CLI launched outside
   the target directory. Check existing windows remain attached to their correct
   runtime. Run the absent-runtime case and record the known concurrent-start
   race separately; a single successful launch does not resolve it.
6. **Promote qualified source to Stable.** After acceptance, dispatch Stable from
   the immutable qualified Nightly ref. This rebuilds and re-signs Stable; it
   does not rename the Nightly artifacts. Verify the generated Stable tag resolves
   to the same qualified source SHA. Any code or version-file change requires a
   new qualified candidate rather than an untested promotion.
7. **Verify Stable distribution and installed upgrade.** Check every surface in
   the artifact table, including plugin publication, PyPI, rolling-manifest byte
   equality, and the public bootstrap's actual installer URL. Upgrade an older
   Stable app through its updater, repeat canonical command and directory-launch
   acceptance, then execute a notebook cell. Publish release notes that distinguish
   available commands, compatibility aliases, and remaining platform limitations.

The release record should contain one row per acceptance scenario with platform,
installer/tag, source SHA, app/CLI/runtime identity, expected result, observed
result, and evidence. Until those rows exist, installed behavior is unverified.
Shorthand failure may exclude the shorthand feature from a candidate; it does
not retroactively make #4231 unmergeable. A failure in shared installation or
runtime behavior must be assessed against the unified CLI itself.

## Rollback and limits

Record the previous channel manifest and plugin distribution revision before
publication. If a candidate fails qualification, stop promotion and enumerate
which surfaces already changed. Restore a prior channel manifest only through
an explicit release-owner recovery action; it can stop advertising the candidate
but does not downgrade apps that already installed it. A fixed newer release is
the normal recovery for installed users. Preserve their notebooks, settings,
workstation credentials, and unrelated command aliases.

PyPI files cannot be replaced under previously used filenames. A bad release
can be yanked with a reason, but already-installed or exactly pinned consumers
are not rolled back; publish a corrected version. See
[PyPI filename reuse](https://pypi.org/help/#file-name-reuse) and
[yanking](https://docs.pypi.org/project-management/yanking/).
Do not attempt recovery by reusing a version or moving a qualified immutable tag.

Plugin distribution can be corrected with a new commit for the affected channel,
but clients may retain cached binaries until refresh/restart. Updater manifests,
GitHub assets, plugins, and PyPI need separate recovery verification. Repointing
an owned public CLI to another installed channel is not a runtime/data rollback;
do not delete runtime locks or services to bypass a compatibility problem.
