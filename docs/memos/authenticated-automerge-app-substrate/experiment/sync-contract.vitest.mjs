// Repo 3's backend contract, imported unmodified from the pinned upstream
// source. Its fixtures are opaque one-byte payloads, so the backend runs with
// `strict: false` (see pages/sync/backend.mjs); Automerge behaviour is
// covered by pages/sync/*.test.mjs.
import { backendContract } from "./upstream/packages/automerge-repo/test/sedimentree/backend.contract.ts";
import { AutomergeSyncBackend } from "./pages/sync/backend.mjs";
import { DocStore, MemoryByteStore } from "./pages/sync/doc-store.mjs";

backendContract(
  "AutomergeSyncBackend",
  () =>
    new AutomergeSyncBackend({
      store: new DocStore(new MemoryByteStore()),
      strict: false,
    }),
);
