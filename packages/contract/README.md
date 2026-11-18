# @runtimed/contract

The names a notebook server and its clients must agree on. A server that hosts
notebooks imports these instead of the `runtimed` client library.

Each contract has its own entry point, named for the Rust crate that owns it.
There is no root entry, so an import says which contract it depends on.

| Entry point | File | Owner |
| --- | --- | --- |
| `@runtimed/contract/wire` | `src/wire-constants.ts` | `crates/notebook-wire`: frame type bytes and size limits |
| `@runtimed/contract/requests` | `src/request-types.ts` | `crates/notebook-protocol`: `NotebookRequest` and `NotebookResponse` shapes |
| `@runtimed/contract/runtime-state` | `src/runtime-state.ts` | `crates/runtime-doc`: runtime state document types |
| `@runtimed/contract/scopes` | `src/scopes.ts` | `crates/nteract-identity`: connection scopes, re-exported from `@nteract/identity` |

`wire-constants.ts` and `request-types.ts` are generated. Do not edit them by
hand; run `cargo run -p notebook-protocol --bin generate-runtimed-types`, and
`cargo test -p notebook-protocol` checks that they are current.
`runtime-state.ts` is written by hand and mirrors `runtime_doc`.

The package has no npm dependencies and no host APIs. Its one workspace
dependency is `@nteract/identity`, which holds the scope lattice. `runtimed`
re-exports these names, so code that imports them from `runtimed` keeps
working.
