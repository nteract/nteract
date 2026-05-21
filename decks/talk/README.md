# nteract Slidev output embed

This deck is the fresh replacement for the old Slidev prototype in PR #2779.
It tells the MathNet / agents-using-REPLs story while using the current
`createNteractOutputEmbed` contract instead of a custom Vue iframe bridge.

## What this proves

- Slidev can embed resolved notebook outputs without React.
- MathNet sample outputs can be shown deterministically while still exercising
  Sift's Arrow-stream renderer path.
- The deck uses the same sandbox, host context, size notifications, teardown,
  and renderer bundle path as the notebook app.
- The dev relay is live: Slidev reads relay health/config, and the Sift demo
  proxies `sift_wasm.wasm` through the worktree daemon blob server.
- Blob-backed output manifests can be rendered through an injected
  `OutputBlobResolver`, so localhost daemon blobs and future HTTPS storage use
  the same boundary.

## Run

```bash
pnpm --dir decks/talk install
pnpm --dir packages/runtimed-node build:debug
pnpm --dir decks/talk dev
```

Start the worktree daemon first. By default, the deck uses the local
`@runtimed/node` binding to resolve that dev daemon. Set
`NTERACT_SLIDEV_DAEMON=nightly` or `RUNTIMED_SOCKET_PATH` when you want to point
the presentation at an installed daemon instead.

```bash
cargo xtask dev-daemon
```

The deck pins `vite` to `npm:@voidzero-dev/vite-plus-core@0.1.16` because it
reuses the same Vite plugin stack as `apps/notebook` and `apps/renderer-test`.
The Sift table fixture serves Arrow bytes from Slidev, but loads Sift WASM from
the daemon blob-server surface that notebook outputs use.
