import { cbor } from "@automerge/automerge-repo";

// Snapshot plus incremental chunks per document, over a byte store with
// `load`, `saveMany` (all entries or none), `remove` and `list`. The browser
// uses IndexedDB (idb-byte-store.mjs); the host uses its Durable Object storage.
//
//   sync/<doc>/m                manifest { seq, format, snapshot, chunks[], heads }
//   sync/<doc>/o/<seq>/<part>   object written by manifest seq, in parts
//   sync/<doc>/s                the browser's encoded sync state with the host
//
// Writes are one saveMany: the object's parts, any extra entries the caller
// commits with it (the host's actor claims), and the manifest last. A store
// that splits a large saveMany still writes the manifest after its objects, so
// a manifest never names a missing object. Object keys carry the seq that
// wrote them and are never reused, so reclaiming a replaced manifest's objects
// can't delete anything a newer manifest names.
//
// Callers serialize writes per document. The manifest cache is the source of
// truth between writes; `open` loads it.

export const OBJECT_PART_BYTES = 1024 * 1024;
export const COMPACT_MIN_BYTES = 64 * 1024;

const manifestKey = (id) => `sync/${id}/m`;
const objectKey = (id, seq, part) => `sync/${id}/o/${seq}/${part}`;
const syncStateKey = (id) => `sync/${id}/s`;
const EMPTY = Object.freeze({
  seq: 0,
  format: "automerge",
  snapshot: null,
  chunks: [],
  heads: [],
});

export class DocStore {
  #bytes;
  #manifests = new Map();
  #compactMinBytes;

  constructor(bytes, { compactMinBytes = COMPACT_MIN_BYTES } = {}) {
    this.#bytes = bytes;
    this.#compactMinBytes = compactMinBytes;
  }

  /** Document ids with a stored manifest. Loads every manifest. */
  async ids() {
    const keys = await this.#bytes.list("sync/");
    const ids = keys.filter((k) => k.endsWith("/m")).map((k) => k.slice(5, -2));
    await Promise.all(ids.map((id) => this.open(id)));
    return ids.filter((id) => this.#manifests.get(id));
  }

  /** The stored manifest, or null. Cached after the first call. */
  async open(id) {
    if (this.#manifests.has(id)) return this.#manifests.get(id);
    const bytes = await this.#bytes.load(manifestKey(id));
    const manifest = bytes ? normalize(cbor.decode(bytes)) : null;
    if (!this.#manifests.has(id)) this.#manifests.set(id, manifest);
    return this.#manifests.get(id);
  }

  manifest(id) {
    return this.#manifests.get(id) ?? null;
  }

  /** Snapshot bytes (or null) and chunk bytes, in manifest order. */
  async read(id) {
    const m = await this.open(id);
    if (!m) return null;
    const [snapshot, ...chunks] = await Promise.all([
      m.snapshot ? this.#readObject(id, m.snapshot) : null,
      ...m.chunks.map((c) => this.#readObject(id, c)),
    ]);
    return { manifest: m, snapshot, chunks };
  }

  /**
   * Persist one chunk with `extra` entries and commit the manifest. `format`
   * is fixed by a document's first write: "automerge" chunks concatenate into
   * one A.load; "opaque" is the contract suite's verbatim record mode.
   */
  async append(id, chunk, heads, extra = [], { format = "automerge" } = {}) {
    const m = (await this.open(id)) ?? { ...EMPTY, format };
    if (m.format !== format) throw new Error(`Document ${id} is stored as ${m.format}`);
    const seq = m.seq + 1;
    const object = { seq, parts: partCount(chunk), bytes: chunk.byteLength };
    const next = {
      ...m,
      seq,
      chunks: [...m.chunks, object],
      heads: [...heads],
    };
    await this.#commit(id, next, [...this.#parts(id, seq, chunk), ...extra]);
    return next;
  }

  /** Chunk bytes over half the snapshot, or over the absolute floor. */
  wantsCompaction(id) {
    const m = this.#manifests.get(id);
    if (!m?.chunks.length) return false;
    const chunkBytes = m.chunks.reduce((n, c) => n + c.bytes, 0);
    return chunkBytes > (m.snapshot?.bytes ?? 0) / 2 || chunkBytes > this.#compactMinBytes;
  }

  /** Replace the live set with one `A.save()` that covers every stored head. */
  async compact(id, save, heads, extra = []) {
    const m = (await this.open(id)) ?? EMPTY;
    const seq = m.seq + 1;
    const snapshot = { seq, parts: partCount(save), bytes: save.byteLength };
    const next = {
      seq,
      format: "automerge",
      snapshot,
      chunks: [],
      heads: [...heads],
    };
    await this.#commit(id, next, [...this.#parts(id, seq, save), ...extra]);
    await this.#reclaim(id, [m.snapshot, ...m.chunks].filter(Boolean));
    return next;
  }

  /** Remove the manifest first, so an interrupted removal leaves only orphans. */
  async remove(id) {
    const m = await this.open(id);
    if (!m) return;
    await this.#bytes.remove(manifestKey(id));
    this.#manifests.set(id, null);
    await this.#bytes.remove(syncStateKey(id));
    await this.#reclaim(id, [m.snapshot, ...m.chunks].filter(Boolean));
  }

  async syncState(id) {
    return (await this.#bytes.load(syncStateKey(id))) ?? null;
  }

  async saveSyncState(id, bytes) {
    await this.#bytes.saveMany([[syncStateKey(id), bytes]]);
  }

  async #commit(id, next, entries) {
    await this.#bytes.saveMany([...entries, [manifestKey(id), cbor.encode(next)]]);
    this.#manifests.set(id, next);
  }

  *#parts(id, seq, bytes) {
    const count = partCount(bytes);
    for (let part = 0; part < count; part++)
      yield [
        objectKey(id, seq, part),
        bytes.slice(part * OBJECT_PART_BYTES, (part + 1) * OBJECT_PART_BYTES),
      ];
  }

  async #readObject(id, object) {
    const parts = await Promise.all(
      Array.from({ length: object.parts }, (_, part) =>
        this.#bytes.load(objectKey(id, object.seq, part)),
      ),
    );
    if (parts.some((p) => p === undefined))
      throw new Error(`Missing stored object ${id}/${object.seq}`);
    return concat(parts);
  }

  async #reclaim(id, objects) {
    for (const object of objects)
      for (let part = 0; part < object.parts; part++)
        await this.#bytes.remove(objectKey(id, object.seq, part));
  }
}

/** In-memory byte store with operation counts and one-shot failure injection. */
export class MemoryByteStore {
  #values = new Map();
  #failNext = null;
  stats = { saves: 0, savedBytes: 0, loads: 0, removes: 0 };

  failNext(error = new Error("injected save failure")) {
    this.#failNext = error;
  }
  async load(key) {
    this.stats.loads++;
    const value = this.#values.get(key);
    return value && new Uint8Array(value);
  }
  async saveMany(entries) {
    if (this.#failNext) {
      const error = this.#failNext;
      this.#failNext = null;
      throw error;
    }
    for (const [key, value] of entries) {
      this.stats.saves++;
      this.stats.savedBytes += value.byteLength;
      this.#values.set(key, new Uint8Array(value));
    }
  }
  async save(key, value) {
    await this.saveMany([[key, value]]);
  }
  async remove(key) {
    this.stats.removes++;
    this.#values.delete(key);
  }
  async list(prefix) {
    return [...this.#values.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  bytesAtRest() {
    let n = 0;
    for (const v of this.#values.values()) n += v.byteLength;
    return n;
  }
}

function partCount(bytes) {
  return Math.max(1, Math.ceil(bytes.byteLength / OBJECT_PART_BYTES));
}

function normalize(m) {
  return {
    seq: m.seq,
    format: m.format ?? "automerge",
    snapshot: m.snapshot ?? null,
    chunks: m.chunks ?? [],
    heads: m.heads ?? [],
  };
}

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
