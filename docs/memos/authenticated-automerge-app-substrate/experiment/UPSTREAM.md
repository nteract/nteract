# Upstream integration lane

This disposable experiment builds the two packages at Repo revision
`afec0444191a5a662e065f24193bef58ab07122a`, with Automerge `3.5.0` and
Subduction `0.23.0`. It requires Node >=22.13, Git, and npm.

```sh
npm run setup
npm test
```

Run from this directory. Setup fetches the exact public upstream commit into
`.source-cache`, copies the two packages into ignored `upstream/`, verifies the
backend source hash, applies the explicit patch in `patch-upstream.mjs`, installs
from `package-lock.json` without dependency lifecycle scripts, and builds both
TypeScript packages. `upstream-provenance.json` records the revision and before /
after hashes. Existing dirty source caches are rejected. No canonical upstream
checkout, global installation, or live service is changed.

The test command selects `tsconfig.test.json`, which resolves the production
identity module's `runtimed` capability re-export directly to the real
`packages/runtimed/src/scope-capabilities.ts`. This avoids loading the unrelated
package barrel or relying on a root dependency installation; it does not replace
credential verification. The focused CI job uses the same standalone setup.

The only upstream runtime modification forwards `policy` and `ephemeralPolicy`
from `SubductionBackend` into the existing native constructor. Published
Subduction 0.23.0 already contains these interfaces; this experiment does not
need a Rust/WASM fork, custom binary, wire-format change, or replacement Repo.
Option properties are retained across native engine resets. The policy bridge
normalizes signing keys and generated Repo document IDs to 32-byte hexadecimal
IDs. Repo 3 reserves native IDs with a zeroed final 16 bytes for short legacy
IDs; the bridge mirrors that normalization and rejects ambiguous long-form ACL
registrations. Integration tests use generated 32-byte IDs. Legacy 16-byte
document interoperability remains unqualified.

## Runtime evidence

`upstream.test.mjs` runs real upstream Repo handles, Automerge WASM, Subduction
WASM, Ed25519 handshakes, signed records, native authorization, and ephemeral
pubsub. Only the framed byte wire is an in-process test transport. The hosted
application's production OIDC/API-key verifier is exercised with generated
credentials and a local provider-response fixture; no real provider is contacted.

- Concurrent edits preserve unknown extension fields and an unsupported block.
- OIDC and API-key credentials can map to one account with distinct signing keys
  and drivers, after proof of key possession.
- Readers receive history and publish presence but cannot mutate the host copy.
  A `none` peer's read is denied; its store remains empty.
- A live reader changed to `none` receives neither subsequent content nor
  presence. An authorized peer receives the same edit and presence as a positive
  control; native fetch/subscriber-policy calls confirm the denied peer is gated.
- Revoking an already-connected signing key rejects synchronization at the
  native fetch gate and denies presence publication. The pending edit stays
  local; a current writer still updates the same host document as a positive
  control. Cached data already received cannot be recalled.
- An ordinary writer cannot mutate a runtime-profile document without separate
  runtime authority. This tests the authority gate, not real RuntimeStateDoc
  schema validation or field-level role enforcement.
- Presence retains its verified signing sender. Display identity and driver are
  projected through the registry, ignoring forged payload identity fields.

`persistence.test.mjs` uses atomic per-key filesystem replacement, a generated
signer seed, and a separate Node process to reopen the persisted document. A
sustained injected disk failure rejects change and flush; optimistic memory still
contains the unaccepted edit. Restart recovers only accepted history, a subsequent
write persists, and reopening does not rewrite loaded history. This does not
claim fsync/power-loss durability, batch transactions, or remote durable receipts.

A second persistence test clears the storage fault and retries `flush()` without
calling `change()` again. The exact same optimistic document and heads persist
and are recovered by another Node process, with no repair writes. This pins the
failed-flush-is-not-rollback behavior separately from the sustained-failure
recovery test. Callers still need explicit receipt/idempotency semantics before
using flush outcomes as an application transaction protocol.

`relay.test.mjs` uses an author, intermediate writer, and enforcing host. Native
`authorizePut` receives distinct requestor and original-author keys. After the
author signs an edit and the relay stores it, expiring only the author lease
causes the host to reject that relayed history while the relay remains authorized.

## Remaining qualification

This is Node integration evidence, not browser/IndexedDB/WebSocket deployment,
cross-version custom WASM/editor compatibility, cost or performance benchmarking,
S3/R2 persistence, concurrent schema migration, partial-batch recovery, or a full
production attribution design. Unknown-field survival is shown for in-place
edits, not every editor projection or Markdown export/import round trip.

The policy conservatively requires current admission for both requesting peer
and signed record author. Historical records from an expired or revoked author
can therefore fail admission even when a current writer relays them. A durable
authorship/acceptance record needs its own design; do not weaken this by treating
the relay as author or accepting arbitrary historical keys. The native sender
and record signer do not automatically attest every inner Automerge change actor.
The registry is process-local test state and must not be used as a production
account/ACL store. Revoked keys cannot enroll again within this registry; a real
host must persist revocation state across restart. Driver attribution is host enrollment metadata, not proof of
a software vendor.

Enrollment proofs in this fixture sign host-constructed JSON inside one process.
A real client must validate the expected protocol, origin, challenge ID, public
key, principal, driver, and expiry before signing; it must not expose the same
transport/record key as a signer for arbitrary bytes from a remote endpoint.
Hostile enrollment endpoints and client-side challenge validation remain
unqualified here.

Policy denial leaves optimistic edits on the client. The user-facing rollback,
export, or reauthorization workflow remains to be designed. Repo3's deprecated
`handle.isReady()` does not indicate lookup admission; the negative lookup test
uses query progress, cancellation, policy evidence, and stored records instead.
