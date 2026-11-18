# @nteract/identity

Identity rules that nteract notebooks and Pages must compute the same way. Each
product imports them by package name, so there is one copy to change.

- `scope-capabilities.ts`: the connection-scope lattice (`ConnectionScope`,
  `CONNECTION_SCOPES`, and the `allows*` predicates). It is generated from
  `nteract_identity::ConnectionScope` in `crates/nteract-identity`. Do not edit
  it by hand; run `cargo run -p notebook-protocol --bin generate-runtimed-types`
  and `cargo test -p notebook-protocol` checks that it is current.
- `notebook-actor-color.ts`: the cursor palette and the deterministic color for
  an actor's durable identity, plus a readable foreground for any palette color.
- `invite-email.ts`: `normalizeInviteEmail`, the lookup form of an invite or
  verified email.
- `authenticated-connection.ts`: `AuthenticatedConnection`, the plain-data
  identity a host attaches to a request or socket once it has authenticated
  it, and its provider and transport metadata.

The package has no runtime dependencies and no host APIs. `runtimed` re-exports
the scope and color names, so notebook code that imports them from `runtimed`
keeps working.

Pages is not in the pnpm workspace. It resolves `@nteract/identity` through the
`paths` entry in `apps/pages/tsconfig.json`, which its esbuild build and `tsx`
test runner both read.
