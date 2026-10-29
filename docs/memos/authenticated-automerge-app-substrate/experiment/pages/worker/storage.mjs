import { assertStoredSize } from "../model/limits.mjs";

// Store incremental Subduction records through the host's native DO storage.
export class DurableByteStore {
  constructor(storage) {
    this.storage = storage;
  }
  async load(key) {
    const value = await this.storage.get(`repo/${key}`);
    return value === undefined ? undefined : new Uint8Array(value);
  }
  async save(key, value) {
    assertStoredSize(`repo/${key}`, value.byteLength);
    await this.storage.put(`repo/${key}`, new Uint8Array(value));
  }
  /** One multi-key put is one atomic write, up to 128 keys. */
  async saveMany(entries) {
    if (entries.length > 128) {
      for (const [key, value] of entries) await this.save(key, value);
      return;
    }
    for (const [key, value] of entries) assertStoredSize(`repo/${key}`, value.byteLength);
    await this.storage.put(
      Object.fromEntries(entries.map(([key, value]) => [`repo/${key}`, new Uint8Array(value)])),
    );
  }
  async remove(key) {
    await this.storage.delete(`repo/${key}`);
  }
  async list(prefix) {
    const result = [];
    let startAfter;
    do {
      const page = await this.storage.list({
        prefix: `repo/${prefix}`,
        limit: 256,
        ...(startAfter && { startAfter }),
      });
      result.push(...[...page.keys()].map((key) => key.slice(5)));
      startAfter = page.size === 256 ? [...page.keys()].at(-1) : undefined;
    } while (startAfter);
    return result;
  }
}

export async function persistentSeed(storage) {
  let seed = await storage.get("host/signer");
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
    await storage.put("host/signer", seed);
  }
  return new Uint8Array(seed);
}
