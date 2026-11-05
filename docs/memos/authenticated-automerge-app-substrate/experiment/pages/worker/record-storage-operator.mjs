/**
 * ONE-SHOT MIGRATION. DELETE ONCE NO DEPLOYABLE TARGET HOLDS A SUBDUCTION
 * PAGE, with its test, scripts/record-storage-operator.mjs, the `requested`
 * event in worker/record-storage-migration.mjs, the Page host's
 * `recordStorageOperator` and the Catalog's `operatorRecordStorageTargets`
 * routes in worker/index.mjs.
 *
 * The operator's conversion of Subduction Pages to plain Automerge sync, on
 * a celld lab target, without waiting for a browser to leave.
 * `POST /api/operator/record-storage` exists only behind the operator gate
 * (worker/operator-gate.mjs); every refusal is the gateway's unknown path.
 * Body `action`:
 *
 * - `accounts`: `{ principals, source }` from the D1 catalog projection.
 * - `targets` `{ principal }`: the Page ids that account's Catalog names,
 *   `[{ page_id, kind: "page" | "trash" }]` (Project content included).
 * - `status` `{ page_ids? , cell_ids? }` (at most 100 in all): what each Page
 *   host's record says, without booting it: `{ cell_id, page_id, owner,
 *   state, record_storage, migrated_from, migrated_at, refusal, migration,
 *   connected }`.
 * - `convert` `{ page_id | cell_id, owner? }`: one Page. The Page host
 *   checks the switch (`PAGES_RECORD_STORAGE=automerge`), the owner when
 *   given, and its record, then runs its own migration machine's
 *   `requested` conversion in its serial request queue: it closes its native
 *   sockets with a transient code and converts in place. The object resets
 *   when it succeeds, which can lose the reply, so the gateway then reads
 *   `status` from a fresh object. Answers `{ cell_id, page_id, outcome,
 *   status }`; `status.record_storage` is what the record says now.
 */
import { validPageId } from "./registration.mjs";
import { operatorAccounts, operatorAuthorized } from "./operator-gate.mjs";

export const OPERATOR_PATH = "/api/operator/record-storage";
/** The Page host's host-only route (worker/index.mjs recordStorageOperator). */
export const OPERATOR_ROUTE = "/internal/record-storage-operator";
/** The Catalog's host-only route (worker/index.mjs). */
export const OPERATOR_TARGETS_ROUTE = "/internal/operator-record-storage-targets";
export const STATUS_BATCH = 100;
/** Every conversion gets this long, past the host's 30 s block deadline. */
const CONVERT_TIMEOUT_MS = 90_000;
const CELL_ID = /^[0-9a-f]{64}$/;

const json = (body, status = 200) => Response.json(body, { status });
const invalid = (error) => json({ error, code: "invalid_arguments" }, 400);

const post = (stub, body, signal) =>
  stub.fetch(
    new Request(`https://pages.internal${OPERATOR_ROUTE}`, {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal && { signal }),
    }),
  );

async function answer(response) {
  const value = await response.json().catch(() => ({}));
  return response.ok ? value : { error: String(value.error ?? response.status).slice(0, 200) };
}

/** What `stub`'s record says, as `{ cell_id, ...status }`. */
async function status(stub, cellId) {
  try {
    return { cell_id: cellId, ...(await answer(await post(stub, { mode: "status" }))) };
  } catch (error) {
    return { cell_id: cellId, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/** The operator route, or null when the gate refuses (the unknown path). */
export async function operatorRecordStorage(request, env) {
  if (!(await operatorAuthorized(request, env))) return null;
  let body;
  try {
    body = await request.json();
  } catch {
    return invalid("Body must be JSON");
  }
  const { action, ...rest } = body ?? {};
  const byCell = (id) => env.PAGES.get(env.PAGES.idFromString(id));
  const cellOf = (pageId) => String(env.PAGES.idFromName(pageId));
  switch (action) {
    case "accounts":
      if (!env.DB?.prepare) return json({ error: "No catalog database" }, 503);
      return json({ principals: await operatorAccounts(env.DB), source: "d1_projection" });
    case "targets":
      if (typeof rest.principal !== "string" || !rest.principal)
        return invalid("principal is required");
      return env.CATALOGS.getByName(rest.principal).fetch(
        new Request(`https://pages.internal${OPERATOR_TARGETS_ROUTE}`, {
          method: "POST",
          body: JSON.stringify({ principal: rest.principal }),
        }),
      );
    case "status": {
      const pageIds = rest.page_ids ?? [];
      const cellIds = rest.cell_ids ?? [];
      if (
        !Array.isArray(pageIds) ||
        !Array.isArray(cellIds) ||
        pageIds.length + cellIds.length > STATUS_BATCH ||
        pageIds.some((id) => !validPageId(id)) ||
        cellIds.some((id) => !CELL_ID.test(String(id)))
      )
        return invalid(`page_ids and cell_ids: up to ${STATUS_BATCH} in all`);
      const cells = [];
      for (const id of pageIds) cells.push(await status(env.PAGES.getByName(id), cellOf(id)));
      for (const id of cellIds) cells.push(await status(byCell(id), id));
      return json({ cells });
    }
    case "convert": {
      const { page_id: given, cell_id: cell, owner } = rest;
      if (owner !== undefined && (typeof owner !== "string" || !owner))
        return invalid("owner must be a principal");
      let pageId = given;
      let cellId;
      if (given !== undefined) {
        if (!validPageId(given) || cell !== undefined)
          return invalid("Supply a page_id or a cell_id");
        cellId = cellOf(given);
      } else if (CELL_ID.test(String(cell ?? ""))) {
        cellId = cell;
        // The record names the Page this cell holds.
        const found = await status(byCell(cell), cell);
        if (!validPageId(found.page_id)) return json({ cell_id: cell, status: found });
        pageId = found.page_id;
      } else return invalid("Supply a page_id or a cell_id");
      const stub = () => (given !== undefined ? env.PAGES.getByName(pageId) : byCell(cellId));
      let outcome;
      try {
        const response = await post(
          stub(),
          { mode: "convert", page_id: pageId, ...(owner && { owner }) },
          AbortSignal.timeout?.(CONVERT_TIMEOUT_MS),
        );
        outcome = await answer(response);
      } catch (error) {
        // A converted object resets under its own request.
        outcome = { error: String(error?.message ?? error).slice(0, 200) };
      }
      return json({
        cell_id: cellId,
        page_id: pageId,
        outcome,
        status: await status(stub(), cellId),
      });
    }
    default:
      return invalid("action must be accounts, targets, status or convert");
  }
}
