# talk

In-repo Slidev deck. Doubles as:

- the presentation surface for "Give Your Agents REPLs"
- the prototype dev surface for embedding live nteract execution results in slides

The deck imports the same `browserDevRelayPlugin` that `apps/notebook` uses, so it runs against the per-worktree dev daemon with the same token + same-origin auth posture. No publishing required.

## Lives outside the pnpm workspace

`decks/talk` is intentionally outside `apps/*`, so it doesn't inherit the monorepo's `trustPolicy: no-downgrade`. The `@slidev/cli` transitive deps trip that policy; rather than weaken supply-chain checks workspace-wide, the deck stands alone with its own `pnpm-lock.yaml` and uses `link:` deps into `packages/runtimed` and `packages/notebook-host` so source changes flow through immediately.

The `browserDevRelayPlugin` is imported by relative path from `apps/notebook/vite-plugin-browser-relay.ts`. Same plugin, no copy.

## Running

```bash
cd decks/talk
pnpm install
pnpm dev
```

The Slidev dev server boots and mounts the relay at `/__nteract_dev_relay/{config,health,ws}`. The `RelayStatus` component fetches `/health` to confirm the relay is live and pointed at your worktree daemon.

## Layout

```
decks/talk/
├── package.json          # standalone; link: deps to packages/{runtimed,notebook-host}
├── vite.config.ts        # imports browserDevRelayPlugin from ../../apps/notebook
├── slides.md             # talk content + live demo slides
├── components/
│   └── RelayStatus.vue   # smoke test: fetches /__nteract_dev_relay/health
├── composables/
│   └── useNteractSession.ts  # (stub) wasm + sync engine + transport composition
└── tsconfig.json
```
