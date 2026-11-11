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

const lockdown = (readsParquet) => [
  ...(readsParquet ? ["LOAD parquet", `SET allowed_directories = ['${SOURCE_DIR}']`] : []),
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

/** The relation (a table, or a view over Parquet) a source asset is queried by. */
export const assetRelation = (assetId) => `asset_${assetId}`;

/** Double-quote an identifier for DuckDB. */
export const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Open the engine over an instantiated database. Statements run one at a
 * time, in call order.
 */
export async function openPageEngine(bindings, { toArrowStream } = {}) {
  const connection = await bindings.connect();
  const conn = connection._conn;
  let tail = Promise.resolve();
  const serial = (work) => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
  // runQuery answers in the Arrow IPC file format; Sift takes a stream. The
  // pending-query calls give the stream's schema message, then one message
  // per record batch.
  const stream = async (header) => {
    const chunks = [header];
    for (;;) {
      const chunk = await bindings.fetchQueryResults(conn);
      if (!chunk?.byteLength) break;
      chunks.push(chunk);
    }
    chunks.push(END_OF_STREAM);
    return concat(chunks);
  };
  const raw = async (sql, params) => {
    if (!params?.length) {
      let header = await bindings.startPendingQuery(conn, sql, false);
      while (header == null) header = await bindings.pollPendingQuery(conn);
      return stream(header);
    }
    const statement = await bindings.createPrepared(conn, sql);
    try {
      return await stream(await bindings.sendPrepared(conn, statement, params));
    } finally {
      await bindings.closePrepared(conn, statement);
    }
  };
  for (const statement of lockdown(!toArrowStream)) await raw(statement);
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
        const file = `${SOURCE_DIR}${assetId}.parquet`;
        await bindings.registerFileBuffer(file, bytes.slice());
        await raw(
          `CREATE VIEW ${quoteIdent(assetRelation(assetId))} AS SELECT * FROM read_parquet('${file}')`,
        );
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
      return serial(() => raw(sql, params));
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
