# Toolchain trust after the eMudhra incident

Checked against upstream stable releases on October 22, 2026 for the 2.9
candidate:

| Tool | Pinned fallback | Minimum system floor | Notes |
| --- | --- | --- | --- |
| `uv` | **0.13.5** | **0.13.5** | Updates managed Python builds; includes `rustls-webpki 0.103.16` and `webpki-root-certs 1.0.10`. Earlier `0.13.4` is the advisory's floor, but does not establish the stronger alternate cross-signed chain rejection that `0.13.5` verifies. |
| `Pixi` | **0.82.1** | **0.82.1** | Includes `rustls-webpki 0.103.16` and `webpki-root-certs 1.0.10`. |
| `Deno` | **2.9.8** | **2.9.8** | Rejects affected intermediate keys; CI primary and fallback installs use the same version. |
| `Node` | **22.23.4** (image builder) | n/a | Rejects affected intermediate keys in image builds. |

Updating only one root certificate is insufficient because compromised
intermediate keys have alternate, cross-signed chains. References:

- [Python security advisory](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576)
- [uv release notes](https://github.com/astral-sh/uv/releases/tag/0.13.5) and [Pixi release notes](https://github.com/prefix-dev/pixi/releases/tag/v0.82.1)
- [Deno](https://github.com/denoland/deno/releases/tag/v2.9.8) and [Node](https://nodejs.org/en/blog/release/v22.23.4)
- [Mozilla's incident notice](https://seclists.org/oss-sec/2026/q4/233) and [Google's response](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/)

## Tool selection and caches

- **PATH resolution**: nteract resolves the first executable on `PATH`, makes
  relative `PATH` entries absolute, and probes that exact path. A recognizable
  stable `--version` at or above the floor stays preferred.
- **Fallback trigger**: Old, prerelease, unrecognizable, failed, or timed-out
  probes select the pinned fallback and emit a warning. nteract never replaces
  or self-updates the system binary; update system tools through your package
  manager while the fallback keeps nteract working.
- **Cache keys and retries**: Fallbacks are keyed by tool, exact release,
  platform, and channel/worktree, so older versioned or unversioned binaries
  cannot satisfy the new key. A failed download fails the request instead of
  falling back to an old binary. Successful `uv`/Pixi/Deno resolutions cache in
  memory and failures retry on the next request; background pool warming may
  still require a daemon restart after an initial failure.
- **Pinned SHA-256 digests**: All fallback downloads (`uv`, Pixi, Deno, Ruff,
  and `nono`) verify against digests in
  `crates/kernel-launch/src/tools/pinned_hashes.rs` before extraction, so a
  forged TLS connection cannot swap archive and digest together. New versions
  or platforms fail closed until their digest is reviewed and added from
  upstream release metadata (verify the platform archive before updating a
  pin). Downloads keep per-key install locks, staging, atomic publication, and
  existing cache root names. Existing caches are not a forensic scan for prior
  compromise.
- **Process restarts**: Old cache entries stay on disk for older app versions
  and active processes with no broad cache deletion or environment migration.
  Because resolved paths cache in memory, restart the updated app and daemon to
  apply the new policy; an already-running process does not pick up the fix
  just because an update downloaded.

## Existing Python and project environments

Updating fallback binaries does **not** repair existing notebook environments,
project lockfiles, managed interpreters, or containers. Borrowed Python/Conda
environments may bypass these tools entirely, and notebook-launched clients
(`pip`, `requests`, or an older environment-local `uv`) keep their own trust
behavior.

- **Managed UV pools**: New managed UV builds require `uv>=0.13.5`, including
  offline resolutions. At daemon startup, pool entries with missing or
  mismatched package fingerprints are excluded and scheduled for cleanup so
  they cannot serve as an offline fallback with an old `uv`. Rebuilding the
  pool may require network access. Capture recognizes both the bare `uv` spec
  and the new base spec without recording them as user dependencies. Existing
  captured and project-owned environments are never rewritten, and a fresh
  environment does not guarantee every package client inside it is patched.
- **Owner remediation**: Inventory your actual interpreters and package
  managers (Python, `pip`, `requests`, user-selected packages), then apply the
  upstream advisory per environment. Current advisory floors: `pip 26.2.2`,
  `certifi 2026.10.19`, `conda 26.9.4`, and `sigstore 4.5.1`. Update `pip`'s
  vendored `certifi` separately from the environment's `certifi` (updating the
  OS store alone does not fix old `pip`). Use the advisory's pinned wheel URL
  and SHA-256 to bootstrap `pip` safely. Review pinned requirements and
  lockfiles first; do not run a blanket home-directory upgrade.
- **Managed Python builds**: `uv`'s updated managed Python builds apply only to
  newly downloaded interpreters. Existing installations and pinned environments
  do not switch automatically. Review Python security releases and `uv` release
  notes before upgrading or recreating interpreters, plan compatibility for
  older Python versions rather than assuming newer `pip` supports them, and
  preserve notebook files and dependency intent.

## Native TLS and remaining release requirements

The desktop app uses Tauri. Workspace `reqwest` downloads, Rattler Conda/Pixi
environment creation, and the Tauri updater all use **native TLS**. Pinning the
Pixi CLI does not update Rattler or the OS trust store, and browser-side
protection does not prove daemon, updater, or package-client protection.

| Surface | Required evidence before claiming it is protected |
| --- | --- |
| macOS native TLS | Current Apple trust/revocation updates and rejection with the actual native client. `/usr/bin/curl`, Python/OpenSSL, or a separate CA file can behave differently from Security.framework. |
| Windows native TLS | Current Windows certificate trust/disallowed-list updates, including managed/offline machines; native x64 and ARM64 client execution. |
| Linux native TLS | Updated distribution `ca-certificates` and the actual OpenSSL/native backend; inspect custom CA bundle overrides and image layers. |
| Existing environments | Owner-scoped `pip`, `certifi`, `uv`, and Conda inventory/remediation, including borrowed environments and lockfiles. |
| Runtime-peer image | Rebuild from refreshed base images with stale layer caching disabled; verify system certificates, Python/`ensurepip`/`pip`, and environment-local tools. Source changes alone do not publish an image. |
| CI/build tools | Verify runner trust stores, setup-action results, cached tools, and independently bundled roots. Floating setup versions do not prove a historical run was patched. |
| Deno/Node and other runtimes | Deno 2.9.8 and image-builder Node 22.23.4 are pinned; qualify actual TLS rejection and kernel/build behavior. Other installed runtimes remain owner-managed. |
| Cloud/workstation WebSockets | Native TLS still relies on host trust updates; test the actual client before claiming protection. Investigate exposure and rotate credentials if compromise is suspected; this patch alone is not evidence of credential theft. |
| Hosted sites | Inspect each public served chain and its issuer; renew affected chains with the owning deployment team. A healthy server chain does not establish outbound client protection. |

### `runtime-peer` image controls

- Release and PR-validation workflows pull fresh base images (`pull: true`) and
  disable layer reuse (`no-cache: true`) for `runtime-peer`.
- Both Docker stages bootstrap `pip 26.2.2` from the advisory's hash-pinned
  wheel before package installation and refresh/enforce the Debian Bookworm
  `ca-certificates` floor (`20250419~deb12u2`,
  [DLA-4845-1](https://security-tracker.debian.org/tracker/DLA-4845-1)); the
  runtime stage also requires `certifi >=2026.10.19` and `uv >=0.13.5`.
- The image smoke test enforces these package floors, but versions alone do not
  prove OpenSSL rejects every affected chain, and source guards do not prove an
  image was rebuilt or deployed. Retain the build result, resolved base digest,
  package inventory, and TLS probes with release evidence before promotion.

### Guardrails

- Never disable TLS verification, install a custom trust anchor, modify
  platform security settings, or assume removing one root blocks every
  cross-sign.
- Roll out platform updates and image rebuilds through each owner's normal
  deployment process.
- `Cargo.lock` may list unused or target-specific TLS crates; trace the feature
  graph for each shipped artifact before asserting its TLS backend.

## Qualification

1. **Offline regressions**: Run `cargo test -p kernel-launch` to verify old
   `PATH` versions, numeric version ordering, failed/unparseable probes,
   relative `PATH` resolution, current-cache reuse, fail-closed downloads,
   preservation of old cache files, retry after failure, platform digest
   coverage, and substituted-archive rejection.
2. **Opt-in network suite**: Build
   `crates/kernel-launch/tests/toolchain_qualification.rs` without running it:

   ```sh
   cargo test -p kernel-launch --test toolchain_qualification --no-run
   ```

   Run the emitted test binary in a disposable environment:
   - Set `NTERACT_TOOLCHAIN_FIXTURE_ROOT` to an absolute directory.
   - Place `HOME`, `XDG_CACHE_HOME`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`,
     and `PIXI_HOME` beneath it, along with isolated temp, Jupyter, IPython,
     and Rattler cache directories.
   - Use a minimal `PATH` without `uv` or Pixi, clear inherited virtualenv,
     config, and TLS overrides, and invoke each ignored test by exact name with
     `--nocapture`.
3. **Toolchain and kernel test
   (`pinned_toolchain_environment_and_kernel_contracts`)**: Exercises real
   fallback downloads/caches, `uv` venv/install/list/project-run, Pixi
   install/info and frozen shell-hook JSON, and disposable Python kernels over
   Jupyter messaging (asserting a `42` result and shutting down owned kernels).
   Covers package and kernel compatibility only, not the installed GUI, daemon
   save/recovery, Windows emulation, or arbitrary lockfiles.
4. **TLS rejection test
   (`native_tls_rejects_affected_chains_with_positive_control`)**: Tests PyPI
   as a positive control against four public incident hosts (direct and AAA
   cross-signed chains, logged and unlogged leaves). Requires certificate
   errors; DNS errors, timeouts, and arbitrary failures are inconclusive. Apply
   the same controls to `uv`/Pixi network calls and each shipped platform. The
   incident site's [public fixtures](https://emudhra.we-have-a-problem.com/)
   also supply offline chains; never import their certificates into trusted
   roots.
5. **Release receipts**: Archive dated per-platform results with the
   candidate's release receipts. Tests on one host do not establish Windows,
   Linux, Intel macOS, installed updater, or container trust behavior; leave
   unexecuted lanes explicitly unverified.
