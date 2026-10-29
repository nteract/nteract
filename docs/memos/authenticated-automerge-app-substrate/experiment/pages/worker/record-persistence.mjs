import { assertStoredSize } from "../model/limits.mjs";

// Kept below the deployment's 2 MiB request cap, including binary framing.
const MAX_BATCH_BYTES = 2_000_000;
const MAX_REPLICA_BYTES = 48 * 1024 * 1024;
const MAX_KEYS = 65_536;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

function keyBytes(key) {
  const bytes = encoder.encode(key);
  if (!bytes.length || bytes.length > 1024) throw invalid("Invalid record key");
  return bytes;
}

// A private DO-to-DO format avoids base64 inflation for near-limit native records.
export function encodeRecordBatch(entries) {
  const parts = entries.map(([key, value]) => {
    const bytes = keyBytes(key);
    if (value !== undefined) assertStoredSize(`repo/${key}`, value.byteLength);
    return { bytes, value };
  });
  const size = parts.reduce((n, p) => n + 8 + p.bytes.length + (p.value?.byteLength ?? 0), 0);
  if (size > MAX_BATCH_BYTES) throw invalid("Record batch is too large");
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const { bytes, value } of parts) {
    view.setUint32(offset, bytes.length);
    view.setUint32(offset + 4, value === undefined ? 0xffffffff : value.byteLength);
    result.set(bytes, offset + 8);
    offset += 8 + bytes.length;
    if (value !== undefined) {
      result.set(value, offset);
      offset += value.byteLength;
    }
  }
  return result;
}

export function decodeRecordBatch(bytes) {
  if (bytes.byteLength > MAX_BATCH_BYTES) throw invalid("Record batch is too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid("Truncated record batch");
    const keyLength = view.getUint32(offset);
    const length = view.getUint32(offset + 4);
    offset += 8;
    if (!keyLength || keyLength > 1024 || offset + keyLength > bytes.length)
      throw invalid("Invalid record key");
    const key = decoder.decode(bytes.subarray(offset, offset + keyLength));
    offset += keyLength;
    let value;
    if (length !== 0xffffffff) {
      if (offset + length > bytes.length) throw invalid("Truncated record value");
      assertStoredSize(`repo/${key}`, length);
      value = bytes.slice(offset, offset + length);
      offset += length;
    }
    entries.push([key, value]);
    if (entries.length > MAX_KEYS) throw invalid("Too many records");
  }
  return entries;
}

/** One PageRecords POST is one atomic storage.put of at most 128 keys and
 * MAX_BATCH_BYTES. A group saved through saveMany stays inside one batch when
 * it fits, so its records persist together or not at all. A group that cannot
 * fit is split and logged; lookup readiness then covers an interrupted prefix.
 * `maxKeys` bounds ungrouped batches only. */
function batches(entries, groupOf = () => undefined, maxKeys = 128) {
  const sized = (entry) => 8 + keyBytes(entry[0]).length + (entry[1]?.byteLength ?? 0);
  const members = new Map();
  for (const entry of entries) {
    const group = groupOf(entry[0]);
    if (group !== undefined) members.set(group, [...(members.get(group) ?? []), entry]);
  }
  const result = [];
  const placed = new Set();
  let batch = [],
    size = 0;
  const close = () => {
    if (batch.length) result.push(batch);
    batch = [];
    size = 0;
  };
  const add = (entry) => {
    const bytes = sized(entry);
    if ((size + bytes > MAX_BATCH_BYTES || batch.length >= maxKeys) && batch.length) close();
    batch.push(entry);
    size += bytes;
  };
  for (const entry of entries) {
    const group = groupOf(entry[0]);
    const together = group === undefined ? [] : members.get(group);
    if (together.length < 2) {
      add(entry);
      continue;
    }
    if (placed.has(group)) continue;
    placed.add(group);
    const bytes = together.reduce((n, item) => n + sized(item), 0);
    if (together.length > 128 || bytes > MAX_BATCH_BYTES) {
      logGroupSplit(together.length, bytes);
      together.forEach(add);
      continue;
    }
    if (batch.length && (size + bytes > MAX_BATCH_BYTES || batch.length + together.length > 128))
      close();
    batch.push(...together);
    size += bytes;
  }
  close();
  return result;
}

/** Counts only, like the other structured Pages logs. */
function logGroupSplit(records, bytes) {
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "records.group_split",
      records,
      bytes,
      timestamp: new Date().toISOString(),
    }),
  );
}

/** A separate object owns record durability. Its output gate never closes the
 * live Page's gate when a background batch is uploaded to object storage.
 * This binding is private to the Worker; the public router never exposes it.
 */
export class PageRecords {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.tail = Promise.resolve();
  }
  fetch(request) {
    const work = this.tail.then(() => this.run(request));
    this.tail = work.catch(() => {});
    return work;
  }
  async run(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/lease" && request.method === "POST") {
        // A newly restored Page fences any late persistence request from its
        // previous incarnation before taking a snapshot or admitting records.
        this.generation = crypto.randomUUID();
        await this.storage.put({ "host/generation": this.generation });
        await this.storage.sync();
        return new Response(this.generation);
      }
      if (url.pathname !== "/records") return new Response(null, { status: 404 });
      this.generation ??= await this.storage.get("host/generation");
      if (!this.generation || request.headers.get("x-pages-record-generation") !== this.generation)
        throw Object.assign(Error("Record owner was superseded"), { status: 409 });
      if (request.method === "GET") {
        const after = url.searchParams.get("after");
        if (after !== null) keyBytes(after);
        const page = await this.storage.list({
          prefix: "repo/",
          limit: 64,
          ...(after !== null && { startAfter: `repo/${after}` }),
        });
        const entries = [];
        let size = 0;
        for (const [key, value] of page) {
          const entry = [key.slice(5), new Uint8Array(value)];
          const next = 8 + keyBytes(entry[0]).length + entry[1].byteLength;
          if (size + next > MAX_BATCH_BYTES && entries.length) break;
          entries.push(entry);
          size += next;
        }
        const more = entries.length < page.size || page.size === 64;
        return new Response(encodeRecordBatch(entries), {
          headers: {
            "content-type": "application/octet-stream",
            ...(more && { "x-pages-records-after": encodeURIComponent(entries.at(-1)[0]) }),
          },
        });
      }
      if (request.method === "POST") {
        const entries = decodeRecordBatch(new Uint8Array(await request.arrayBuffer()));
        if (entries.length > 128 || new Set(entries.map(([key]) => key)).size !== entries.length)
          throw invalid("Invalid record batch keys");
        // A failed/partial write has no receipt. Retrying the entire immutable
        // batch is safe; a Page serializes its batches, including deletions.
        const values = Object.fromEntries(
          entries
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [`repo/${key}`, value]),
        );
        const removed = entries
          .filter(([, value]) => value === undefined)
          .map(([key]) => `repo/${key}`);
        if (Object.keys(values).length) await this.storage.put(values);
        if (removed.length) await this.storage.delete(removed);
        await this.storage.sync();
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    } catch (error) {
      return new Response("Record persistence failed", { status: error.status ?? 503 });
    }
  }
}

export class RemoteRecordSink {
  constructor(stub) {
    this.stub = stub;
  }
  generation() {
    // One lease per sink incarnation. A superseded writer must never silently
    // reacquire ownership while retrying its stale queued batches.
    return (this.lease ??= (async () => {
      const response = await this.stub.fetch(
        new Request("https://records.internal/lease", {
          method: "POST",
        }),
      );
      if (!response.ok) throw Error("Could not establish record owner");
      const generation = await response.text();
      if (!/^[a-f0-9-]{36}$/.test(generation)) throw Error("Invalid record owner generation");
      return generation;
    })());
  }
  async *snapshot() {
    const generation = await this.generation();
    let after;
    do {
      const url = new URL("https://records.internal/records");
      if (after !== undefined) url.searchParams.set("after", after);
      const response = await this.stub.fetch(
        new Request(url, {
          headers: { "x-pages-record-generation": generation },
        }),
      );
      if (!response.ok) throw Error("Could not load persisted records");
      const entries = decodeRecordBatch(new Uint8Array(await response.arrayBuffer()));
      for (const entry of entries) yield entry;
      const cursor = response.headers.get("x-pages-records-after");
      const next = cursor === null ? undefined : decodeURIComponent(cursor);
      if (next !== undefined && (next === after || !entries.length))
        throw Error("Invalid persistence cursor");
      after = next;
    } while (after !== undefined);
  }
  async commit(entries) {
    const generation = await this.generation();
    const response = await this.stub.fetch(
      new Request("https://records.internal/records", {
        method: "POST",
        body: encodeRecordBatch(entries),
        headers: {
          "content-type": "application/octet-stream",
          "x-pages-record-generation": generation,
        },
      }),
    );
    if (!response.ok) throw Error("Could not persist records");
  }
}

/** Native save means accepted by this live replica. Only flush() means the
 * persistence owner acknowledged the records. Browser replicas retain their
 * local history until /api/saved confirms that second boundary.
 */
export class BufferedRecordStore {
  constructor(sink, { onDirty = () => {}, maxBytes = MAX_REPLICA_BYTES, maxBatchKeys = 128 } = {}) {
    this.sink = sink;
    this.onDirty = onDirty;
    this.maxBytes = maxBytes;
    this.maxBatchKeys = maxBatchKeys;
    this.values = new Map();
    this.pending = new Map();
    // Pending keys saved together through saveMany, by group token.
    this.groups = new Map();
    this.size = 0;
    this.tail = Promise.resolve();
    this.ready = this.restore();
  }
  async restore() {
    for await (const [key, value] of this.sink.snapshot()) {
      if (value === undefined || this.values.has(key)) throw Error("Invalid persisted record");
      this.install(key, value);
    }
  }
  install(key, value) {
    const bytes = keyBytes(key).length;
    if (value !== undefined) assertStoredSize(`repo/${key}`, value.byteLength);
    const old = this.values.get(key);
    const size =
      this.size -
      (old === undefined ? 0 : bytes + old.byteLength) +
      (value === undefined ? 0 : bytes + value.byteLength);
    if (
      size > this.maxBytes ||
      (!this.values.has(key) && value !== undefined && this.values.size >= MAX_KEYS)
    )
      throw Object.assign(Error("Live document record capacity exceeded"), { status: 413 });
    this.size = size;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value.slice());
  }
  async load(key) {
    await this.ready;
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    await this.ready;
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async save(key, value) {
    await this.ready;
    this.install(key, value);
    this.pending.set(key, this.values.get(key));
    this.onDirty({ key, byteLength: value.byteLength });
  }
  /** Persist these new records in one PageRecords write. Installation is
   * all-or-nothing: a capacity failure leaves the replica unchanged. */
  async saveMany(entries) {
    await this.ready;
    const previous = entries.map(([key]) => [key, this.values.get(key)]);
    try {
      for (const [key, value] of entries) this.install(key, value);
    } catch (error) {
      for (const [key, value] of previous) this.install(key, value);
      throw error;
    }
    const group = Symbol("record group");
    for (const [key] of entries) {
      this.pending.set(key, this.values.get(key));
      this.groups.set(key, group);
    }
    for (const [key, value] of entries) this.onDirty({ key, byteLength: value.byteLength });
  }
  async remove(key) {
    await this.ready;
    this.install(key, undefined);
    this.pending.set(key, undefined);
    this.onDirty();
  }
  get dirty() {
    return this.pending.size > 0 || this.flushing === true;
  }
  flush() {
    const work = this.tail.then(async () => {
      await this.ready;
      const pending = this.pending;
      this.pending = new Map();
      this.flushing = true;
      try {
        const groupOf = (key) => this.groups.get(key);
        for (const batch of batches(pending, groupOf, this.maxBatchKeys))
          await this.sink.commit(batch);
        for (const key of pending.keys()) if (!this.pending.has(key)) this.groups.delete(key);
      } catch (error) {
        // Newer values/deletions win over the failed batch, which may already
        // have partially persisted. Retry the rest without losing local edits.
        this.pending = new Map([...pending, ...this.pending]);
        throw error;
      } finally {
        this.flushing = false;
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}
