import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Test-only, single-owner LocalByteStore. Rename gives atomic replacement, not
// fsync/power-loss durability, batch transactions, or an S3 acceptance receipt.
export class FileByteStore {
  writes = 0;
  savedBytes = 0;
  failNextSave = false;
  failSaves = false;
  constructor(root) {
    this.root = root;
  }
  path(key) {
    return join(this.root, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  async load(key) {
    try {
      const entry = JSON.parse(await readFile(this.path(key), "utf8"));
      if (entry.key !== key) throw new Error("Storage key mismatch");
      return new Uint8Array(Buffer.from(entry.value, "base64"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async save(key, value) {
    if (this.failNextSave || this.failSaves) {
      this.failNextSave = false;
      throw new Error("Injected disk save failure");
    }
    const copy = new Uint8Array(value);
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ key, value: Buffer.from(copy).toString("base64") }));
      await rename(temp, this.path(key));
      this.writes++;
      this.savedBytes += copy.length;
    } finally {
      await rm(temp, { force: true });
    }
  }
  async remove(key) {
    await rm(this.path(key), { force: true });
  }
  async list(prefix) {
    let names;
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(this.root, name), "utf8"))),
    );
    return entries
      .map((entry) => entry.key)
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}
