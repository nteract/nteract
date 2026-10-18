# Publishing the npm packages

`publish-npm.yml` builds the Node SDK, `@nteract/sift`, and `@nteract/sift-csv`, and
resolves the independently packed `@runtimed/wasm`, after a successful
**Stable Release** or **Nightly Release** run. It retains the existing npm
trusted-publisher identity; the build jobs have no publication credentials, and
the publication jobs do not build source or install project dependencies.

Each package publishes from its own checked-in `package.json` version. Daemon
discovery applies to the Node SDK only.

| Upstream release | npm version | Dist-tag | Default daemon discovery |
|---|---|---|---|
| Stable | Checked-in package version | `latest` | Stable channel |
| Nightly | `<package version>-nightly.<upstream run ID>` | `nightly` | Nightly channel |

The upstream run supplies the immutable source SHA. Repeating that run does not
allocate a new npm version. The upstream attempt is recorded in the workflow's
release plan, but does not change the package version or its provenance metadata.
The publisher rejects failed releases, foreign repositories, and runs of other
workflows. A manual run requires the upstream release run ID and attempt; it does
not publish an arbitrary source ref.

The publisher follows the upstream release's source policy: a successful release
dispatched from a feature branch is eligible too, including promotion of npm's
`nightly` tag. Dispatch upstream releases only from refs intended for that channel.
The manual npm workflow itself must run from the repository's default branch;
its validated upstream run supplies the build source.

`@runtimed/node`, its native platform packages, `@nteract/sift`, and
`@nteract/sift-csv` get nightly versions. `@nteract/pi` continues to publish through the stable path.

## Sift

`@nteract/sift` follows the same channels from its own checked-in version:
stable publishes it to `latest`, and nightly publishes
`<Sift version>-nightly.<upstream run ID>` to `nightly`. Its pack job builds the
Sift WASM, stamps the version, runs `test:package` against the packed consumer,
then packs the tarball it uploads. It shares the upstream source and run identity
with the Node SDK but no jobs, so a failed native build doesn't block Sift and a
Sift failure doesn't block the SDK. Publication waits for the `NPM_SIFT_ENABLED`
bootstrap gate in [RELEASING.md](../../RELEASING.md#published-bindings).
Consumers should pin an exact Sift version, as with the SDK.

`@nteract/sift-csv` is the same shape with its own plan, `pack-sift-csv` and
`publish-sift-csv` jobs, artifact (`npm-package-sift-csv`), checked-in version,
and `NPM_SIFT_CSV_ENABLED` gate. Its pack job builds `crates/sift-csv-wasm`
through `cargo xtask wasm sift-csv`. The two Sift packages do not depend on each
other at publish time; a host pins each independently.

## Runtime WASM

`@runtimed/wasm` is an independent, dependency-free ESM package with generated
bindings, declarations, an explicit binary export, and build metadata. Existing
desktop/cloud imports and the private `runtimed` TypeScript package are unchanged.
See its [initialization examples](../../packages/runtimed-wasm/README.md).

**Build WASM npm package** (`build-wasm-npm.yml`) follows successful stable and
nightly releases. It verifies the release's retained
`release-wasm-<run ID>-<attempt>` artifact, including source, channel, successful
WASM job attempt, artifact digest, and file checksums. A successful earlier WASM
attempt can be reused when only failed release jobs were rerun. It copies the
matching generated JavaScript, binary, and declarations without recompilation,
adds notices from the release source's dependency graph, and packs once.

The final tarball is exercised in an isolated consumer: synchronous and async
byte initialization, precompiled-module and Response initialization, the default
paired binary URL, document mutation/save, and TypeScript NodeNext/bundler
resolution. These Node/WASM checks do not launch a daemon or kernel, or establish
browser, desktop, or host compatibility. `build-info.json` records source and
release identity, protocol source constants, Cargo.lock and genesis hashes,
and the shipped WASM checksums. The external `candidate.json` also records the
original release artifact ID/digest, build attempt, every packed file checksum,
and the final tarball SHA-256/SHA-512.

The producer retains `npm-wasm-<release run ID>-<release attempt>` for 90 days.
Duplicate events, producer reruns, and manual publisher retries reuse the first
successful packed candidate. A failed/incomplete pack with no retained
candidate may retry. If a successful pack's artifact expires or is deleted,
recovery fails explicitly: create a new release identity; do not repack the old
one. Once packing succeeds, expiry of the original WASM input does not prevent
publishing the sealed tarball while that tarball is still retained.

The existing **Publish npm packages** workflow independently resolves that
producer and passes only verified data and trusted helpers to its WASM OIDC job.
It waits up to 30 minutes for the producer, then fails with a retry instruction.
No existing SDK, Sift, CSV, or Pi job depends on that wait or WASM success. The
publisher never builds, repacks, installs project dependencies, or runs package
scripts. Both stable and nightly existing versions must have the same source
identity and registry tarball SHA-512. It refuses conflicting immutable versions
and stale channel promotion, and leaves existing dist-tags unchanged.
For a conflicting stable version, bump the checked-in package version and create
a new release. Retrying the original release reuses its original bytes and cannot
replace an immutable npm version.

Publication defaults off under `NPM_WASM_ENABLED`. The producer still packs and
tests while disabled. Bootstrap and trusted-publisher configuration require a
maintainer; see [RELEASING.md](../../RELEASING.md#published-bindings). To recover,
dispatch the producer if its initial pack failed, then dispatch **Publish npm
packages** with the same successful upstream release run ID/attempt. Neither
manual path accepts arbitrary source refs. Sources predating this package skip
WASM without changing existing package eligibility.

For the one new npmjs.com package in this change, use these settings:

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

Create the package first, then configure its trusted publisher in the package's
Settings. Do that when a tested candidate is ready: npm requires the first
successful trusted publish within **two days** of creating the configuration.
Once that first publish validates the configuration, this initial deadline no
longer applies.
The hosted workflow uses Node 24 and verifies npm 11.5.1 or newer. CI needs no
long-lived npm token. See npm's [trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/)
and [scoped public publication guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
Keep the gate disabled until the package, scope access, and publisher settings
are confirmed. After the first stable release, deprecate the placeholder.

## Package coordination and daemon compatibility

The JavaScript wrapper and its native addons are one package implementation.
Their versions must match exactly, and every enabled native package must exist
before the wrapper is published. Linux and Windows ARM64 each remain behind the
bootstrap gates described in [RELEASING.md](../../RELEASING.md#published-bindings).
Both default off; their tarballs are still built and tested. Enable each gate
only after its package exists and its trusted-publisher configuration is verified.

These package pins do not require an independent daemon or embedded UI to have
the same release version or source commit. Normal daemon admission follows the
[wire and semantic API contract](../adr/daemon-service-repair-and-semantic-compatibility.md).
Optional connection capabilities and the embedded UI/host bridge have their own
contracts. Channel selection supplies a discovery default; it is not an
additional compatibility check. Build identity is useful for provenance,
diagnosis, tested defaults, and rollback.

Consumers should select an exact SDK version before dependency installation,
commit the resulting lockfile, and retain separate immutable pins for packaged
UI and daemon assets. Qualify those combinations against the contracts they
actually use. A manifest of tested components would describe a known working
combination, not an exclusive list of builds permitted to connect.

For example, use `npm install --save-exact @runtimed/node@0.5.6-nightly.123456789`
with the actual published version. A prerelease sorts below its matching stable
version, and a range such as `^0.5.6-nightly.123456789` can select stable `0.5.6`
on a later resolution. Use exact versions and keep the lockfile; even a range
based on the next patch would allow a future stable release to replace it.

## Publication and recovery

The publisher serializes its runs with GitHub's `queue: max` and checks the public
registry before each publication. This preserves pending runs instead of
replacing a waiting stable publish with a newer nightly. GitHub's
[queue limit](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
is 100 pending runs; if a run is canceled by that limit or by a maintainer,
recover with its upstream run ID and successful attempt. An existing immutable
version is not overwritten. Existing nightly
versions must identify the expected source SHA and upstream run. Registry errors
are failures, not evidence that a version is absent.

Workflow concurrency serializes runs of this updated publisher only. It cannot
serialize an external maintainer or an older workflow changing npm tags between
the registry check and publication. Coordinate those writes separately; the
registry preflight and `npm publish` are not an atomic compare-and-set operation.

An older incomplete run must not move a dist-tag backwards. If a newer tagged
version prevents publication of a missing old package, the run fails explicitly.
Use a newer successful release to produce a complete package set. Repeating a
completed old run does not move the tag back to it. Do not treat a partly
published native matrix as a completed SDK release.

Each publisher job records whether its package was newly published or already
existed in its job summary, along with registry source metadata when available.
The wrapper result artifact separates the requested release from registry
provenance; a legacy stable package can have no recorded source.

An existing wrapper must also have the requested native dependency set. If a
stable version was published before a platform was added, publish a new stable
package version; rerunning cannot retrofit that platform into the old wrapper.
Legacy stable native packages may have no release metadata, so an existing
version is not proof that the requested source was newly delivered.

The workflow uses `npm publish --tag` and does not use `npm dist-tag` to repair
tags. This workflow needs only npm's direct-publish permission, not the separate
trusted-publisher permission for dist-tag management. A package
that already exists with an incorrect tag or contents needs separate maintainer
investigation; changing a dist-tag cannot repair immutable package contents.

## First nightly qualification

Before relying on the first nightly in an embedding app:

1. Confirm every enabled package trusts `nteract/nteract` and the workflow
   filename `publish-npm.yml`, with direct `npm publish` allowed. Verify existing
   settings rather than replacing them. npm's [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/)
   describes the required hosted runner, CLI, and OIDC configuration.
   The initial Linux/Windows ARM64 package bootstrap and each package's account
   permissions remain external prerequisites; a passing source check does not
   establish that they are configured.
2. Let a successful upstream release trigger the publisher normally. Inspect
   its source SHA, derived version, publication results, and provenance. Confirm
   `nightly` points at that version and `latest` did not change.
3. Install that exact wrapper version in a clean project on each supported
   consumer platform. Confirm its native addon loads and its exported relay and
   Electron entry points are usable. Keep package publication, package loading,
   and application qualification as separate results.
4. Update a consumer's pins and lockfile in a reviewable change. Exercise the
   packaged Electron UI and scripting runtime against the selected daemon,
   including synced-cell execution, shared outputs, reconnect, and compatible
   existing-daemon discovery. Test older/newer component combinations before
   claiming a compatibility window. Leave incompatible live daemons intact.

Source tests and a successful build do not verify npm account permissions or
the first actual registry installation. The publishing workflow does not declare
an embedded application release ready or change its component pins.
