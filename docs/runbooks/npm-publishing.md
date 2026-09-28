# Publishing the Node bindings

`publish-npm.yml` builds the Node SDK after a successful **Stable Release** or
**Nightly Release** run. It retains the existing npm trusted-publisher identity;
the build jobs have no publication credentials, and the publication jobs do not
build source or install project dependencies.

| Upstream release | npm version | Dist-tag | Default daemon discovery |
|---|---|---|---|
| Stable | Checked-in Node package version | `latest` | Stable channel |
| Nightly | `<Node version>-nightly.<upstream run ID>` | `nightly` | Nightly channel |

The upstream run supplies the immutable source SHA. Repeating that run does not
allocate a new npm version. The upstream attempt is recorded in the workflow's
release plan, but does not change the package version or its provenance metadata.
The publisher rejects failed releases, foreign repositories, and runs of other
workflows. A manual run requires the upstream release run ID and attempt; it does
not publish an arbitrary source ref.

Only `@runtimed/node` and its native platform packages get nightly versions.
`@nteract/pi` continues to publish through the stable path.

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

## Publication and recovery

The publisher serializes its runs and checks the public registry before each
publication. An existing immutable version is not overwritten. Existing nightly
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

An existing wrapper must also have the requested native dependency set. If a
stable version was published before a platform was added, publish a new stable
package version; rerunning cannot retrofit that platform into the old wrapper.
Legacy stable native packages may have no release metadata, so an existing
version is not proof that the requested source was newly delivered.

The workflow uses `npm publish --tag` and does not use `npm dist-tag` to repair
tags. npm OIDC publishing does not supply general npm account access. A package
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
