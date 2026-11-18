# @nteract/session

Scope: `packages/session/**`. [README.md](README.md) lists the modules.

Browser sign-in sessions for nteract notebooks and Pages. This is auth code.

- The maintainer approves every merge that changes this package. An agent
  opens the pull request and stops there.
- Table, column, cookie, and environment variable names are live in deployed
  databases and browsers. Don't rename one in a refactor. A rename is a
  migration with its own plan.
- Prevent stale writes by checking the row that was read:
  - `touchServerSession` updates only a row with the same session `id` and
    `generation`, subject to its expiry checks.
  - Refresh writes use `conditionalSessionUpdate`. The stored `id`,
    `generation`, and `lease` must match the supplied values.
  - That refresh check compares the lease value, not its expiry time
    (`lease_until`). The caller checks lease expiry when claiming the row.
  - Revocation deletes the session without a generation or lease check. A
    pending refresh then finds no matching row and cannot restore it.
- The store takes a `SessionDatabase`, the small part of a D1-style binding it
  calls, and uses Web Crypto. Keep host types and host imports out, so Workers,
  Node, and celld can all run it.
- The store tests run on in-memory `node:sqlite` through `SessionDatabase`.
  For each new write, test that stale row values cannot overwrite newer state.
  Test expiry at the boundary second.
- `apps/notebook-cloud/src/server-oidc.ts` drives the refresh lifecycle: the
  lease claim, the retry delay, the abandoned-lease end, and the wait loop.
  Code that moves here follows the repository state-machine rule: named states
  and events, one pure transition function, effects after the transition.
- Never log or return a session token, a sealed secret, or a key.
