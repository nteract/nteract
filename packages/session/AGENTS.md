# @nteract/session

Scope: `packages/session/**`. [README.md](README.md) lists the modules.

Browser sign-in sessions for nteract notebooks and Pages. This is auth code.

- The maintainer approves every merge that changes this package. An agent
  opens the pull request and stops there.
- Table, column, cookie, and environment variable names are live in deployed
  databases and browsers. Don't rename one in a refactor. A rename is a
  migration with its own plan.
- An update names the row it read. `touchServerSession` fences on the session
  `id` and `generation`. A write by the refresh owner goes through
  `conditionalSessionUpdate`, which also fences on the `lease` value. That
  fence compares the lease value, not `lease_until`: the caller decides whether
  a lease has lapsed when it claims the row. Revocation deletes without a
  fence, and a refresh that held the row then fails its own fence.
- The store takes a `SessionDatabase`, the small part of a D1-style binding it
  calls, and uses Web Crypto. Keep host types and host imports out, so Workers,
  Node, and celld can all run it.
- The store tests run on in-memory `node:sqlite` through that port. Add a test
  at the fence for each new write, and test expiry at the boundary second.
- `apps/notebook-cloud/src/server-oidc.ts` drives the refresh lifecycle: the
  lease claim, the retry delay, the abandoned-lease end, and the wait loop.
  Code that moves here follows the repository state-machine rule: named states
  and events, one pure transition function, effects after the transition.
- Never log or return a session token, a sealed secret, or a key.
