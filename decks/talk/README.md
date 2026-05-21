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
pnpm --dir decks/talk dev
```

Start the worktree daemon first. The Sift table fixture serves Arrow bytes from
Slidev, but it loads Sift WASM from the same dev daemon blob-server surface that
notebook outputs use:

```bash
cargo xtask dev-daemon
```
