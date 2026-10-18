# Authenticated Automerge integration spike

Disposable research fixture for adding nteract account authorization to upstream
Repo 3/Subduction. It is not a deployable service or a replacement for Pages or
the notebook room host. No production dependency or document format changes.

The [infrastructure memo](../README.md)
and [document-contract memo](../../extensible-automerge-document-contracts.md)
describe the research questions. [UPSTREAM.md](UPSTREAM.md) records the pinned
source, adapter patch, runtime evidence, and integration limits.

## Run

From this directory, with Node 22.13+ (tested with 24.22), Git, and npm:

```sh
npm run setup
npm test
```

Setup fetches an exact upstream commit, installs locked dependencies without
lifecycle scripts, applies a source-hash-checked adapter patch, and builds the
two upstream packages. Generated sources and dependencies remain ignored.
Tests generate their own credentials and temporary document storage. Provider
responses are fixture data; no Anaconda account, API key, or live document is
needed. Runtime tests use real upstream WASM over an in-process byte transport.

The test command selects `tsconfig.test.json`, which resolves the production
identity module's `runtimed` capability re-export directly to the real
`packages/runtimed/src/scope-capabilities.ts`. This avoids loading the unrelated
package barrel or relying on a root dependency installation; it does not replace
credential verification. The focused CI job uses the same standalone setup.

## The boundary being tested

1. `auth.mjs` reuses the production OIDC ID-token and Anaconda API-key verifiers
   from `apps/notebook-cloud`. It returns an immutable, recognized identity.
2. `policy.mjs` binds that identity to an Ed25519 key by a single-use signed
   challenge. ACLs, profiles, and runtime authority are trusted host state.
3. `backend.mjs` translates host decisions to existing native Subduction policy
   callbacks. A small Repo adapter patch forwards those options across resets.
4. Signed presence is projected to the account and driver from host enrollment,
   without trusting identity claims in message contents.

The wrapper deliberately isolates issuer/endpoint principal namespaces by
default. Production currently defaults OIDC to `user:oidc` and lets API keys
inherit the configured OIDC namespace before falling back to `user:anaconda`.
This fixture requires both namespaces to be configured to join their subjects;
that is an experimental mapping policy, not a change to production identities.

The current fixture permits reader presence while rejecting reader content
writes. A runtime-profile writer needs separate runtime authority. This is a
role gate; it does not implement the actual RuntimeStateDoc semantic validator.

## Initial results and next decisions

The clean setup and 19 tests passed on Node 24.22; the isolated fixture also
passed on Node 22.23 without root dependencies. Tests cover verified identity,
key possession, role and scope intersections, concurrent edits, unknown-content
preservation, live content/presence revocation, and disk failure/restart/retry.
The typed reader fixture diagnoses unsupported content and edits known fields
without writing its narrower projection back over the document.

Two findings need further design:

- A failed write/flush is not rollback. The local optimistic edit remains and a
  later retry may persist it. Application receipts must express uncertainty and
  retry/idempotency semantics explicitly.
- A current session lease is not durable historical authorship. This policy
  conservatively blocks records by expired authors, even if relayed by a current
  writer. Durable provenance and admission must be designed before relaxing it.

Browser login/state/PKCE, WebSocket transport, editor integration, actual runtime
schema validation, concurrent migration, remote durable receipts, celld/S3/R2,
and performance/cost remain separate qualification lanes. API-key provider
revocation can remain cached for up to 60 seconds plus the admission lease;
host ACL/key revocation is checked by policy on subsequent operations. Previously
received data cannot be recalled.
