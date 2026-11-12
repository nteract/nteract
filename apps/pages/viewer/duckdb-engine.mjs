/**
 * A Page's DuckDB engine: one database per Page session, holding each source
 * asset once.
 *
 * External access is off, extensions never autoload, and the configuration is
 * locked, so a query can't read a local file or a URL, or turn those settings
 * back on. Sources arrive one of two ways:
 *
 * - **Arrow** (`toArrowStream` given): the caller decodes the Parquet bytes to
 *   an Arrow IPC stream and the engine copies it into a table. The engine
 *   then touches no files at all.
 * - **Parquet**: the engine registers the bytes under SOURCE_DIR and reads
 *   them through DuckDB's Parquet extension, the only directory it may read.
 *   The extension is compiled into DuckDB's Node bundle; its browser bundle
 *   downloads it, which the Pages CSP refuses unless Pages serves it.
 *   `COPY ... TO` a path under SOURCE_DIR is still attempted, so callers run
 *   only SELECTs they built or the host admitted.
 *
 * `bindings` is DuckDB-WASM's async bindings (a browser Worker) or its
 * blocking bindings (Node tests and benchmarks); every call is awaited, so
 * either works.
 */

export const SOURCE_DIR = "pages-src/";
const ASSET_ID = /^[a-f0-9]{64}$/;

const MEMORY_LIMIT = /^\d{1,6}(\.\d{1,3})?\s?(KB|MB|GB|KiB|MiB|GiB)$/;

const lockdown = (readsParquet, memoryLimit) => [
  ...(readsParquet ? ["LOAD parquet", `SET allowed_directories = ['${SOURCE_DIR}']`] : []),
  `SET memory_limit = '${memoryLimit}'`,
  "SET enable_external_access = false",
  "SET autoinstall_known_extensions = false",
  "SET autoload_known_extensions = false",
  "SET lock_configuration = true",
];

const END_OF_STREAM = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const sourceFile = (assetId) => `${SOURCE_DIR}${assetId}.parquet`;

/** The relation (a table, or a view over Parquet) a source asset is queried by. */
export const assetRelation = (assetId) => `asset_${assetId}`;

/** Double-quote an identifier for DuckDB. */
export const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Open the engine over an instantiated database. Statements run one at a
 * time, in call order. `memoryLimit` caps DuckDB's buffer memory and is
 * locked with the rest of the configuration.
 */
export async function openPageEngine(bindings, { toArrowStream, memoryLimit = "1GB" } = {}) {
  if (!MEMORY_LIMIT.test(memoryLimit)) throw Error(`Invalid memory limit: ${memoryLimit}`);
  const connection = await bindings.connect();
  // The bindings address a connection by its id, which duckdb-wasm keeps in a
  // private field. Fail here, not on a later query, if an upgrade renames it.
  const conn = connection._conn;
  if (typeof conn !== "number") throw Error("duckdb-wasm connection has no _conn id");
  let tail = Promise.resolve();
  const serial = (work) => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
  // runQuery answers in the Arrow IPC file format; Sift takes a stream. The
  // pending-query calls give the stream's schema message, then one message
  // per record batch. With `maxBytes`, the stream keeps the batches that fit,
  // end marker included, and reports `complete: false` if any were left.
  const cancel = async () => {
    try {
      await bindings.cancelPendingQuery(conn);
    } catch {}
  };
  const stream = async (header, { signal, maxBytes = Infinity }) => {
    const chunks = [header];
    let size = header.byteLength + END_OF_STREAM.byteLength;
    let complete = true;
    for (;;) {
      if (signal?.aborted) {
        await cancel();
        signal.throwIfAborted();
      }
      const chunk = await bindings.fetchQueryResults(conn);
      if (!chunk?.byteLength) break;
      if (size + chunk.byteLength > maxBytes) {
        complete = false;
        await cancel();
        break;
      }
      size += chunk.byteLength;
      chunks.push(chunk);
    }
    chunks.push(END_OF_STREAM);
    return { ipc: concat(chunks), complete };
  };
  const raw = async (sql, params, options = {}) => {
    options.signal?.throwIfAborted();
    if (!params?.length) {
      let header = await bindings.startPendingQuery(conn, sql, false);
      while (header == null) {
        if (options.signal?.aborted) {
          await cancel();
          options.signal.throwIfAborted();
        }
        header = await bindings.pollPendingQuery(conn);
      }
      return stream(header, options);
    }
    const statement = await bindings.createPrepared(conn, sql);
    try {
      return await stream(await bindings.sendPrepared(conn, statement, params), options);
    } finally {
      await bindings.closePrepared(conn, statement);
    }
  };
  for (const statement of lockdown(!toArrowStream, memoryLimit)) await raw(statement);
  const ingest = toArrowStream
    ? async (assetId, bytes) => {
        const ipc = await toArrowStream(bytes);
        try {
          await bindings.insertArrowFromIPCStream(conn, ipc, {
            name: assetRelation(assetId),
            create: true,
          });
        } catch (error) {
          // A failed insert can leave a partial table; a retry creates it anew.
          await raw(`DROP TABLE IF EXISTS ${quoteIdent(assetRelation(assetId))}`);
          throw error;
        }
      }
    : async (assetId, bytes) => {
        await bindings.registerFileBuffer(sourceFile(assetId), bytes.slice());
        await raw(
          `CREATE VIEW ${quoteIdent(assetRelation(assetId))} AS SELECT * FROM read_parquet('${sourceFile(assetId)}')`,
        );
      };
  const release = toArrowStream
    ? (assetId) => raw(`DROP TABLE IF EXISTS ${quoteIdent(assetRelation(assetId))}`)
    : async (assetId) => {
        await raw(`DROP VIEW IF EXISTS ${quoteIdent(assetRelation(assetId))}`);
        await bindings.dropFile(sourceFile(assetId));
      };

  const sources = new Map();
  // open → closing → closed. Only an open engine takes work; close() waits
  // for work already queued, and every caller shares that one shutdown.
  let state = "open";
  let shutdown;
  const refuse = () => Promise.reject(Error("Engine is closed"));
  return {
    /** Run one statement; resolves to one Arrow IPC stream. */
    run(sql, params = []) {
      if (state !== "open") return refuse();
      return serial(() => raw(sql, params)).then(({ ipc }) => ipc);
    },
    /**
     * Run one query for a request. Work still queued when `signal` aborts
     * never runs, and a running query is cancelled. Resolves to `{ ipc,
     * complete }`; with `maxBytes`, `ipc` holds the batches that fit and
     * `complete` is false if the result had more.
     */
    stream(sql, params = [], { signal, maxBytes } = {}) {
      if (state !== "open") return refuse();
      return serial(() => raw(sql, params, { signal, maxBytes }));
    },
    /**
     * Load a source asset's Parquet bytes once; later calls for the same asset
     * reuse it. Async bindings transfer buffers to the worker, so this never
     * hands over the caller's bytes. Resolves to the relation name.
     */
    addSource(assetId, bytes) {
      if (state !== "open") return refuse();
      if (!ASSET_ID.test(assetId)) return Promise.reject(Error("Invalid asset ID"));
      let pending = sources.get(assetId);
      if (!pending) {
        pending = serial(async () => {
          await ingest(assetId, bytes);
          return assetRelation(assetId);
        });
        pending.catch(() => sources.delete(assetId));
        sources.set(assetId, pending);
      }
      return pending;
    },
    /**
     * Drop a source asset's relation and bytes. Sessions over it fail on their
     * next query. Dropping an asset that isn't loaded is a no-op.
     */
    dropSource(assetId) {
      if (state !== "open") return refuse();
      const pending = sources.get(assetId);
      if (!pending) return Promise.resolve();
      sources.delete(assetId);
      return serial(async () => {
        await pending.catch(() => {});
        await release(assetId);
      });
    },
    /** Column names and DuckDB type names of a relation. */
    async describe(relation) {
      const ipc = await this.run(`DESCRIBE ${quoteIdent(relation)}`);
      return describeRows(ipc);
    },
    close() {
      if (state === "open") {
        state = "closing";
        shutdown = (async () => {
          await tail;
          await connection.close();
          state = "closed";
        })();
      }
      return shutdown;
    },
  };
}

// DuckDB-WASM's browser bindings already import Arrow's JS library; the
// engine reuses it for small metadata results.
let arrow;
async function describeRows(ipc) {
  arrow ??= await import("apache-arrow");
  const table = arrow.tableFromIPC(ipc);
  const names = table.getChild("column_name").toArray();
  const types = table.getChild("column_type").toArray();
  return names.map((name, i) => ({ name, type: String(types[i]) }));
}
