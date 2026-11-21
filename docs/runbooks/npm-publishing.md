# Publishing the npm packages

`publish-npm.yml` builds the Node SDK, `@nteract/sift`, and `@nteract/sift-csv`,
and resolves the independently packed `@runtimed/wasm`, after a successful
**Stable Release** or **Nightly Release** run. Build jobs hold no publication
credentials; publication jobs use npm trusted publishing and never build source
or install project dependencies.

Each package publishes from its own checked-in `package.json` version. Daemon
discovery applies to the Node SDK only.

| Upstream release | npm version | Dist-tag | Default daemon discovery |
|---|---|---|---|
| Stable | Checked-in package version | `latest` | Stable channel |
| Nightly | `<package version>-nightly.<upstream run ID>` | `nightly` | Nightly channel |

- **Immutable source**: The upstream run supplies the source SHA. Rerunning
  that release does not allocate a new npm version. The upstream attempt is
  recorded in the release plan without changing the package version or
  provenance metadata.
- **Eligibility**: The publisher rejects failed releases, foreign repositories,
  and runs of other workflows. A manual run requires the upstream release run
  ID and attempt; it cannot publish an arbitrary ref.
- **Branch policy**: A successful upstream release dispatched from a feature
  branch is eligible, including promoting npm's `nightly` tag. Dispatch
  upstream releases only from refs intended for that channel. The manual npm
  workflow itself must run from the default branch; the validated upstream run
  supplies the build source.
- **Channel scope**: `@runtimed/node`, its native platform packages,
  `@nteract/sift`, and `@nteract/sift-csv` publish nightly versions.
  `@nteract/pi` publishes through the stable path only.

## Sift

- **`@nteract/sift`**: Publishes from its checked-in version to `latest`
  (stable) and `<Sift version>-nightly.<upstream run ID>` to `nightly`. Its
  pack job builds Sift WASM, stamps the version, runs `test:package` against
  the packed consumer, and uploads the tarball. It shares the upstream source
  and run identity with the Node SDK but no jobs, so failures stay isolated.
  Gated by `NPM_SIFT_ENABLED` in
  [RELEASING.md](../../RELEASING.md#published-bindings).
- **`@nteract/sift-csv`**: Same pipeline with its own plan, `pack-sift-csv` and
  `publish-sift-csv` jobs, `npm-package-sift-csv` artifact, checked-in version,
  and `NPM_SIFT_CSV_ENABLED` gate. Its pack job builds `crates/sift-csv-wasm`
  via `cargo xtask wasm sift-csv`.
- **Pinning**: The two Sift packages do not depend on each other at publish
  time. Consumers should pin exact versions for each independently.

## Runtime WASM

`@runtimed/wasm` is an independent, dependency-free ESM package with generated
bindings, declarations, an explicit binary export, and build metadata. Desktop
and cloud imports and the private `runtimed` TypeScript package stay unchanged.
See its [initialization examples](../../packages/runtimed-wasm/README.md).

### Producer (`build-wasm-npm.yml`)

1. Follows successful stable and nightly releases and verifies the retained
   `release-wasm-<run ID>-<attempt>` artifact (source, channel, successful WASM
   job attempt, artifact digest, and file checksums). An earlier successful
   WASM attempt can be reused when only failed release jobs reran.
2. Copies the matching JS, WASM binary, and declarations without recompiling,
   adds dependency notices from the release source, and packs once.
3. Tests the final tarball in an isolated consumer: sync and async byte init,
   precompiled-module and `Response` init, default paired binary URL, document
   mutation/save, and TypeScript `NodeNext`/bundler resolution. These checks do
   not launch a daemon or kernel and do not prove browser, desktop, or host
   compatibility.
4. Writes `build-info.json` (source/release identity, protocol source
   constants, `Cargo.lock` and genesis hashes, WASM checksums) and external
   `candidate.json` (release artifact ID/digest, build attempt, every packed
   file checksum, tarball SHA-256/SHA-512).
5. Retains `npm-wasm-<release run ID>-<release attempt>` for 90 days.

### Retention and retries

- Duplicate events, producer reruns, and manual publisher retries reuse the
  first successful packed candidate.
- A failed or incomplete pack with no retained candidate can retry.
- If a successful pack's artifact expires or is deleted, recovery fails
  explicitly: create a new release identity instead of repacking the old one.
- Once packing succeeds, expiry of the original WASM input does not block
  publishing the sealed tarball while that tarball remains retained.

### Publisher (`publish-npm.yml`) and gate

- Independently resolves the producer and passes only verified data and trusted
  helpers to its WASM OIDC job. Waits up to 30 minutes for the producer, then
  fails with a retry instruction.
- No SDK, Sift, CSV, or Pi job depends on that wait or WASM success.
- Never builds, repacks, installs dependencies, or runs package scripts.
- Existing stable and nightly versions must match the source identity and
  registry tarball SHA-512. Conflicting immutable versions and stale channel
  promotions are refused, and existing dist-tags stay unchanged.
- To resolve a conflicting stable version, bump the checked-in package version
  and cut a new release; retrying reuses the original bytes and cannot replace
  an immutable npm version.
- Publication defaults off under `NPM_WASM_ENABLED`; the producer still packs
  and tests while disabled. Bootstrap and trusted-publisher setup require a
  maintainer (see [RELEASING.md](../../RELEASING.md#published-bindings)).
- **Recovery**: Dispatch the producer if its initial pack failed, then dispatch
  **Publish npm packages** with the same successful upstream release run ID and
  attempt (no arbitrary refs). Sources predating `@runtimed/wasm` skip WASM
  without affecting other packages.

### npmjs.com setup for `@runtimed/wasm`

| Field | Value |
|---|---|
| Package / scope | `@runtimed/wasm` / `@runtimed` |
| Visibility | Public (`npm publish --access public`) |
| First publication | Code-free `0.0.1` placeholder, published manually by a scope owner |
| GitHub organization / repository | `nteract` / `nteract` |
| Trusted workflow filename | `publish-npm.yml` |
| Environment name | Leave blank; the publisher job declares no environment |
| Allowed action | Enable direct `npm publish` |
| Stable / nightly tags | `latest` / `nightly` |
| Repository gate | `NPM_WASM_ENABLED=true`, only after setup is verified |

Create the package first, then configure its trusted publisher in package
Settings only when a tested candidate is ready: npm requires the first
successful trusted publish within **two days** of creating the configuration
(the deadline clears after that first publish). The workflow runs Node 24,
verifies npm 11.5.1 or newer, and needs no long-lived npm token. See npm's
[trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/)
and [scoped public publication guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
Keep `NPM_WASM_ENABLED` off until package, scope access, and publisher settings
are confirmed. Deprecate the placeholder after the first stable release.

## Package coordination and daemon compatibility

- **Wrapper and native addons**: Their versions must match exactly, and every
  enabled native package must exist on npm before the wrapper publishes.
- **ARM64 gates**: Linux and Windows ARM64 remain behind bootstrap gates in
  [RELEASING.md](../../RELEASING.md#published-bindings). Both default off while
  still building and testing tarballs; enable each gate only after creating the
  package and verifying trusted publishing.
- **Daemon and UI compatibility**: Package pins do not require matching release
  versions or commits on the daemon or embedded UI. Daemon admission follows
  the [wire and semantic API contract](../adr/daemon-service-repair-and-semantic-compatibility.md).
  Optional connection capabilities and the embedded UI/host bridge have their
  own contracts. Channel selection sets a discovery default, not a
  compatibility check; build identity is for provenance, diagnosis, tested
  defaults, and rollback.
- **Exact consumer pins**: Pin exact SDK versions, commit the lockfile, and
  keep separate immutable pins for packaged UI and daemon assets. Qualify those
  combinations against the contracts you use (a tested manifest describes a
  known-good set, not an exclusive allowlist). For example:

  ```sh
  npm install --save-exact @runtimed/node@0.5.6-nightly.123456789
  ```

  Do not use a range like `^0.5.6-nightly.123456789`. Prereleases sort below
  their matching stable version, so ranges can silently upgrade to stable
  `0.5.6` (or a later stable release).

## Publication and recovery

### Concurrency and queue limits

- The publisher serializes runs with GitHub's `queue: max` and queries the
  public registry before each publish so a newer nightly does not cancel a
  waiting stable publish.
- GitHub's [queue limit](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  is 100 pending runs. If a run is canceled by that limit or a maintainer,
  recover it with its upstream run ID and successful attempt.
- Workflow concurrency serializes runs of this workflow only. It does not
  coordinate external maintainers or older workflows changing tags between
  preflight and `npm publish` (the two steps are not atomic compare-and-set).

### Immutability and tag safety

- Existing immutable versions are never overwritten. Existing nightly versions
  must match the expected source SHA and upstream run.
- Registry errors fail closed; they are never treated as evidence that a
  version is absent.
- Older incomplete runs cannot move a dist-tag backwards. If a newer tagged
  version blocks a missing old package, the run fails explicitly; cut a newer
  release instead. Repeating a completed old run does not move the tag back.
- Never treat a partly published native matrix as a completed SDK release.

### Native propagation wait and timeout recovery

- After native `npm publish` succeeds, registry indexing can lag. The wrapper
  job polls every enabled native package's exact version for up to 30 minutes
  (within a 40-minute job budget).
- Missing versions retry; registry errors, invalid metadata, and conflicting
  nightly identities fail immediately. The wrapper re-checks the tag after
  waiting so an older candidate cannot move the channel tag backwards.
- **If polling times out**: Verify the exact native versions and release
  identities on npm. Once all are visible, rerun only the failed **Publish
  wrapper package** job in the same workflow run while `npm-package-wrapper`
  and `npm-release-tools` artifacts are still retained. Do not rebuild or
  republish native packages to recover a registry delay.

### Summaries, legacy packages, and dist-tag permissions

- Each job summary records whether its package was newly published or already
  existed, with registry source metadata when available. The wrapper result
  artifact separates requested release metadata from registry provenance
  (legacy stable packages may have no recorded source).
- An existing wrapper must already contain the requested native dependency set.
  Adding a platform to a previously published stable version requires a new
  stable version; rerunning cannot retrofit it. Legacy stable native packages
  may lack release metadata, so an existing version does not prove the
  requested source was newly delivered.
- The workflow uses `npm publish --tag` only, not `npm dist-tag`, so it needs
  only direct-publish permission. Investigate wrong tags or contents manually;
  moving a dist-tag cannot repair immutable package contents.

## First nightly qualification

Before relying on the first nightly in an embedding app:

1. **Verify trusted publishing**: Confirm every enabled package trusts
   `nteract/nteract` and `publish-npm.yml` with direct `npm publish` allowed
   (verify existing settings instead of replacing them). See npm's
   [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).
   Linux/Windows ARM64 bootstrap and npm account permissions are external
   prerequisites that source checks cannot verify.
2. **Observe a normal release**: Let a successful upstream release trigger the
   publisher. Inspect source SHA, derived version, publication results, and
   provenance. Confirm `nightly` points to the new version and `latest` did not
   move.
3. **Verify clean installation**: Install that exact wrapper version in a clean
   project on each supported consumer platform. Confirm the native addon loads
   and the exported relay and Electron entry points work. Track package
   publication, package loading, and app qualification separately.
4. **Qualify the host integration**: Update consumer pins and lockfile in a
   reviewable change. Exercise the packaged Electron UI and scripting runtime
   against the selected daemon: synced-cell execution, shared outputs,
   reconnect, and compatible existing-daemon discovery. Test older/newer
   component combinations before claiming a compatibility window, and confirm
   incompatible live daemons remain untouched.

Source tests and green builds do not prove npm account permissions or registry
installability. This workflow does not declare an embedded app ready or update
its pins.
