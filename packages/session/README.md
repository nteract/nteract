# @nteract/session

Browser sign-in sessions that nteract notebooks and Pages share: the signing
keyring, the server session store, and the app session a request carries.

- `session-keyring.ts`: the keys behind app-session HMACs and sealed sign-in
  state, read from `NOTEBOOK_CLOUD_APP_SESSION_KEYS` or the single
  `NOTEBOOK_CLOUD_APP_SESSION_SECRET`.
- `oidc-session-store.ts`: the `oidc_login_transactions` and
  `oidc_server_sessions` tables (`OIDC_SESSION_SCHEMA`), session ids, sealing,
  idle and absolute expiry, and the generation-and-lease fence that refresh
  writes go through.
- `app-session.ts`: `CloudAppSession`, the signed app-session cookie, the
  server-session projection, and verified-email proof.
- `session-database.ts`: `SessionDatabase`, the part of a D1-style binding the
  store calls. A Workers `D1Database` satisfies it. `oidcDatabase` returns the
  caller's own binding type.

The package depends only on `@nteract/identity` and uses Web Crypto, so it runs
in Workers, Node and celld. Table, column, cookie and variable names are live
in deployed databases and browsers; changing one is a migration.

The token exchange and refresh flow that drives the store lives in
`apps/notebook-cloud/src/server-oidc.ts`.

Pages is not in the pnpm workspace. It resolves `@nteract/session` through the
`paths` entry in `apps/pages/tsconfig.json`, which its esbuild build and `tsx`
test runner both read.
