# Becca WP-12 status

## Summary
- Implemented WP-12 by adding generated `packages/runtimed/src/wire-constants.ts` from Rust `notebook_wire` frame constants and frame-size limits.
- Updated `packages/runtimed/src/transport.ts` to re-export generated constants instead of hand-mirroring frame bytes/caps.
- Removed parser-based Rust drift tests for `transport.ts` frame constants/limits because the duplicate TS table is gone.
- Updated wire protocol docs and cleanup punchlist after tests covered the generator path.

## Files changed
- `crates/notebook-protocol/src/typescript.rs`
- `crates/notebook-protocol/src/protocol.rs`
- `packages/runtimed/src/wire-constants.ts`
- `packages/runtimed/src/transport.ts`
- `crates/notebook-wire/AGENTS.md`
- `docs/adr/typed-frame-v4-wire-protocol.md`
- `docs/adr/cleanup-punchlist.md`
- `.hermes/agent-status.md`

## Tests run with exact results
- `cargo test -p notebook-protocol` — passed: 88 passed, 0 failed; bin/doc tests 0 passed, 0 failed.
- `cargo test -p notebook-wire` — passed: lib/doc tests 0 passed, 0 failed.
- `pnpm --filter runtimed test` — passed with exit code 0; emitted pnpm workspace/platform warnings only.
- `cargo xtask lint --fix` — passed after `pnpm install --frozen-lockfile`: JS/TS formatting and lint passed; Python ruff and ty passed; Rust formatting passed.
- Initial `cargo xtask lint --fix` before installing node modules failed because `vite-plus` was missing from `node_modules`; resolved by `pnpm install --frozen-lockfile` and rerunning.

## PR URL or blocker
- Draft PR: https://github.com/nteract/nteract/pull/3422

## Follow-up needed
- None for WP-12.
