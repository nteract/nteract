// ONE-SHOT MIGRATION: clear the PageRecords object of every Page converted
// from `buffered` Subduction storage. Delete this module, its route in
// worker/index.mjs, scripts/page-records-sweep-operator.mjs and their tests
// once the sweep has run on pages and page10, together with the PageRecords
// class (worker/page-records.mjs).
//
// The gateway route `POST /api/operator/page-records` sits behind the lab
// operator gate (worker/operator-gate.mjs). It takes up to 25 Page cell ids
// from `celld cell list Page` and asks each Page host, through the host-only
// `/internal/operator-page-records`, to report (`dry_run`) or clear (`apply`)
// its PageRecords object. The Page host decides from its own record:
//
// - `none`: the Page never had buffered storage, so it has no PageRecords
//   object, and none is created by asking.
// - `held`: its record still names Subduction storage and isn't deleted. No
//   deployed Page should, and its records are its only history, so they stay.
// - `would_clear` / `empty` (dry run) and `cleared` (apply), with the keys and
//   bytes the object held. Its content lives in the Page's plain storage now.
// - `missing`: the cell holds no Page record.

/** Most cell ids one call takes. */
export const SWEEP_BATCH = 25;
const CELL_ID = /^[0-9a-f]{64}$/;

const respond = (body, status = 200) => Response.json(body, { status });

/** The gateway side of the operator route. */
export async function operatorPageRecordsSweep(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const { mode, cell_ids: ids } = body ?? {};
  if (!["dry_run", "apply"].includes(mode))
    return respond({ error: 'mode must be "dry_run" or "apply"', code: "invalid_arguments" }, 400);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > SWEEP_BATCH ||
    !ids.every((id) => typeof id === "string" && CELL_ID.test(id))
  )
    return respond(
      { error: `cell_ids must be 1 to ${SWEEP_BATCH} cell ids`, code: "invalid_arguments" },
      400,
    );
  const pages = [];
  for (const cell_id of ids) {
    let result;
    try {
      const response = await env.PAGES.get(env.PAGES.idFromString(cell_id)).fetch(
        new Request("https://pages.internal/internal/operator-page-records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        }),
      );
      result =
        response.status === 200
          ? await response.json()
          : { status: "error", http_status: response.status };
    } catch (error) {
      result = { status: "error", error: String(error?.message ?? error).slice(0, 200) };
    }
    pages.push({ cell_id, ...result });
  }
  return respond({ mode, pages });
}

/** Totals over a sweep's page results. */
export function sweepTotals(pages) {
  const totals = { pages: 0, by_status: {}, keys: 0, bytes: 0 };
  for (const page of pages) {
    totals.pages++;
    totals.by_status[page.status] = (totals.by_status[page.status] ?? 0) + 1;
    const held = page.cleared ?? page.records;
    if (held) {
      totals.keys += held.keys;
      totals.bytes += held.bytes;
    }
  }
  return totals;
}
