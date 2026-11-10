# Pages workspace

The npm workspace for the [Pages product](pages/README.md). The application
is in [pages/](pages/). This directory holds what it builds on: the pinned
Repo 3 package, its source-hash-checked patches, the Wordgard patch, and the
identity-provider fixture the Pages tests share (`auth-fixtures.mjs`). Start
with Pages for the application, editor, MCP tools, and deployment workflow.

The workspace uses npm and its own `package-lock.json`. The repository's pnpm
workspace excludes it, so a root `pnpm install` neither installs nor needs it.

The [infrastructure memo](../../docs/memos/authenticated-automerge-app-substrate/README.md) and
[document-contract memo](../../docs/memos/extensible-automerge-document-contracts.md)
describe the research this grew from. [UPSTREAM.md](UPSTREAM.md) records the
pinned source and the patches.

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

The test command selects `tsconfig.test.json`. It maps a `runtimed` import to
`packages/runtimed/src/scope-capabilities.ts`, so code loaded from this
directory needs no root dependency installation.
`pages/worker/host-busy.test.mjs` checks that worker code loads under it. The
focused CI job uses the same standalone setup.

## What the root tests cover

- `document-record.test.mjs`: the document-record patch
  ([UPSTREAM.md](UPSTREAM.md)).
- `patch-wordgard.test.mjs` and `setup.test.mjs`: the editor patch and setup's
  acquisition modes.
- `npm run test:contract`: Repo 3's backend contract against Pages'
  `AutomergeSyncBackend`.
