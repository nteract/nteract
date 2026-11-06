// PageRecords: what is left of the Durable Object that held a `buffered`
// Page's Subduction records. Every Page now keeps its history in its own plain
// storage, and nothing reads or writes these records. The class stays only so
// they can be deleted: a Page converted from `buffered` clears its
// PageRecords object when it is purged (Page `purgeConvertedRecords`), and the
// one-shot operator sweep clears the rest (worker/page-records-sweep.mjs).
//
// Delete-only: `inspect` counts what the object holds, `clear` deletes all of
// it. There is no read or write of a record. Remove the class, its binding and
// this module with a `deleted_classes` migration once the sweep has cleared
// every object on every target (DEPLOYMENT.md: Old PageRecords objects).
import { holdUntilSettled } from "./request-hold.mjs";

/** A page of a storage listing; small enough for one response's memory. */
const LIST_LIMIT = 128;

/** Bytes a stored value takes, as near as its type allows. */
function valueBytes(value) {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}

/** How many keys `storage` holds and their key plus value bytes. */
export async function inspectStorage(storage) {
  let keys = 0,
    bytes = 0,
    after;
  for (;;) {
    const page = await storage.list({
      limit: LIST_LIMIT,
      ...(after !== undefined && { startAfter: after }),
    });
    for (const [key, value] of page) {
      keys++;
      bytes += new TextEncoder().encode(key).byteLength + valueBytes(value);
      after = key;
    }
    if (page.size < LIST_LIMIT) return { keys, bytes };
  }
}

export class PageRecords {
  constructor(ctx) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.tail = Promise.resolve();
  }

  fetch(request) {
    const work = this.tail.then(() => this.run(request));
    this.tail = work.catch(() => {});
    holdUntilSettled(this.ctx, work);
    return work;
  }

  async run(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 404 });
    if (pathname === "/inspect") return Response.json(await inspectStorage(this.storage));
    if (pathname === "/clear") {
      const before = await inspectStorage(this.storage);
      await this.storage.deleteAll();
      await this.storage.sync?.();
      return Response.json({ cleared: before, after: await inspectStorage(this.storage) });
    }
    return new Response(null, { status: 404 });
  }
}

/** Ask the PageRecords object `stub` to `inspect` or `clear`. Throws on any
 * answer but 200, with its status. */
export async function pageRecordsCall(stub, action) {
  const response = await stub.fetch(`https://page-records.internal/${action}`, {
    method: "POST",
  });
  if (response.status !== 200)
    throw Object.assign(Error(`PageRecords ${action} answered ${response.status}`), {
      status: 502,
      code: "page_records_unavailable",
    });
  return response.json();
}
