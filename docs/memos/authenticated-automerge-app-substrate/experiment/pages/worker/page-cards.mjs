// `page_cards`: the cards (model/page-card.mjs) of up to 24 Pages, for the
// library grid. It runs in two steps, so object reads never hold the
// account's Catalog queue:
//
// 1. The caller's Catalog decides access, inside its serial queue, with
//    list_pages' rules (`allowedPageCards`), and answers only the IDs it
//    allows. That route is internal: the gateway never forwards it.
// 2. The gateway reads those IDs' card objects, outside every queue, all at
//    once under one deadline (`readPageCards`). Only the Catalog's allowed
//    IDs reach the bucket.
//
// Access rules:
//
// - An owned ID needs this account's own `page/<id>` entry, settled (not a
//   pending creation or a reservation). A trashed Page sits under `trash/`,
//   so it answers null here. Trash keeps the card object on purpose: a
//   restore moves the entry back to `page/` and the card shows at once,
//   without waiting for an edit. Only a purge or tombstone deletes it.
// - A shared ID needs this account's `shared/<id>` entry and a fresh check
//   by its Page host with the caller's own credentials (`verifyShared`, the
//   metadata check page-startup.mjs answers without booting), which must
//   find the Page active. A revoked grant fails that check on the very next
//   call.
// - D1 is never read. Nothing grants access but those two.
//
// Anything else answers null: an unknown ID, a malformed one, a refusal, a
// check that didn't answer in time, an object read that missed the deadline,
// and a Page with no card yet. The caller can't tell "no access" from "no
// card". Card objects are read by key and returned as JSON; no object URL
// leaves the Worker.
//
// A card whose Page has card images (card-images.mjs) for the same
// `card_hash` also carries `image: { card_hash, light, dark }`, the
// access-checked image routes. A missing, partial or older image leaves the
// JSON card as it is.
import { HttpError } from "./auth.mjs";
import { cardKey, readStoredCard } from "../model/page-card.mjs";

/** The most IDs one call takes: about one screen of grid cards. */
export const PAGE_CARDS_MAX = 24;
/** How long the gateway waits for one call's object reads, together. A read
 * still running then answers null; the card shows on a later visit. Tests
 * may lower it. */
export const pageCardReadBounds = { deadlineMs: 1_200 };

const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The distinct IDs a call names, in order. Refuses anything but an array
 * of at most PAGE_CARDS_MAX strings; a string that isn't a Page ID stays,
 * and answers null like any other ID the caller can't read. */
export function parsePageCardIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
    throw new HttpError(400, "page_ids must be an array of Page IDs", "invalid_arguments");
  const ids = [...new Set(value)];
  if (ids.length > PAGE_CARDS_MAX)
    throw new HttpError(
      400,
      `page_cards takes at most ${PAGE_CARDS_MAX} page_ids`,
      "invalid_arguments",
    );
  return ids;
}

/**
 * The IDs of `ids` whose cards the caller may read, in order. Runs in the
 * caller's Catalog.
 *
 * - `storage` is the caller's Catalog storage.
 * - `verifyShared(id)` is the Catalog's shared-Page check:
 *   `{ status: "ok", page } | { status: "denied" } | { status: "unavailable" }`.
 * - `map(items, concurrency, fn)` is boundedMap; `checks` is how many
 *   shared checks run at once.
 */
export async function allowedPageCards(ids, { storage, verifyShared, map, checks }) {
  const allowed = await map(ids, checks, async (id) => {
    if (!PAGE_ID.test(id)) return false;
    const owned = await storage.get(`page/${id}`);
    if (owned) return !owned.pending && !owned.reservation;
    if (!(await storage.get(`shared/${id}`))) return false;
    const check = await verifyShared(id);
    return check.status === "ok" && (!check.page?.state || check.page.state === "active");
  });
  return ids.filter((_, index) => allowed[index]);
}

/**
 * `{ [id]: card | null }` for every ID in `ids`, reading only those in
 * `allowed`. Runs in the gateway.
 *
 * - `readObject(key, signal)` returns the stored object's text, or null.
 *   Every read starts at once and shares one `deadlineMs`. A read still
 *   running then, or one that fails, answers null. The signal aborts at the
 *   deadline for a reader that honors it; R2's `get()` takes no signal, so
 *   the gateway's reads run on and their late answers are dropped.
 * - `readImage(id, signal)` returns the Page's card image view
 *   (card-images.mjs cardImageView), or null. It runs beside `readObject`
 *   under the same deadline; a failure only drops the image.
 */
export async function readPageCards(
  ids,
  allowed,
  { readObject, readImage = null, deadlineMs = pageCardReadBounds.deadlineMs, onError = () => {} },
) {
  const readable = new Set(allowed.filter((id) => ids.includes(id) && PAGE_ID.test(id)));
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Page card reads timed out"));
      resolve(null);
    }, deadlineMs);
  });
  try {
    const cards = await Promise.all(
      ids.map((id) => {
        if (!readable.has(id)) return null;
        const read = (async () => {
          try {
            const [text, image] = await Promise.all([
              readObject(cardKey(id), controller.signal),
              readImage
                ? readImage(id, controller.signal).catch((error) => {
                    if (!controller.signal.aborted) onError(error);
                    return null;
                  })
                : null,
            ]);
            const card = text === null ? null : readStoredCard(JSON.parse(text));
            return card && image?.card_hash === card.card_hash ? { ...card, image } : card;
          } catch (error) {
            if (!controller.signal.aborted) onError(error);
            return null;
          }
        })();
        return Promise.race([read, deadline]);
      }),
    );
    return Object.fromEntries(ids.map((id, index) => [id, cards[index]]));
  } finally {
    clearTimeout(timer);
  }
}
