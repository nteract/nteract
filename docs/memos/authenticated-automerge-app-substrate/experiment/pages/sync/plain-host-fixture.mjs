import { PlainByteStore, PlainSync, treeOf } from "../worker/plain-sync.mjs";
import { DocStore } from "./doc-store.mjs";

/** In-memory Durable Object storage; copies on both sides of the storage boundary. */
export class PlainHostStorage {
  values = new Map();

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    for (const [name, entry] of typeof key === "string" ? [[key, value]] : Object.entries(key))
      this.values.set(name, structuredClone(entry));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values.keys()]
        .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort()
        .slice(0, limit)
        .map((key) => [key, structuredClone(this.values.get(key))]),
    );
  }

  async sync() {}
}

/** Test/benchmark host. PlainSync itself owns the Repo/backend/trusted framePipe wiring. */
export async function plainHostFixture({
  documentId,
  bytes,
  heads,
  storage = new PlainHostStorage(),
}) {
  if (bytes)
    await new DocStore(new PlainByteStore(storage)).compact(treeOf(documentId), bytes, heads);
  const plain = new PlainSync({
    storage,
    policy: {
      account: () => ({ role: "owner", canWrite: true, canComment: true, generation: 0 }),
      leaseExpiresAt: () => Infinity,
    },
  });
  await plain.load([[documentId, "page"]]);
  return plain;
}
