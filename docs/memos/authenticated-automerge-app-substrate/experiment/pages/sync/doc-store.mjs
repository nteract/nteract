import { cbor } from "@automerge/automerge-repo";
import { MAX_COMMIT_TAIL_KEYS, validateCommitTail } from "./commit-tail.mjs";

// Snapshot plus incremental chunks per document, over a byte store with
// `load`, `saveMany` (ordered batches), `remove` and `list`. The browser
// uses IndexedDB (idb-byte-store.mjs); the host uses its Durable Object storage.
//
//   sync/<doc>/m2               manifest { version: 2, seq, format, snapshot, heads }
//   sync/<doc>/m                legacy manifest, read only until upgraded
//   sync/<doc>/c/<seq>          chunk descriptor { seq, parts, bytes }
//   sync/<doc>/o/<seq>/<part>   object written by manifest seq, in parts
//   sync/<doc>/s                the browser's encoded sync state with the host
//
// Writes are one saveMany: the object's parts, any extra entries the caller
// commits with it (the host's actor claims), and the manifest last. A store
// that splits a large saveMany still writes the manifest after its objects, so
// a manifest never names a missing object. Object keys carry the seq that
// wrote them. Only unpublished seqs may be retried; reclaiming a replaced
// manifest's objects can't delete anything a newer manifest names. Descriptors
// are live only between snapshot.seq (exclusive) and manifest.seq (inclusive).
// A crash before the manifest can leave orphaned parts/descriptors and staged
// extras. Extras are NOT atomic with the manifest. append's optional commitExtra
// builder instead requires saveWithCommitTail(staged, tail): stage bulk entries,
// then publish all bounded tail entries (metadata + manifest) in one atomic put.
// An adapter without that capability must reject before staging, not fall back.
//
// Callers serialize writes per document. The manifest cache is the source of
// truth between writes; `open` loads it.

export const OBJECT_PART_BYTES = 1024 * 1024;
export const COMPACT_MIN_BYTES = 64 * 1024;
// Bound cold-load reads; keystroke-sized chunks reach this before the byte rule.
export const COMPACT_MAX_CHUNKS = 256;

const manifestKey = (id) => `sync/${id}/m2`;
const legacyManifestKey = (id) => `sync/${id}/m`;
const objectKey = (id, seq, part) => `sync/${id}/o/${seq}/${part}`;
const chunkKey = (id, seq) => `sync/${id}/c/${seq}`;
const syncStateKey = (id) => `sync/${id}/s`;
const EMPTY = Object.freeze({
  version: 2,
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
  #compactMaxChunks;

  constructor(
    bytes,
    { compactMinBytes = COMPACT_MIN_BYTES, compactMaxChunks = COMPACT_MAX_CHUNKS } = {},
  ) {
    this.#bytes = bytes;
    this.#compactMinBytes = compactMinBytes;
    this.#compactMaxChunks = compactMaxChunks;
  }

  /** Document ids with a stored manifest. Loads every manifest. */
  async ids() {
    const keys = await this.#bytes.list("sync/");
    const ids = [
      ...new Set(keys.filter((k) => /\/m2?$/.test(k)).map((k) => k.slice(5, k.lastIndexOf("/")))),
    ];
    await Promise.all(ids.map((id) => this.open(id)));
    return ids.filter((id) => this.#manifests.get(id));
  }

  /** The stored manifest, or null. Cached after the first call. */
  async open(id) {
    if (this.#manifests.has(id)) return this.#manifests.get(id);
    const bytes =
      (await this.#bytes.load(manifestKey(id))) ?? (await this.#bytes.load(legacyManifestKey(id)));
    const manifest = bytes ? normalize(cbor.decode(bytes)) : null;
    if (manifest?.version === 2) {
      // Every committed seq after the snapshot is an append. Read that exact
      // range, not a prefix listing that could include an interrupted append.
      manifest.chunks = await Promise.all(
        Array.from({ length: manifest.seq - (manifest.snapshot?.seq ?? 0) }, async (_, i) => {
          const seq = (manifest.snapshot?.seq ?? 0) + i + 1;
          const bytes = await this.#bytes.load(chunkKey(id, seq));
          if (!bytes) throw new Error(`Missing stored chunk descriptor ${id}/${seq}`);
          const chunk = cbor.decode(bytes);
          if (chunk.seq !== seq) throw new Error(`Invalid stored chunk descriptor ${id}/${seq}`);
          return chunk;
        }),
      );
    }
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
   * Persist one chunk with staged `extra` entries and commit the manifest.
   * `format` is fixed by a document's first write: "automerge" chunks concatenate
   * into one A.load; "opaque" is the contract suite's verbatim record mode.
   * Optional synchronous `commitExtra({ seq, heads })` returns byte entries
   * published atomically with this manifest, at most 127 metadata keys. It must
   * be pure: failed writes can be retried, and its invocation is not a commit.
   * Metadata must use caller-owned keys outside DocStore's reserved `sync/`.
   */
  async append(id, chunk, heads, extra = [], { format = "automerge", commitExtra } = {}) {
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
    let metadata = [];
    if (commitExtra !== undefined) {
      if (typeof commitExtra !== "function")
        throw new TypeError("commitExtra must be a synchronous function");
      metadata = commitExtra(Object.freeze({ seq, heads: Object.freeze([...next.heads]) }));
      if (!Array.isArray(metadata)) {
        // Reject async builders without leaking an eventual rejected promise.
        // Their result is never used to publish metadata or stage history.
        Promise.resolve(metadata).catch(() => {});
        throw new TypeError("commitExtra must synchronously return an entry array");
      }
      // Reserve the manifest's key before copying or spreading any metadata.
      if (metadata.length >= MAX_COMMIT_TAIL_KEYS)
        throw new RangeError(`Commit metadata permits at most ${MAX_COMMIT_TAIL_KEYS - 1} keys`);
    }
    await this.#commit(
      id,
      next,
      [
        ...this.#parts(id, seq, chunk),
        ...(m.version === 2 ? [[chunkKey(id, seq), cbor.encode(object)]] : []),
        ...extra,
      ],
      metadata,
    );
    return next;
  }

  /**
   * More than COMPACT_MAX_CHUNKS chunks, or chunk bytes over half the
   * snapshot and over the floor. Compaction rewrites the whole document, so
   * the byte threshold grows with it: each rewrite follows at least half a
   * snapshot of new history, and a small document waits for the floor rather
   * than rewriting on every write. The chunk count bounds cold-load reads.
   */
  wantsCompaction(id) {
    const m = this.#manifests.get(id);
    if (!m?.chunks.length) return false;
    if (m.chunks.length > this.#compactMaxChunks) return true;
    const chunkBytes = m.chunks.reduce((n, c) => n + c.bytes, 0);
    return chunkBytes > Math.max((m.snapshot?.bytes ?? 0) / 2, this.#compactMinBytes);
  }

  /** Replace the live set with one `A.save()` that covers every stored head. */
  async compact(id, save, heads, extra = []) {
    const m = (await this.open(id)) ?? EMPTY;
    const seq = m.seq + 1;
    const snapshot = { seq, parts: partCount(save), bytes: save.byteLength };
    const next = {
      version: 2,
      seq,
      format: "automerge",
      snapshot,
      chunks: [],
      heads: [...heads],
    };
    await this.#commit(id, next, [...this.#parts(id, seq, save), ...extra]);
    await this.#reclaim(id, [m.snapshot, ...m.chunks].filter(Boolean));
    await this.#reclaimChunks(id, next);
    return next;
  }

  /** Remove the manifest first, so an interrupted removal leaves only orphans. */
  async remove(id) {
    const m = await this.open(id);
    if (!m) return;
    // Remove the fallback first; a crash must never expose a stale legacy doc.
    await this.#bytes.remove(legacyManifestKey(id));
    await this.#bytes.remove(manifestKey(id));
    this.#manifests.set(id, null);
    await this.#bytes.remove(syncStateKey(id));
    await this.#reclaim(id, [m.snapshot, ...m.chunks].filter(Boolean));
    await this.#reclaimChunks(id, m);
  }

  async syncState(id) {
    return (await this.#bytes.load(syncStateKey(id))) ?? null;
  }

  async saveSyncState(id, bytes) {
    await this.#bytes.saveMany([[syncStateKey(id), bytes]]);
  }

  async #commit(id, next, entries, metadata = []) {
    // Legacy manifests retain their inline chunks until the next compaction.
    // The v2 cache has the same shape for callers, but disk metadata is O(1)
    // in chunk count (heads still scale with concurrent writers).
    const { chunks: _chunks, ...manifest } = next;
    const publication = [manifestKey(id), cbor.encode(next.version === 2 ? manifest : next)];
    const tail = [...metadata, publication];
    if (metadata.length) {
      validateCommitTail(entries, tail);
      if (metadata.some(([key]) => key.startsWith("sync/")))
        throw new Error("Commit metadata cannot use reserved sync/ keys");
      if (typeof this.#bytes.saveWithCommitTail !== "function")
        throw new Error("Byte store does not support an atomic commit tail");
    }
    try {
      if (metadata.length) await this.#bytes.saveWithCommitTail(entries, tail);
      else await this.#bytes.saveMany([...entries, publication]);
    } catch (error) {
      // A rejected put may have committed. Reload before allocating a seq so
      // a retry cannot overwrite objects the durable manifest already names.
      this.#manifests.delete(id);
      await this.open(id).catch(() => {});
      throw error;
    }
    this.#manifests.set(id, next);
    // An old viewer must not read v2 as an empty chunk list and rewrite it as
    // v1. Publish only at m2; remove the old viewer's key after that commit.
    if (await this.#bytes.load(legacyManifestKey(id)))
      await this.#bytes.remove(legacyManifestKey(id));
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

  async #reclaimChunks(id, manifest) {
    const prefix = `sync/${id}/c/`;
    for (const key of await this.#bytes.list(prefix))
      if (Number(key.slice(prefix.length)) <= manifest.seq) await this.#bytes.remove(key);
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
  if (m.version !== undefined && m.version !== 2)
    throw new Error(`Unsupported manifest version ${m.version}`);
  return {
    ...(m.version === 2 && { version: 2 }),
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
