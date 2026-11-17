# Native scoped-channel review QA

Use this recipe for the **manual, local-owner `conda:inline`** route. It complements
`crates/runtimed/tests/scoped_channel_review.rs` (real IPC) and the shared
`RelatedChannelReviewDialog` tests. Neither substitutes for native UI wiring.
Do not qualify hosted, automatic/project/prewarm, Kilo, signed packaging, or
other platforms from this result.

## Preconditions and ownership

1. Record exact commit and a clean source diff. Check current machine capacity
   and coordinate with other QA owners. Use a separate checkout, not a release
   checkout or the feature author's working branch.
2. Read `AGENTS.md`, the testing skill, and `macos-setup.md`. Build with
   `cargo xtask build`. Run the fixture unit checks:
   `python3 -B -m unittest discover -s scripts/qa -p 'test_*.py'`.
3. Start the fixture in its own terminal:
   `python3 scripts/qa/scoped_channel_fixture.py serve`.
   This defaults to **empty local metadata only**, with no package downloads.
   To test real install/execution, explicitly add `--live`: the related source
   redirects to public conda-forge. Topology is deterministic; live package
   versions and CDN behavior are not pinned or offline-reproducible.
4. Keep the printed session root, notebook, ledger, fixture process identity,
   and start time. The fixture is outside the checkout so project discovery
   cannot silently select the repository's own `pyproject.toml`.

## Pinned all-local package input

Prefer `serve --mirror /absolute/local/snapshot` over live CDN redirects for
repeatability. The snapshot contains `SUBDIR/repodata.json`, its original package
archives, and `manifest.json` with `{"files":{"noarch/repodata.json":"SHA256",...}}`.
Every entry needs a lowercase SHA-256. Repodata `info` must contain only its
matching `subdir`; each package record needs the matching `subdir`, `sha256`, and
`size`. All referenced archives must be present, with no unreferenced archives.
The harness verifies bytes at startup and again before serving, refuses drift,
and never redirects missing files. It records the manifest digest in session
metadata. The declared source remains the deterministic empty relation fixture.

For real kernel execution, obtain a complete platform-specific closure from an
approved official package registry, retain the original archives and existing
lock/checksums, and independently verify origin and checksums before writing the
manifest. A self-generated manifest alone does not establish provenance. Keep
artifacts outside Git; never repack expanded caches, invent an interpreter, or
replace product package/consent validation. A complete closure must satisfy the
notebook's Python, rich, and daemon base dependencies. Solver validation remains
unchanged. Archive identity is pinned, not the machine's OS cache state.

The unit-test generator reuses the harmless one-file archive pattern from
`crates/kernel-env/tests/rattler_upgrade.rs`. It is only a fixture-server test,
not evidence of native installation or a real Python/kernel. If verified real
archives are unavailable, stop at deterministic review/refusal coverage and
report the missing execution gate. Do not retry the live proxy as a substitute.

## Isolated native profile

Use a fresh private HOME under the printed short session root, with separate
TMPDIR, UV_CACHE_DIR, IPYTHONDIR, JUPYTER_CONFIG_DIR and JUPYTER_RUNTIME_DIR. On
macOS, XDG variables alone do not isolate `dirs` paths. The short root matters:
Unix socket paths must fit `SUN_LEN`. Do not work around a path-length failure by
pointing at an installed daemon.

In that HOME, create `Library/Application Support/nteract-nightly/settings.json`
(or the platform's config directory for the build channel) with these disposable
settings before startup:

```json
{"onboarding_completed":true,"uv_pool_size":0,"conda_pool_size":0,"pixi_pool_size":0,"install_default_data_packages":false,"import_shell_environment":false,"telemetry_enabled":false,"telemetry_consent_recorded":true}
```

Set `RUNTIMED_DEV=1`, `RUNTIMED_WORKSPACE_PATH` to the exact QA checkout,
`NTERACT_TELEMETRY_DISABLE=1`, and a known tool PATH. Keep Rust toolchain homes
explicit if invoking Cargo with the private HOME. For a profile without a login
shell, use `SHELL=/usr/bin/false`; fallback tool paths still apply. Do not change
system settings or install/replace an app or service.

From the checkout, under this same environment:

```sh
cargo xtask dev status
cargo xtask dev --skip-install --skip-build /absolute/session/root/review.ipynb
```

Only skip installation/build after setup succeeded. `dev` can still build its
own sidecar feature combination. Record `dev status` afterward: exact executable,
Automation PID, unique dev bundle ID, Vite URL, and worktree socket. Target that
PID/bundle, never generic “nteract.” Confirm app and daemon display the same
commit. A custom socket alone is not Desktop isolation. Do not reuse stable or
nightly WebKit storage; use the distinct dev identity. Native file dialogs may
still display OS-global recents; open only the exact fixture path.

## Approval and request-ledger gates

Use ordinary UI actions. The fixture never grants consent, gates requests on
behalf of the app, or drives hidden approval APIs.

1. Open the disposable notebook. Review its dependencies; choose notebook-only
   environment if an unexpected project prompt appears. Never trust a real
   project just to pass QA. Trigger a **manual** start.
2. While **Inspect additional channels** is visible, before approving it:
   `python3 scripts/qa/scoped_channel_fixture.py check LEDGER --before metadata`.
   Require declared metadata contact and **zero related contact**. Record the UI
   wording/source order and ledger snapshot with timestamp.
3. Choose **Allow metadata inspection**. While **Approve package sources** is
   visible, before final approval:
   `python3 scripts/qa/scoped_channel_fixture.py check LEDGER --before install`.
   Require related metadata and **zero package archive contact**. The empty
   local fixture can exercise both decisions but cannot install Python.
4. With a verified real mirror (or separately authorized live mode), approve the exact source list, wait for actual
   kernel readiness, and run the existing synced cell. Verify marker, `2`, and
   a new private reviewed prefix in output. Save via Cmd/Ctrl-S; verify saved
   execution count and stdout. “Installation complete” alone is not a pass.

Each refusal/disconnect case uses a **new fixture server/session and notebook**,
so ledger history cannot accidentally hide extra requests:

- Cancel metadata review. Record the declined state; require zero related
  contact and zero new installed prefix/kernel.
- Approve metadata, cancel final-source review. Require zero package contact,
  installed prefix, or kernel. Compare the ledger after a bounded observation
  interval; an instant snapshot alone is not a late-effect test.
- Close the owning native window while metadata review is pending. Record relay
  disconnect and owner teardown. Require no subsequent related/package contact.
  Reopen and manually retry: require fresh decisions, never inherited approval.
  Automatic reopen may fail to solve the deliberately empty declared channel;
  that is the expected no-expansion route, not consent reuse.

These checkpoints supplement logs/UI, not broad proofs of absence of network or
filesystem effects. They inspect only this fixture's requests.

## Cold and warm reliability are different gates

Record first launch with a fresh profile and package cache as **fresh-profile**,
not “fully cold”: OS code-signing/dynamic-loader/page caches are not reset. Do not
delete shared caches or weaken signing, cancellation, or consent checks.
Preserve the first attempt's untouched logs before probing its interpreter.

On macOS ARM64 at `b287bdbc88c016a7fb9423d0372baa20c0d62bce`, one fresh-profile
attempt installed ipykernel but its bounded import probe timed out after 10s.
The RPC misleadingly said ipykernel was missing. A later direct import succeeded
in 2.02s, and a new reviewed prefix with warm caches executed successfully.
That does not prove why the first probe was slow or qualify cold first launch.

For a probe failure, record exact interpreter, diagnostic variant, timeout,
installation completion and probe timestamps, package metadata, and machine
load. Under the same private environment, run an import-only diagnostic with an
explicit external time bound and retain duration/stdout/stderr/exit status. Label
this a **subsequent probe** because it can warm bytecode and OS caches. Do not
alter the product timeout or treat a passing repeated probe as a cold fix.
Compare a later fresh-profile attempt separately from repeated warm imports.
Retain failures and successes, not only the best run.

## Cleanup and report

Under the exact same environment, run `cargo xtask dev reset`; it validates and
stops this worktree's app/daemon. Stop only the fixture process you started (Ctrl-C
in its terminal). Verify owned interpreter/runtime-agent descendants are gone;
do not infer quiescence from a parent lock alone. Retain private reviewed
prefixes conservatively: no automatic reclamation is part of this recipe.

Record protected installed binary/plist/settings/session hashes before/after;
report any changes rather than silently restoring them. Keep exact commit,
fixture mode, profile class, both UI decisions, timestamped ledger, saved output,
first/subsequent outcomes, process cleanup, and untested surfaces in the report.
