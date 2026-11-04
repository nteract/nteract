// `page_cards`: the cards (model/page-card.mjs) of up to 24 Pages, for the
// library grid. It runs in the caller's own Catalog, with list_pages' rules:
//
// - An owned ID needs this account's own `page/<id>` entry, settled (not a
//   pending creation or a reservation). A trashed Page sits under `trash/`,
//   so it has no card here.
// - A shared ID needs this account's `shared/<id>` entry and a fresh check
//   by its Page host with the caller's own credentials (`verifyShared`, the
//   metadata check page-startup.mjs answers without booting). A revoked
//   grant fails that check on the very next call.
// - D1 is never read. Nothing grants access but those two.
//
// Anything else answers null: an unknown ID, a malformed one, a refusal, a
// check that didn't answer in time, and a Page with no card yet. The caller
// can't tell "no access" from "no card". Card objects are read from the Page
// assets bucket by key and returned as JSON; no object URL leaves the Worker.
import { HttpError } from "./auth.mjs";
import { cardKey, readStoredCard } from "../model/page-card.mjs";

/** The most IDs one call takes: about one screen of grid cards. */
export const PAGE_CARDS_MAX = 24;
/** Object reads one call runs at once. */
export const PAGE_CARDS_READ_CONCURRENCY = 8;
/** How long one object read may take before it counts as no card. */
export const PAGE_CARD_READ_TIMEOUT_MS = 3_000;

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
 * `{ [id]: card | null }` for `ids`.
 *
 * - `storage` is the caller's Catalog storage.
 * - `verifyShared(id)` is the Catalog's shared-Page check:
 *   `{ status: "ok", page } | { status: "denied" } | { status: "unavailable" }`.
 * - `readObject(key)` returns the stored object's text, or null.
 * - `map(items, concurrency, fn)` is boundedMap.
 * - `checks` is how many shared checks run at once.
 */
export async function pageCardsFor(
  ids,
  { storage, verifyShared, readObject, map, checks, onError = () => {} },
) {
  const allowed = await map(ids, checks, async (id) => {
    if (!PAGE_ID.test(id)) return false;
    const owned = await storage.get(`page/${id}`);
    if (owned) return !owned.pending && !owned.reservation;
    if (!(await storage.get(`shared/${id}`))) return false;
    const check = await verifyShared(id);
    return check.status === "ok" && (!check.page?.state || check.page.state === "active");
  });
  const cards = await map(ids, PAGE_CARDS_READ_CONCURRENCY, async (id, index) => {
    if (!allowed[index]) return null;
    try {
      const text = await readObject(cardKey(id));
      return text === null ? null : readStoredCard(JSON.parse(text));
    } catch (error) {
      onError(error);
      return null;
    }
  });
  return Object.fromEntries(ids.map((id, index) => [id, cards[index]]));
}
