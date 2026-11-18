# @runtimed/contract

Scope: `packages/contract/**`. [README.md](README.md) lists the entry points.

The names a notebook server and its clients must agree on.

- One entry point for each contract, named for the Rust crate that owns it.
  There is no root entry. A new contract gets a new entry point in
  `package.json`; don't widen an existing one to hold it.
- `wire-constants.ts` and `request-types.ts` are generated. Change the Rust
  type, run the generator named in the README, and commit both.
  `runtime-state.ts` is written by hand; change it in the same pull request as
  `runtime_doc`.
- Keep it to shapes, constants, and the small pure helpers that go with them.
  Stores, transports, and sync belong in `runtimed`.
- No npm dependencies, no host APIs, and no import from `runtimed`. The one
  workspace dependency is `@nteract/identity`, for the scope lattice.
- A server pins these names. Rename or remove an export on purpose, with the
  Rust change and every caller in the same pull request. Don't leave an alias
  for the old name.
- Wire changes still follow [the wire guide](../../crates/notebook-wire/AGENTS.md):
  Rust handling, generated types, `runtimed`, and tests move together.
