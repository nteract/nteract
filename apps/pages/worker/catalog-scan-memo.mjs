/**
 * A Catalog's location scan (catalog-location.mjs `locationScan`), kept in the
 * object's memory until a write changes a key it covers.
 *
 * The Catalog is the only writer of its own storage, and every write goes
 * through countedStorage (catalog-counts.mjs), which reports each one here
 * before it is issued and again when it settles, whether it succeeded or not.
 * A put or delete reports its keys; a transaction or `deleteAll` reports
 * every key, since it can write any. A reset (serial-queue.mjs) discards the
 * object and this memory with it.
 *
 * The memo's states, as `{ generation, writing, held }`:
 *
 * - `generation` changes on every reported write that covers a scanned key,
 *   when it is issued and when it settles.
 * - `writing` counts those writes still in flight.
 * - `held` is the last scan kept, or null: `{ scan, verified }`.
 *
 * Events: `write_issued` and `write_settled` (a covered write) drop `held`;
 * `scanned` keeps a scan only when no covered write was issued or in flight
 * from the moment it started (its `generation`) to the moment it finished;
 * `verified` records that a listing checked the stored counts against `held`
 * (catalog-counts.mjs verifyCounts). A scan that overlapped a write is
 * answered to its own caller and not kept, so a failed or partial write never
 * leaves a stale scan behind, and no scan is shared between requests while it
 * runs: a second read during a scan runs its own.
 */
import { ALL_KEYS } from "./catalog-counts.mjs";
import { LOCATION_SCAN_PREFIXES, locationScan } from "./catalog-location.mjs";

export const emptyScanMemo = Object.freeze({ generation: 0, writing: 0, held: null });

const covered = (keys) =>
  keys === ALL_KEYS ||
  keys.some(
    (key) =>
      typeof key === "string" && LOCATION_SCAN_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

/** One memo step: `{ state, kept? }`, or `{ state, rejected }` with the
 * state unchanged. */
export function scanMemo(state, event) {
  switch (event.type) {
    case "write_issued":
      return {
        state: { generation: state.generation + 1, writing: state.writing + 1, held: null },
      };
    case "write_settled":
      if (state.writing === 0) return { state, rejected: "no write is in flight" };
      return {
        state: { generation: state.generation + 1, writing: state.writing - 1, held: null },
      };
    case "scanned":
      if (state.writing > 0 || event.generation !== state.generation) return { state, kept: false };
      return { state: { ...state, held: { scan: event.scan, verified: false } }, kept: true };
    case "verified":
      if (state.held?.scan !== event.scan) return { state };
      return { state: { ...state, held: { ...state.held, verified: true } } };
    default:
      return { state, rejected: "unknown event" };
  }
}

/** `scan` with frozen entries, for keeping. */
const frozen = ({ entries, contents, counts }) => ({
  entries: new Map([...entries].map(([id, entry]) => [id, Object.freeze(entry)])),
  contents: new Map([...contents].map(([id, content]) => [id, Object.freeze(content)])),
  counts: Object.freeze({ ...counts }),
});
/** A caller's own copy of a kept scan: new maps over the frozen entries. */
const copy = ({ entries, contents, counts }) => ({
  entries: new Map(entries),
  contents: new Map(contents),
  counts: { ...counts },
});

/**
 * The memo for one Catalog. `writing(keys)` is countedStorage's `onWrite`
 * hook. `read(storage)` answers `{ scan, hit, verified, token }`: `scan` is
 * the caller's own (new maps, frozen entries), `hit` says it came from
 * memory, `verified` that a listing already checked the stored counts
 * against it, and `token` names it for `verified(token)`.
 */
export function locationScanMemo({ scan = locationScan } = {}) {
  let state = emptyScanMemo;
  const step = (event) => {
    const result = scanMemo(state, event);
    if (result.rejected) throw new Error(`Location scan memo: ${result.rejected}`);
    state = result.state;
    return result;
  };
  return {
    /** Report a write of `keys` (or ALL_KEYS) before it is issued. Returns
     * the function to call once it settles, either way. */
    writing(keys) {
      if (!covered(keys)) return () => {};
      step({ type: "write_issued" });
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        step({ type: "write_settled" });
      };
    },
    async read(storage) {
      const held = state.held;
      if (held)
        return { scan: copy(held.scan), hit: true, verified: held.verified, token: held.scan };
      const generation = state.generation;
      const kept = frozen(await scan(storage));
      step({ type: "scanned", generation, scan: kept });
      return { scan: copy(kept), hit: false, verified: false, token: kept };
    },
    verified(token) {
      step({ type: "verified", scan: token });
    },
    /** The memo's state, for tests. */
    get state() {
      return state;
    },
  };
}
