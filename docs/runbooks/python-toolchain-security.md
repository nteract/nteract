# Toolchain trust after the eMudhra incident

The 2.9 candidate uses uv **0.13.5** and Pixi **0.82.1** for its fallback
downloads. These are the upstream stable releases checked on October 22, 2026.
uv 0.13.5 also updates its managed Python builds; the security floor for an
existing system uv is also **0.13.5**, whose verifier rejects compromised
intermediate keys, including alternate chains. The advisory's earlier 0.13.4
floor updates the root bundle but does not establish this stronger protection. Pixi's floor is **0.82.1**.

See the [Python security advisory](https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576),
[uv release notes](https://github.com/astral-sh/uv/releases/tag/0.13.5), and
[Pixi release notes](https://github.com/prefix-dev/pixi/releases/tag/v0.82.1).
Both selected release lockfiles include `rustls-webpki 0.103.16` and
`webpki-root-certs 1.0.10`. Updating only one root is insufficient evidence of
protection: compromised intermediate keys have alternate, cross-signed chains.
[Mozilla's incident notice](https://seclists.org/oss-sec/2026/q4/233) and
[Google's response](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/)
describe the affected keys and trust paths.

Deno uses **2.9.8** as both its fallback and minimum system version; the image
builder uses Node **22.23.4**. These releases reject the affected intermediate
keys ([Deno](https://github.com/denoland/deno/releases/tag/v2.9.8),
[Node](https://nodejs.org/en/blog/release/v22.23.4)). CI's primary and fallback
Deno installs use the same patched version.

## Tool selection and caches

- nteract resolves the first executable on PATH and probes that exact path.
  A successful, recognizable stable `--version` at or above the security floor
  remains preferred. Relative PATH entries are made absolute before use.
- Old, prerelease, unrecognizable, failed, or timed-out probes select the pinned
  fallback and emit a warning. nteract does not replace the system installation
  or run its self-updater. Operators can update it through their normal package
  manager; the fallback keeps nteract usable in the meantime.
- Fallback paths are keyed by tool, exact release, platform and application
  channel/worktree. Older versioned or unversioned executables cannot satisfy
  the new key. A failed download fails the request; it does not select the old
  executable. Successful uv/Pixi/Deno resolutions are cached; failures can be
  retried by the next request. Background pool warming can still need a daemon
  restart after an initial tool-resolution failure.
- All fallback downloads (uv, Pixi, Deno, Ruff and nono) verify against SHA-256
  digests shipped in `crates/kernel-launch/src/tools/pinned_hashes.rs` before
  extraction. A forged TLS connection cannot replace both archive and expected
  digest. New versions/platforms fail closed until their digest is reviewed and
  added. Update the table from the upstream release asset metadata, and verify
  the platform archive before changing a pin. Existing tool caches are not a
  forensic scan for prior compromise. Downloads retain the per-key install lock,
  staging and atomic publication; cache root naming is unchanged.
- Old cache entries remain on disk for older application versions and active
  processes. No broad cache deletion or environment migration occurs. Tool paths
  are cached in memory: restart the updated application and its daemon through
  the normal lifecycle to use the new policy. An already-running old process
  has not acquired the fix merely because an update was downloaded.

## Existing Python and project environments

Updating the fallback executables does **not** repair every notebook environment,
project lockfile, managed interpreter or container. The environment picker may
also use a borrowed Python/Conda environment without invoking these tools.
Package clients launched from notebook code, including `pip`, `requests`, or an
older environment-local uv, retain their own trust behavior.

New managed UV environment builds require `uv>=0.13.5`, including offline
resolutions. At daemon startup, UV pool entries with missing or mismatched
package fingerprints are excluded and scheduled for cleanup; they cannot serve
as an offline fallback with an old environment-local uv. Rebuilding that pool
may require a network connection. Capture recognizes both the historical bare `uv` and the new
base spec without recording them as user dependencies. Existing captured or
project-owned environments are not rewritten, and a new environment is not
proof that every package client inside it is patched. Python, pip, requests,
and user-selected package versions still need their own inventory.

Owners should inventory their actual interpreters and package managers, then
apply the upstream advisory within the selected environment. Its current floors
include pip 26.2.2, certifi 2026.10.19, conda 26.9.4 and sigstore 4.5.1. pip's
vendored certifi must be updated separately from the environment's certifi;
updating the OS store alone does not fix old pip. The advisory supplies a pinned
wheel URL and SHA-256 for securely bootstrapping pip. Review pinned requirements
and lockfiles before updating them. Do not run a blanket home-directory upgrade.

uv's new managed Python builds improve newly downloaded interpreters. Existing
Python installations and environments pinned to an earlier patch do not switch
automatically. Review Python's security releases and the uv release notes before
an owner-controlled interpreter upgrade or recreation. Older Python versions
need a compatibility plan rather than an assumption that a newer pip supports
them. Preserve notebook files and dependency intent during remediation.

## Native TLS and remaining release requirements

The current desktop application is Tauri. The workspace reqwest downloads,
Rattler Conda/Pixi environment creation, and Tauri updater use **native TLS**.
The Pixi CLI pin does not update Rattler or the operating system trust store.
Browser-side protection is not evidence of daemon, updater or package-client
protection.

| Surface | Required evidence before claiming it is protected |
| --- | --- |
| macOS native TLS | Current Apple trust/revocation updates and rejection with the actual native client. `/usr/bin/curl`, Python/OpenSSL or a separate CA file can behave differently from Security.framework. |
| Windows native TLS | Current Windows certificate trust/disallowed-list updates, including managed/offline machines; native x64 and ARM64 client execution. |
| Linux native TLS | Updated distribution `ca-certificates` and the actual OpenSSL/native backend; inspect custom CA bundle overrides and image layers. |
| Existing environments | Owner-scoped pip, certifi, uv and Conda inventory/remediation, including borrowed environments and lockfiles. |
| Runtime-peer image | Rebuild from refreshed base images with stale layer caching disabled; verify system certificates, Python/ensurepip/pip and environment-local tools. No image publication is implied by this source patch. |
| CI/build tools | Verify runner trust stores, setup-action results, cached tools and independently bundled roots. Floating setup versions do not prove a particular historical run was patched. |
| Deno/Node and other runtimes | Deno 2.9.8 and image-builder Node 22.23.4 are pinned; qualify actual TLS rejection and kernel/build behavior. Other installed runtimes remain owner-managed. |
| Cloud/workstation WebSockets | Native TLS still relies on host trust updates; test the actual client before claiming protection. Investigate exposure and rotate credentials if compromise is suspected; this patch alone is not evidence of credential theft. |
| Hosted sites | Inspect each public served chain and its issuer; renew affected chains with the owning deployment team. A healthy server chain does not establish outbound client protection. |

Both release and PR-validation workflows request fresh base images (`pull: true`) and disables
build layer reuse (`no-cache: true`) for runtime-peer. Both Docker stages
bootstrap pip 26.2.2 from the advisory's hash-pinned wheel before ordinary
package installation; the runtime also requires certifi >=2026.10.19 and uv
>=0.13.5. Source guards do not prove a particular image was rebuilt or deployed.
Retain its build result, resolved base digest, package inventory and TLS probes
with release evidence before promotion. The image smoke test enforces the pip,
certifi and uv version floors, plus Debian Bookworm ca-certificates
`20250419~deb12u2` ([DLA-4845-1](https://security-tracker.debian.org/tracker/DLA-4845-1)).
Both Docker stages refresh and enforce that native CA-package floor. Versions alone do not establish that
OpenSSL rejects every affected chain.

No application workaround should disable TLS verification, install a new trust
anchor, modify platform security settings, or assume removal of one root blocks
every cross-sign. Platform updates and image rebuilds need their owners' normal
deployment process. `Cargo.lock` can contain unused/target-specific TLS packages;
trace the feature graph for each shipped artifact before asserting a backend.

## Qualification

`cargo test -p kernel-launch` runs offline policy, process and cache regressions.
These include old PATH versions, numeric version ordering, failed/unparseable
probes, absolute resolution from relative PATH entries, reuse of the current
cache, failure without fallback to the old cache, preservation of old files, retry after a failed resolution, platform digest
coverage, and rejection of substituted archive bytes.

`crates/kernel-launch/tests/toolchain_qualification.rs` contains opt-in network
tests. Build with `cargo test -p kernel-launch --test toolchain_qualification
--no-run`, then run that emitted test executable under a disposable environment.
Set `NTERACT_TOOLCHAIN_FIXTURE_ROOT` to an absolute directory and place `HOME`,
`XDG_CACHE_HOME`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, and `PIXI_HOME` beneath
it. Also isolate temporary, Jupyter, IPython and Rattler cache directories. Use
a minimal PATH without uv/Pixi, clear inherited virtualenv/configuration and TLS
overrides, and run each ignored test by its exact name with `--nocapture`.

`pinned_toolchain_environment_and_kernel_contracts` exercises the real fallback
download/cache paths, uv venv/install/list/project-run, Pixi install/info and
frozen shell-hook JSON, and disposable Python kernels over Jupyter messaging.
It checks an actual `42` result and shuts down its owned kernels. This is package
and kernel compatibility evidence; it does not qualify the installed GUI,
daemon save/recovery lifecycle, Windows emulation or every project lockfile.

`native_tls_rejects_affected_chains_with_positive_control` uses PyPI as a positive
control and four public incident test hosts: direct and AAA cross-signed chains,
each with logged and unlogged leaf certificates. It requires certificate errors;
DNS errors, timeouts and arbitrary failures are inconclusive. Apply the same
positive/negative controls to uv/Pixi network operations and each shipped
platform. The incident site's [public fixtures](https://emudhra.we-have-a-problem.com/)
also provide offline chains. Do not import their certificates into trusted roots.

Keep dated per-platform results with the candidate's release receipts. Source
tests on one host do not establish Windows, Linux, Intel macOS, installed updater
or container trust behavior. Any unexecuted lane remains explicitly unverified.
