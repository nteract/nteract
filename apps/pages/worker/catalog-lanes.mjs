/**
 * Which lane a Catalog request runs in. `Catalog.fetch` asks `catalogLane`
 * once per request and never reads the body to decide.
 *
 * - `queued`: the Catalog's serial queue (serial-queue.mjs). Every request
 *   that can write this Catalog's storage, or store an operation intent,
 *   runs here, one at a time.
 * - `location`: `/internal/location`, a host-only read (catalog-location.mjs).
 *   A Catalog listing a shared parent asks the owner's Catalog from inside
 *   its own queue; two Catalogs doing that to each other must not wait on
 *   each other.
 * - `discovery`: `/internal/project-discovery`. A Project host sends it from
 *   inside its own read; it writes hints with storage operations only and
 *   never awaits another host (project-opened.mjs).
 * - `cards`: the access step of `page_cards` (page-cards.mjs), marked by the
 *   gateway with CARDS_LANE_HEADER. It reads `page/<id>` and `shared/<id>`
 *   and asks Page hosts; it writes nothing here. The Catalog still checks
 *   that a request in this lane names `page_cards` and refuses anything else.
 *
 * The gateway builds every Catalog forward with `forwarded()`, which copies
 * only an allowlist of the caller's headers, so a client can't send
 * CARDS_LANE_HEADER through it. Only `allowedCards` sets it.
 */
export const CARDS_LANE_HEADER = "x-pages-catalog-lane";
export const CARDS_LANE = "cards";

/** `queued`, `location`, `discovery` or `cards` for one Catalog request. */
export function catalogLane(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/internal/location") return "location";
  if (pathname === "/internal/project-discovery") return "discovery";
  if (pathname === "/internal/catalog" && request.headers.get(CARDS_LANE_HEADER) === CARDS_LANE)
    return "cards";
  return "queued";
}
