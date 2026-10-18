// The application stores incremental Subduction records; celld owns SQLite,
// replication, snapshots, ownership epochs, and object-store recovery.
export class DurableByteStore {
  constructor(storage) {
    this.storage = storage;
  }
  async load(key) {
    const value = await this.storage.get(`repo/${key}`);
    return value === undefined ? undefined : new Uint8Array(value);
  }
  async save(key, value) {
    await this.storage.put(`repo/${key}`, new Uint8Array(value));
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
