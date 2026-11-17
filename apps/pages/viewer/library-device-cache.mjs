// The library's last first page on this device, per account, so a reload
// paints the rows (and their card previews) before the server answers.
//
// What is stored, and where. One record per account in IndexedDB database
// `pages-library-cache`, object store `bytes`, key `library/v1/<principal>`:
// the first page `list_pages` last returned to that account in this browser
// for the library's default view (All, Last activity, no search, no Project),
// and the `page_cards` answers for those rows. It is a rebuildable device
// cache, never normative: every fact in it is a copy of a server answer, the
// next answer replaces it, and deleting it loses nothing but the head start.
// The local Page catalog (local-catalog.mjs) is a different database and is
// never touched from here.
//
// What a record may hold:
// - At most the first page (DEVICE_ROWS_MAX rows), in the server's order.
// - An owned row keeps what a library row draws: `page_id`, `title` (at most
//   DEVICE_TITLE_MAX code points), `updated_at`, `content_updated_at` and
//   `project_id`.
// - A row shared with the account keeps only its place: `page_id`, its two
//   times and `held: true`. No title, Project or card. A share can be revoked
//   at any time, and the in-tab cache (listing-cache.mjs) already limits a
//   shared title to 5 minutes after it was shown; a device copy that outlives
//   the tab would stretch that. The held slot keeps the grid's shape until the
//   server confirms the row, and a row it no longer lists disappears then.
// - A card for an owned row, as `page_cards` returned it, with the
//   `content_updated_at` it was asked for (`at`), dropped when its JSON takes
//   more than DEVICE_CARD_MAX_BYTES. A card names its image routes, so the
//   browser's HTTP cache can serve the bytes; the bytes aren't stored here.
//
// Who reads it. A record is read only by key, and the key is built from the
// principal the session named, so a read can't happen before the session
// answers and another account on this browser never reads it. A record
// whose principal or version doesn't match its key reads as nothing. The
// version is in the key: a format change reads nothing from old records and
// `clear` removes them; nothing migrates.
//
// Failure. Every operation resolves; none throws. A read that fails, stalls
// or finds nothing leaves the library as it is without the cache (the
// listing machine ignores a read that lands after the server's answer).
import { LocalStore } from "./local-store.mjs";

export const LIBRARY_DEVICE_DATABASE = "pages-library-cache";
/** The record format. A new one reads nothing from the old. */
export const LIBRARY_DEVICE_VERSION = 1;
/** Every key this module writes, any version. */
export const LIBRARY_DEVICE_PREFIX = "library/";
/** The most rows a record keeps: list_pages' first page in the library. */
export const DEVICE_ROWS_MAX = 50;
/** The longest title a record keeps, in code points (model/page-card.mjs
 * CARD_TITLE_MAX). */
export const DEVICE_TITLE_MAX = 300;
/** The largest card a record keeps, as UTF-8 JSON. Stored cards are at most
 * 8 KiB of blocks (CARD_BLOCKS_MAX_BYTES); this leaves room for the rest. */
export const DEVICE_CARD_MAX_BYTES = 12 * 1024;
/** How long `clear` waits for IndexedDB before it lets a sign-out go on. */
export const DEVICE_CLEAR_DEADLINE_MS = 1_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The record key for `principal`, in this version. */
export const deviceKey = (principal) =>
  `${LIBRARY_DEVICE_PREFIX}v${LIBRARY_DEVICE_VERSION}/${encodeURIComponent(principal)}`;

const text = (value) => (typeof value === "string" ? value : null);
const clip = (value, max) => {
  if (typeof value !== "string") return "";
  const points = Array.from(value);
  return points.length > max ? points.slice(0, max).join("") : value;
};

/** The rows a record keeps for a first page of list_pages items. */
export function storedRows(items) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (rows.length >= DEVICE_ROWS_MAX) break;
    const id = item?.page_id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    const times = {
      updated_at: text(item.updated_at),
      content_updated_at: text(item.content_updated_at),
    };
    rows.push(
      item.shared === true
        ? { page_id: id, shared: true, held: true, ...times }
        : {
            page_id: id,
            title: clip(item.title, DEVICE_TITLE_MAX),
            ...times,
            project_id: text(item.project_id),
          },
    );
  }
  return rows;
}

/** A card as a record keeps it, or null when it is too large or isn't one. */
export function storedCard(card) {
  if (!card || typeof card !== "object" || !Array.isArray(card.blocks)) return null;
  let json;
  try {
    json = JSON.stringify(card);
  } catch {
    return null;
  }
  if (encoder.encode(json).length > DEVICE_CARD_MAX_BYTES) return null;
  return JSON.parse(json);
}

/** A record's rows and cards for `principal`, or null when it isn't one this
 * build reads for them. Cards come back as `[{ id, at, card }]`, for owned
 * rows only. */
export function readRecord(value, principal) {
  if (!value || typeof value !== "object") return null;
  if (value.v !== LIBRARY_DEVICE_VERSION || value.principal !== principal) return null;
  if (!Array.isArray(value.rows)) return null;
  const rows = storedRows(
    value.rows.map((row) => (row?.held ? { ...row, shared: true } : { ...row, shared: false })),
  );
  const owned = new Set(rows.filter((row) => !row.held).map((row) => row.page_id));
  const cards = [];
  for (const [id, entry] of Object.entries(value.cards ?? {})) {
    if (!owned.has(id) || !entry || typeof entry !== "object") continue;
    const card = storedCard(entry.card);
    if (card) cards.push({ id, at: text(entry.at), card });
  }
  return { rows, cards };
}

/** The record for `items`, keeping `previous` cards for rows still listed
 * with the same content time. */
export function nextRecord(principal, items, previous = null, savedAt = Date.now()) {
  const rows = storedRows(items);
  const cards = {};
  const old = previous?.principal === principal ? (previous.cards ?? {}) : {};
  for (const row of rows) {
    const entry = old[row.page_id];
    if (!row.held && entry && entry.at === row.content_updated_at) cards[row.page_id] = entry;
  }
  return { v: LIBRARY_DEVICE_VERSION, principal, saved_at: savedAt, rows, cards };
}

/** `record` with `entries` (`[{ id, at, card }]`, a null card dropping its
 * entry) applied to its owned rows, or null when nothing changes. */
export function withCards(record, entries) {
  const owned = new Map(
    (record?.rows ?? []).filter((row) => !row.held).map((row) => [row.page_id, row]),
  );
  const cards = { ...record?.cards };
  let changed = false;
  for (const { id, at = null, card } of entries ?? []) {
    const row = owned.get(id);
    if (!row || row.content_updated_at !== at) continue;
    const kept = storedCard(card);
    if (kept) {
      cards[id] = { at, card: kept };
      changed = true;
    } else if (cards[id]) {
      delete cards[id];
      changed = true;
    }
  }
  return changed ? { ...record, cards } : null;
}

/** `record` without `pageId`, or null when it doesn't list it. */
export function withoutPage(record, pageId) {
  if (!record?.rows?.some((row) => row.page_id === pageId)) return null;
  const { [pageId]: _gone, ...cards } = record.cards ?? {};
  return { ...record, rows: record.rows.filter((row) => row.page_id !== pageId), cards };
}

/** `record` with `pageId`'s title, or null when nothing changes. Held rows
 * keep no title. */
export function withTitle(record, pageId, title) {
  if (typeof title !== "string") return null;
  const next = clip(title, DEVICE_TITLE_MAX);
  if (!record?.rows?.some((row) => row.page_id === pageId && !row.held && row.title !== next))
    return null;
  return {
    ...record,
    rows: record.rows.map((row) =>
      row.page_id === pageId && !row.held ? { ...row, title: next } : row,
    ),
  };
}

const decode = (bytes) => {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
};
const encode = (record) => encoder.encode(JSON.stringify(record));

/** The device cache over one LocalStore. */
export class LibraryDeviceCache {
  #store;
  #clearDeadline;
  constructor({
    store = new LocalStore({ database: LIBRARY_DEVICE_DATABASE }),
    clearDeadlineMs = DEVICE_CLEAR_DEADLINE_MS,
  } = {}) {
    this.#store = store;
    this.#clearDeadline = clearDeadlineMs;
  }

  /** `principal`'s rows and cards (readRecord), or null. Never rejects. */
  async read(principal) {
    if (!principal) return null;
    try {
      return readRecord(decode(await this.#store.load(deviceKey(principal))), principal);
    } catch {
      return null;
    }
  }

  /** Read, change and write `principal`'s record in one transaction.
   * `change(record | null)` returns the record to store, or null to leave
   * it as it is. Resolves whether it wrote. */
  #update(principal, change) {
    const key = deviceKey(principal);
    return this.#store
      .run("readwrite", (records, done) => {
        const request = records.get(key);
        request.onsuccess = () => {
          const current = decode(request.result);
          const next = change(current?.principal === principal ? current : null);
          if (next) records.put(encode(next), key);
          done(!!next);
        };
        return request;
      })
      .catch(() => false);
  }

  /** Store `items`, the first page of the default view the server just
   * returned to `principal`. An empty page removes the record. */
  write(principal, items) {
    if (!principal) return Promise.resolve(false);
    if (!Array.isArray(items) || items.length === 0) return this.remove(principal);
    return this.#update(principal, (previous) => nextRecord(principal, items, previous));
  }

  /** Keep `page_cards` answers (`[{ id, at, card }]`) for rows the record
   * holds; a null card drops what it kept. */
  writeCards(principal, entries) {
    if (!principal || !entries?.length) return Promise.resolve(false);
    return this.#update(principal, (record) => (record ? withCards(record, entries) : null));
  }

  /** Remove `principal`'s record. */
  remove(principal) {
    if (!principal) return Promise.resolve(false);
    return this.#store.remove(deviceKey(principal)).then(
      () => true,
      () => false,
    );
  }

  /** Apply `change` to every record this version holds. */
  #each(change) {
    const prefix = `${LIBRARY_DEVICE_PREFIX}v${LIBRARY_DEVICE_VERSION}/`;
    return this.#store
      .run("readwrite", (records, done) => {
        const request = records.openCursor(IDBKeyRange.lowerBound(prefix));
        let count = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || typeof cursor.key !== "string" || !cursor.key.startsWith(prefix)) {
            done(count);
            return;
          }
          const next = change(decode(cursor.value));
          if (next) {
            cursor.update(encode(next));
            count++;
          }
          cursor.continue();
        };
        return request;
      })
      .catch(() => 0);
  }

  /** Drop `pageId` from every account's record (it moved to Trash or its
   * host hid it). */
  forget(pageId) {
    return this.#each((record) => withoutPage(record, pageId));
  }

  /** Show `title` for `pageId` wherever an owned row holds it. */
  retitle(pageId, title) {
    return this.#each((record) => withTitle(record, pageId, title));
  }

  /** Remove every record, every account and version. Resolves true once
   * IndexedDB committed the removal, false when it failed or took longer
   * than the deadline (a sign-out doesn't wait on a stalled database). */
  clear() {
    const removal = this.#store
      .run("readwrite", (records, done) => {
        const request = records.openCursor(IDBKeyRange.lowerBound(LIBRARY_DEVICE_PREFIX));
        request.onsuccess = () => {
          const cursor = request.result;
          if (
            !cursor ||
            typeof cursor.key !== "string" ||
            !cursor.key.startsWith(LIBRARY_DEVICE_PREFIX)
          ) {
            done(true);
            return;
          }
          cursor.delete();
          cursor.continue();
        };
        return request;
      })
      .catch(() => false);
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), this.#clearDeadline);
    });
    return Promise.race([removal, deadline]).finally(() => clearTimeout(timer));
  }

  /** Every key this module holds, for tests and the browser check. */
  keys() {
    return this.#store.list(LIBRARY_DEVICE_PREFIX).catch(() => []);
  }
}

/** This browser's library device cache. */
export const libraryDevice = new LibraryDeviceCache();
