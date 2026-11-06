// A raw peer for a Page: Repo 3 over AutomergeSyncBackend on an
// authenticated socket, with none of the viewer's or tools' rules. Smokes use
// it to write what a browser or a misbehaving client would.
import { Repo } from "@automerge/automerge-repo";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { socketTransport } from "../sync/wire.mjs";

/** `discovery` is the /api/connect body for `pageId`. */
export async function plainPeer({ origin, pageId, cookie, discovery, features = [] }) {
  const address = new URL(`/api/sync?page=${encodeURIComponent(pageId)}&sync=automerge`, origin);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  if (discovery.activity?.epoch)
    address.searchParams.set("activity_epoch", discovery.activity.epoch);
  if (features.length) address.searchParams.set("schema_features", [...features].sort().join(","));
  const socket = new WebSocket(address, { headers: { cookie, origin } });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
  });
  const repo = new Repo({ backend });
  const transport = socketTransport(socket);
  backend.addConnection(transport, { hostId: discovery.serverSenderId });
  return {
    repo,
    socket,
    transport,
    async close() {
      socket.close();
      await repo.shutdown();
    },
  };
}

/** Resolve with `check()`'s first result that isn't false, retrying every
 * 10 ms; throw its last error, or a timeout, after `timeout` ms. */
export async function eventually(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw error ?? new Error("Condition did not become true");
}
