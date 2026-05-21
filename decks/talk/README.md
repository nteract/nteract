# nteract Slidev output embed

This deck is the fresh replacement for the old Slidev prototype in PR #2779.
It tells the MathNet / agents-using-REPLs story while using the current
`createNteractOutputEmbed` contract instead of a custom Vue iframe bridge.

## What this proves

- Slidev can embed resolved notebook outputs without React.
- MathNet sample outputs can be shown deterministically without a live daemon.
- The deck uses the same sandbox, host context, size notifications, teardown,
  and renderer bundle path as the notebook app.
- The dev relay is optional and limited to health/config plus future live blob
  resolution.
- Blob-backed output manifests can be rendered through an injected
  `OutputBlobResolver`, so localhost daemon blobs and future HTTPS storage use
  the same boundary.

## Run

```bash
pnpm --dir decks/talk install
pnpm --dir decks/talk dev
```

If you want the relay health slide to report a live daemon, start the worktree
daemon first:

```bash
cargo xtask dev-daemon
```

The static MathNet demo outputs do not require a daemon.
