import path from "node:path";
import { defineConfig } from "vite-plus";
import { browserDevRelayPlugin } from "../../apps/notebook/vite-plugin-browser-relay";

const repoRoot = path.resolve(__dirname, "../..");

// Slidev consumes this vite.config.ts when it spins up its dev server.
//
// - browserDevRelayPlugin mounts /__nteract_dev_relay/{config,health,ws}
//   so the deck talks to the same per-worktree dev daemon apps/notebook
//   uses.
// - server.fs.allow opens read access up to the monorepo root so we can
//   `?raw`-import frame.html and the prebuilt renderer bundles from
//   outside decks/talk.
export default defineConfig({
  plugins: [browserDevRelayPlugin({ repoRoot })],
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
