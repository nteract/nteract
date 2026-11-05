// Which Pages on a target still sync over Subduction, from evidence an
// operator has already collected. Offline: no network, no credentials, no
// writes. Every input is a file:
//
//   --d1 FILE        Required. The d1.mjs output of
//                    SELECT page_id, owner, state, created_at FROM pages_catalog_pages
//                    (one JSON object per line, or a JSON array).
//   --plain-since T  When the target first served a release configured with
//                    PAGES_RECORD_STORAGE=automerge (ISO 8601). Before it, no
//                    host could create a plain Page.
//   --connect FILE   GET /api/connect?page=<id> response bodies, one per line.
//                    A body with `recordStorage: "automerge"` is plain; one
//                    with `serverPeerId` and no `recordStorage` is Subduction.
//                    The call boots the Page host but never makes it eligible
//                    to convert (only a browser socket does).
//   --records FILE   Decoded `host/document` records (`{pageId, recordStorage,
//                    recordStorageMigratedFrom, recordStorageMigratedAt}`), or
//                    `{page_id, record}` pairs, one per line or a JSON array.
//   --page-ids FILE  More Page IDs, one per line (for instance, Page cells the
//                    D1 projection does not list).
//   --canary FILE    A migration canary that was installed on the target
//                    (`{enabled, pageIds}`). Repeatable. A listed Page without
//                    direct evidence may have converted, so it is `unknown`.
//   --only MODES     Keep only Pages whose storage is one of native, automerge
//                    or unknown (comma-separated).
//   --format F       json (default): the report. ids: Page IDs, one per line.
//
// A Page's storage, strongest evidence first:
//   1. Direct evidence (a record or a connect body). Conversion is one-way, so
//      any direct evidence of `automerge` wins over older native evidence.
//   2. A Page in an installed canary with no direct evidence: unknown.
//   3. created_at before --plain-since: native. At or after it: automerge,
//      inferred. A native draft a stale tab registers after the switch keeps
//      Subduction, so probe before relying on that inference.
//   4. Otherwise unknown.
//
// The D1 rows are a projection of each account's Catalog: an account whose
// index has not reconciled since its Pages were created has no rows. The
// report is as complete as the evidence; it never claims a target-wide count.
// Exit 0: report printed. Exit 2: usage or invalid evidence.
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SCHEMA = "pages-record-storage-inventory-v1";
export const LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024, rows: 200_000 });
const PAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ["active", "pending", "trashed", "deleted"];
const NATIVE = ["local", "buffered"];
const MODES = ["native", "automerge", "unknown"];

export class InventoryError extends Error {}

export const USAGE = `Usage:
  node scripts/record-storage-inventory.mjs --d1 pages.jsonl [--plain-since ISO]
    [--connect connect.jsonl] [--records records.jsonl] [--page-ids ids.txt]
    [--canary installed.json ...] [--only native,automerge,unknown] [--format json|ids]

Collect the D1 rows with:
  node scripts/d1.mjs --target pages \\
    "SELECT page_id, owner, state, created_at FROM pages_catalog_pages" > pages.jsonl`;

/** JSON array, or one JSON value per nonblank line. */
export function parseJsonLines(text, what) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new InventoryError(`${what}: not a JSON array`);
    }
  }
  return trimmed.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      throw new InventoryError(`${what} line ${index + 1}: not JSON`);
    }
  });
}

const pageId = (value, where) => {
  if (typeof value !== "string" || !PAGE_UUID.test(value))
    throw new InventoryError(
      `${where}: expected a lowercase Page UUID, got ${JSON.stringify(value)}`,
    );
  return value;
};
const time = (value, where) => {
  if (value === undefined || value === null || value === "") return null;
  // A zone is required: a bare local time would shift the cutoff by the host's offset.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new InventoryError(
      `${where}: expected an ISO 8601 time with Z or an offset, got ${JSON.stringify(value)}`,
    );
  return value;
};

/** Build the report. `evidence`: {target, plainSince, d1Rows, connect,
 * records, pageIds, canaries}; every list is already parsed. */
export function inventory({
  target = null,
  plainSince = null,
  d1Rows = [],
  connect = [],
  records = [],
  pageIds = [],
  canaries = [],
} = {}) {
  const since = time(plainSince, "--plain-since");
  const total = d1Rows.length + connect.length + records.length + pageIds.length;
  if (total > LIMITS.rows) throw new InventoryError(`More than ${LIMITS.rows} evidence rows`);
  const pages = new Map();
  const issues = [];
  const page = (id) => {
    if (!pages.has(id))
      pages.set(id, {
        page_id: id,
        owner: null,
        state: null,
        created_at: null,
        in_d1: false,
        direct: [],
        in_canary: false,
      });
    return pages.get(id);
  };

  d1Rows.forEach((row, index) => {
    const where = `--d1 row ${index + 1}`;
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new InventoryError(`${where}: expected an object`);
    const entry = page(pageId(row.page_id, where));
    if (entry.in_d1) throw new InventoryError(`${where}: Page ${row.page_id} appears twice`);
    if (!STATES.includes(row.state))
      throw new InventoryError(`${where}: unknown state ${JSON.stringify(row.state)}`);
    Object.assign(entry, {
      in_d1: true,
      owner: typeof row.owner === "string" ? row.owner : null,
      state: row.state,
      created_at: time(row.created_at, where),
    });
  });

  connect.forEach((body, index) => {
    const where = `--connect line ${index + 1}`;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new InventoryError(`${where}: expected an object`);
    // An error body ({error, code}) names no Page: it was refused or missing.
    if (body.page_id === undefined) {
      issues.push({ code: "connect_unattributed", detail: `${where} names no page_id` });
      return;
    }
    const id = pageId(body.page_id, where);
    if (body.recordStorage === "automerge")
      page(id).direct.push({ source: "connect", storage: "automerge" });
    else if (body.recordStorage === undefined && typeof body.serverPeerId === "string")
      page(id).direct.push({ source: "connect", storage: "native" });
    else
      throw new InventoryError(
        `${where}: neither recordStorage "automerge" nor a Subduction serverPeerId`,
      );
  });

  records.forEach((item, index) => {
    const where = `--records line ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new InventoryError(`${where}: expected an object`);
    const record = item.record && typeof item.record === "object" ? item.record : item;
    const id = pageId(item.page_id ?? record.pageId, where);
    if (item.page_id !== undefined && record.pageId !== undefined && record.pageId !== item.page_id)
      throw new InventoryError(`${where}: page_id and record.pageId differ`);
    const mode = record.recordStorage;
    // A record without recordStorage predates the field: synchronous local.
    if (mode !== undefined && mode !== "automerge" && !NATIVE.includes(mode))
      throw new InventoryError(`${where}: unknown recordStorage ${JSON.stringify(mode)}`);
    page(id).direct.push({
      source: "record",
      storage: mode === "automerge" ? "automerge" : "native",
      native_kind: mode === "automerge" ? null : (mode ?? "local"),
      migrated_from: record.recordStorageMigratedFrom ?? null,
      migrated_at: time(record.recordStorageMigratedAt, where),
    });
  });

  pageIds.forEach((id, index) => page(pageId(id, `--page-ids line ${index + 1}`)));

  canaries.forEach((policy, index) => {
    const where = `--canary ${index + 1}`;
    if (!policy || !Array.isArray(policy.pageIds))
      throw new InventoryError(`${where}: expected {enabled, pageIds}`);
    // A paused canary may already have converted its Pages, so it counts too.
    for (const id of policy.pageIds) page(pageId(id, where)).in_canary = true;
  });

  const rows = [...pages.values()].map((entry) => {
    const notes = [];
    const plain = entry.direct.filter(({ storage }) => storage === "automerge");
    const native = entry.direct.filter(({ storage }) => storage === "native");
    // The record that agrees with the Page's storage: a plain one once any
    // evidence shows plain, since an earlier native record is stale.
    const record = (plain.length ? plain : native).find(({ source }) => source === "record");
    let storage = "unknown";
    let basis = "none";
    if (plain.length) {
      storage = "automerge";
      basis = plain[0].source;
      if (native.length) notes.push("older native evidence; conversion is one-way");
    } else if (native.length && entry.in_canary) {
      // Native evidence can predate the conversion a canary ran.
      notes.push("native evidence, but listed in a canary; it may have converted since");
    } else if (native.length) {
      storage = "native";
      basis = native[0].source;
    } else if (entry.in_canary) {
      notes.push("listed in an installed canary; it may have converted");
    } else if (since && entry.created_at) {
      const before = Date.parse(entry.created_at) < Date.parse(since);
      storage = before ? "native" : "automerge";
      basis = before ? "created_before_plain" : "created_after_plain";
      if (!before) notes.push("inferred; a native draft registered after the switch stays native");
    }
    if (!entry.in_d1) {
      notes.push("no D1 row");
      issues.push({ code: "not_in_d1", page_id: entry.page_id });
    }
    return {
      page_id: entry.page_id,
      owner: entry.owner,
      state: entry.state,
      created_at: entry.created_at,
      in_d1: entry.in_d1,
      storage,
      native_kind: storage === "native" ? (record?.native_kind ?? null) : null,
      basis,
      migrated_from: record?.migrated_from ?? null,
      migrated_at: record?.migrated_at ?? null,
      in_canary: entry.in_canary,
      notes,
    };
  });
  // Oldest first; Pages without a creation time last.
  rows.sort(
    (a, b) =>
      (a.created_at === null) - (b.created_at === null) ||
      Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0) ||
      a.page_id.localeCompare(b.page_id),
  );
  const count = (key) =>
    rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] ?? 0) + 1 }), {});
  return {
    schema: SCHEMA,
    target,
    plain_since: since,
    inputs: {
      d1_rows: d1Rows.length,
      connect: connect.length,
      records: records.length,
      page_ids: pageIds.length,
      canaries: canaries.length,
    },
    counts: {
      pages: rows.length,
      storage: Object.fromEntries(MODES.map((mode) => [mode, count("storage")[mode] ?? 0])),
      basis: count("basis"),
      // Canary candidates: Pages people can open that still use Subduction.
      active_native: rows.filter((row) => row.storage === "native" && row.state === "active")
        .length,
    },
    pages: rows,
    issues,
  };
}

export function parseArgs(argv) {
  const args = { canary: [], format: "json" };
  const single = {
    "--target": "target",
    "--d1": "d1",
    "--plain-since": "plainSince",
    "--connect": "connect",
    "--records": "records",
    "--page-ids": "pageIds",
    "--only": "only",
    "--format": "format",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    const value = argv[i + 1];
    if (arg === "--canary") {
      if (value === undefined) throw new InventoryError("--canary needs a value");
      args.canary.push(value);
      i++;
    } else if (Object.hasOwn(single, arg)) {
      if (value === undefined) throw new InventoryError(`${arg} needs a value`);
      if (args[single[arg]] !== undefined && arg !== "--format")
        throw new InventoryError(`${arg} given twice`);
      args[single[arg]] = value;
      i++;
    } else throw new InventoryError(`Unknown argument ${arg}`);
  }
  if (!args.d1) throw new InventoryError("--d1 is required");
  if (args.only !== undefined) {
    args.only = args.only.split(",");
    if (!args.only.length || args.only.some((mode) => !MODES.includes(mode)))
      throw new InventoryError("--only takes native, automerge or unknown, comma-separated");
  }
  if (!["json", "ids"].includes(args.format))
    throw new InventoryError("--format takes json or ids");
  return args;
}

function defaultRead(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch (error) {
    throw new InventoryError(`${file}: ${error.code ?? error.message}`);
  }
  if (size > LIMITS.fileBytes)
    throw new InventoryError(`${file} is over ${LIMITS.fileBytes} bytes`);
  return readFileSync(file, "utf8");
}

export function main(argv, { read = defaultRead, out = console.log, err = console.error } = {}) {
  let report;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      out(USAGE);
      return 0;
    }
    const lines = (file, what) => (file ? parseJsonLines(read(file), what) : []);
    report = inventory({
      target: args.target ?? null,
      plainSince: args.plainSince ?? null,
      d1Rows: lines(args.d1, "--d1"),
      connect: lines(args.connect, "--connect"),
      records: lines(args.records, "--records"),
      pageIds: args.pageIds
        ? read(args.pageIds)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
      canaries: args.canary.map((file) => {
        try {
          return JSON.parse(read(file));
        } catch (error) {
          if (error instanceof InventoryError) throw error;
          throw new InventoryError(`--canary ${file}: not JSON`);
        }
      }),
    });
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    err(error.message);
    err(`\n${USAGE}`);
    return 2;
  }
  const pages = args.only
    ? report.pages.filter((row) => args.only.includes(row.storage))
    : report.pages;
  if (args.format === "ids") for (const row of pages) out(row.page_id);
  else out(JSON.stringify({ ...report, pages }, null, 2));
  const { storage } = report.counts;
  err(
    `${report.counts.pages} Pages: ${storage.native} native, ${storage.automerge} automerge, ` +
      `${storage.unknown} unknown; ${report.counts.active_native} active native` +
      (report.issues.length ? `; ${report.issues.length} issues` : ""),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
