import { Repo, interpretAsDocumentId, stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { SyncHost } from "./host.mjs";
import { framePipe } from "./wire.mjs";

export const newId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
export const urlOf = (hex) =>
  stringifyAutomergeUrl({
    documentId: interpretAsDocumentId(Uint8Array.from(Buffer.from(hex, "hex"))),
  });

let sessions = 0;

export async function host(options = {}) {
  return new SyncHost({ bytes: new MemoryByteStore(), ...options }).load();
}

/** A browser: Repo 3 over AutomergeSyncBackend, connected to `host`. */
export async function browser(
  syncHost,
  identity,
  { bytes = new MemoryByteStore(), connect = true, ...options } = {},
) {
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(bytes),
    ...options,
  });
  const repo = new Repo({ backend });
  const n = ++sessions;
  const client = {
    repo,
    backend,
    bytes,
    identity: {
      sessionId: `s${n}`,
      senderId: `sender-${n}`,
      role: "editor",
      ...identity,
    },
  };
  if (connect) reconnect(client, syncHost);
  return client;
}

export function reconnect(client, syncHost) {
  const link = framePipe();
  client.link = link;
  client.conn = syncHost.accept(link.host, client.identity);
  client.backend.addConnection(link.client, { hostId: syncHost.hostId });
  return link;
}

/** A connection with no Repo: frames in, frames out. */
export function raw(syncHost, identity) {
  const link = framePipe();
  const conn = syncHost.accept(link.host, identity);
  const frames = [];
  link.client.onMessage((f) => frames.push(f));
  return { link, conn, frames };
}

export async function until(predicate, { timeout = 5000, label = "condition" } = {}) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const idle = () => new Promise((r) => setTimeout(r, 20));
