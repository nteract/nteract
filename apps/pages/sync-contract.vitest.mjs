// Repo 3's backend contract, imported unmodified from the pinned upstream
// source. Its fixtures are opaque one-byte payloads, so the backend runs with
// `strict: false` (see sync/backend.mjs); Automerge behaviour is
// covered by sync/*.test.mjs.
import { backendContract } from "./upstream/packages/automerge-repo/test/sedimentree/backend.contract.ts";
import { AutomergeSyncBackend } from "./sync/backend.mjs";
import { DocStore, MemoryByteStore } from "./sync/doc-store.mjs";

backendContract(
  "AutomergeSyncBackend",
  () =>
    new AutomergeSyncBackend({
      store: new DocStore(new MemoryByteStore()),
      strict: false,
    }),
);
