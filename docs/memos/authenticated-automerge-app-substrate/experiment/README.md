# Authenticated Automerge integration fixture

The shared workspace for the [Pages product](pages/README.md): the pinned
Repo 3 package Pages builds on, its source-hash-checked patches, and the
production identity wrapper the Pages host and tests reuse. Start with Pages
for the application, editor, MCP tools, and deployment workflow. Production
notebook dependencies and document formats remain unchanged.

The [infrastructure memo](../README.md) and
[document-contract memo](../../extensible-automerge-document-contracts.md)
describe the research questions. [UPSTREAM.md](UPSTREAM.md) records the pinned
source and the patches.

## Run

From this directory, with Node 22.13+, Git, and npm. The focused CI job uses Node 24:

```sh
npm run setup
npm test
```

Setup fetches an exact upstream commit, installs locked dependencies without
lifecycle scripts, applies the source-hash-checked patches, and builds the
Repo package. Generated sources and dependencies remain ignored.
For a controller that separates online acquisition from offline execution,
`node setup.mjs --acquire-only` requires a regular `package-lock.json` matching HEAD
and stops after installation and patching, before compilation. It never falls back
to `npm install`. Run `npm run build` before tests in the offline phase. The flag
does not isolate networking itself; the host must enforce a private network namespace.
Normal `npm run setup` retains its combined acquisition/build behavior.
Tests generate their own credentials. Provider responses are fixture data; no
Anaconda account, API key, or live document is needed.

The test command selects `tsconfig.test.json`, which resolves the production
identity module's `runtimed` capability re-export directly to the real
`packages/runtimed/src/scope-capabilities.ts`. This avoids loading the unrelated
package barrel or relying on a root dependency installation; it does not replace
credential verification. The focused CI job uses the same standalone setup.

## What the root tests cover

- `auth.test.mjs`: `auth.mjs` reuses the production OIDC ID-token and Anaconda
  API-key verifiers from `apps/notebook-cloud` and returns an immutable,
  recognized identity. The wrapper isolates issuer and endpoint principal
  namespaces by default; joining their subjects needs both namespaces
  configured. That is an experimental mapping policy, not a change to
  production identities.
- `document-record.test.mjs`: the document-record patch
  ([UPSTREAM.md](UPSTREAM.md)).
- `patch-wordgard.test.mjs` and `setup.test.mjs`: the editor patch and setup's
  acquisition modes.
- `npm run test:contract`: Repo 3's backend contract against Pages'
  `AutomergeSyncBackend`.
