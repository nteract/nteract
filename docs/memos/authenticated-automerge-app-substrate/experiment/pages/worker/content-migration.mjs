/**
 * ONE-SHOT MIGRATION. DELETE AFTER THE PRODUCTION CONTENT MIGRATION HAS BEEN
 * APPLIED AND VERIFIED, with model/content-normalization.mjs (which says
 * what the migration writes), both test files, scripts/content-migration.mjs
 * and the ONE-SHOT routes and flag in worker/index.mjs.
 *
 * The owner's run over their Pages. Invocation: `POST
 * /api/admin/content-migration` as the account owner (browser session or API
 * key; `apply` needs write), body `{ "mode": "dry_run" | "apply", "limit"?,
 * "after"?, "page_ids"? }`. The gateway forwards it to the caller's own
 * Catalog, which runs it in its serial queue and calls each Page host's
 * host-only `/internal/content-migration` route with the owner's principal.
 * The Page host checks that principal against its record and is the only
 * writer of its document (worker/index.mjs `contentMigration`).
 *
 * Targets, by page_id: every owned `page/` entry (Project content documents
 * and pending reservations included), every `trash/` entry, every
 * `host/deleted/` tombstone, and any `page_ids` from the body. `shared/`
 * entries belong to other owners' runs.
 *
 * - `dry_run` writes nothing of its own. It visits up to `limit` targets
 *   after `after` and answers their reports, the next cursor, and the Catalog
 *   summary (targets by kind, tombstones). Booting a Page runs its existing
 *   on-load work (preserved conversion, comments move, the `comments_doc`
 *   record field), as any read does.
 * - `apply` runs the `contentMigrationStep` machine below, `limit` Pages per
 *   call; call again until `progress.phase` is `done` or `incomplete`.
 *
 * State: `host/content-migration/state` holds the machine state;
 * `host/content-migration/result/<page_id>` holds each Page's latest result
 * and `revert`, every write the Page has reported (`{ key, before_heads,
 * after_heads, blocks }`), carried across visits: the restore reference.
 * Both are written together after each visit. The Page host keeps the same
 * records (`host/content-migration/revert`) and reports them on every
 * visit, so a crash between its write and this put loses nothing.
 */
import { validPageId } from "./registration.mjs";

export const CONTENT_MIGRATION_MODES = Object.freeze(["dry_run", "apply"]);
export const CONTENT_MIGRATION_STATE_KEY = "host/content-migration/state";
export const CONTENT_MIGRATION_RESULT_PREFIX = "host/content-migration/result/";
/** `budgetMs`: a call starts no visit after this long, so with each visit's
 * own deadline it ends inside the Catalog queue's 120 s bound. */
export const CONTENT_MIGRATION_LIMITS = Object.freeze({
  batch: 10,
  maxBatch: 25,
  extraIds: 100,
  budgetMs: 60_000,
});
/** Page outcomes that need no further visit. Every other status (busy,
 * stale, held, partial, unavailable, record_pending, error) stays pending. */
export const SETTLED_STATUSES = new Set([
  "normalized",
  "unchanged",
  "deleted",
  "missing",
  "not_owner",
]);

const KINDS = [
  ["page/", "page"],
  ["trash/", "trash"],
  ["host/deleted/", "deleted"],
];

/** The run's arguments, validated. Throws `{ status: 400, code }`. */
export function contentMigrationArguments(body) {
  const invalid = (message) =>
    Object.assign(new Error(message), { status: 400, code: "invalid_arguments" });
  const {
    mode,
    limit = CONTENT_MIGRATION_LIMITS.batch,
    after = null,
    page_ids = [],
    include_connected = false,
  } = body ?? {};
  if (!CONTENT_MIGRATION_MODES.includes(mode)) throw invalid('mode must be "dry_run" or "apply"');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTENT_MIGRATION_LIMITS.maxBatch)
    throw invalid(`limit must be 1–${CONTENT_MIGRATION_LIMITS.maxBatch}`);
  if (after !== null && !validPageId(after)) throw invalid("after must be a page_id");
  if (
    !Array.isArray(page_ids) ||
    page_ids.length > CONTENT_MIGRATION_LIMITS.extraIds ||
    page_ids.some((id) => !validPageId(id))
  )
    throw invalid(`page_ids must be up to ${CONTENT_MIGRATION_LIMITS.extraIds} page_ids`);
  if (typeof include_connected !== "boolean") throw invalid("include_connected must be a boolean");
  return { mode, limit, after, page_ids: [...new Set(page_ids)], include_connected };
}

/**
 * Every Page this Catalog can name, sorted by page_id: `[{ page_id, kind }]`,
 * where kind is `page`, `trash`, `deleted` or `extra` (named only by the
 * request). A Page named twice keeps the first kind in that order. Also
 * returns the tombstones: `[{ page_id, trash_entry }]`, where `trash_entry`
 * says a `trash/` entry remains beside the tombstone (inventory #22, which
 * this migration reports and doesn't finish).
 */
export async function contentMigrationTargets(storage, listAll, extra = []) {
  const kinds = new Map();
  const keys = new Map();
  for (const [prefix, kind] of KINDS)
    for (const key of (await listAll(storage, prefix)).keys()) {
      const id = key.slice(prefix.length);
      keys.set(`${prefix}${id}`, true);
      if (!kinds.has(id)) kinds.set(id, kind);
    }
  for (const id of extra) if (!kinds.has(id)) kinds.set(id, "extra");
  const targets = [...kinds]
    .map(([page_id, kind]) => ({ page_id, kind }))
    .sort((a, b) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0));
  const tombstones = [...keys.keys()]
    .filter((key) => key.startsWith("host/deleted/"))
    .map((key) => key.slice("host/deleted/".length))
    .sort()
    .map((page_id) => ({ page_id, trash_entry: keys.has(`trash/${page_id}`) }));
  return { targets, tombstones };
}

/**
 * The apply lifecycle, as a pure transition function over
 * `{ phase, ids?, next?, pass?, pending? }`:
 *
 *   none|incomplete --start{ids}--> applying{ids, next: 0, pass: pass + 1}
 *   applying --visited{page_id = ids[next]}--> applying{next + 1}
 *   applying{next = |ids|} --finished{pending: []}--> done{pass}
 *   applying{next = |ids|} --finished{pending}--> incomplete{pending, pass}
 *
 * `done` is terminal; a dry_run afterwards is the verification. A resume
 * after a crash continues from `ids[next]`. Returns `{ state }` or
 * `{ state, rejected }`.
 */
export function contentMigrationStep(state, event) {
  const reject = (rejected) => ({ state, rejected });
  const phase = state?.phase ?? "none";
  switch (event.type) {
    case "start": {
      if (!["none", "incomplete"].includes(phase)) return reject(`can't start in ${phase}`);
      const ids = event.ids;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return reject("bad ids");
      return { state: { phase: "applying", ids: [...ids], next: 0, pass: (state?.pass ?? 0) + 1 } };
    }
    case "visited":
      if (phase !== "applying") return reject("not applying");
      if (state.next >= state.ids.length || state.ids[state.next] !== event.page_id)
        return reject("out of order");
      return { state: { ...state, next: state.next + 1 } };
    case "finished": {
      if (phase !== "applying" || state.next !== state.ids.length) return reject("pass unfinished");
      const pending = event.pending ?? [];
      if (!Array.isArray(pending) || pending.some((id) => !state.ids.includes(id)))
        return reject("bad pending");
      return pending.length
        ? { state: { phase: "incomplete", pending: [...pending], pass: state.pass } }
        : { state: { phase: "done", pass: state.pass } };
    }
    default:
      return reject("unknown event");
  }
}

/** The state without its id list, for responses: where the pass stands. */
export function progressOf(state) {
  const { ids, ...rest } = state ?? { phase: "none" };
  return ids ? { ...rest, total: ids.length } : rest;
}

/** Counts across Page results: by status, by old form, writes and refusals. */
export function summarize(results) {
  const totals = {
    pages: 0,
    statuses: {},
    forms: {},
    block_writes: 0,
    refused_blocks: 0,
    refused_reasons: {},
  };
  for (const result of results) {
    totals.pages++;
    totals.statuses[result.status] = (totals.statuses[result.status] ?? 0) + 1;
    const report = result.report;
    if (!report) continue;
    totals.block_writes += report.blocks?.filter((block) => block.action !== "refused").length ?? 0;
    totals.refused_blocks += report.refused ?? 0;
    for (const [form, n] of Object.entries(report.forms ?? {}))
      totals.forms[form] = (totals.forms[form] ?? 0) + n;
    for (const [reason, n] of Object.entries(report.refused_reasons ?? {}))
      totals.refused_reasons[reason] = (totals.refused_reasons[reason] ?? 0) + n;
  }
  return totals;
}

/** Revert records from both lists, once each by journal key, earliest
 * first. */
export function mergeRevert(kept = [], reported = []) {
  const merged = [...kept];
  const keys = new Set(kept.map((record) => record.key));
  for (const record of reported)
    if (!keys.has(record.key)) {
      merged.push(record);
      keys.add(record.key);
    }
  return merged;
}

/** What the Catalog keeps of a Page result: everything but per-block detail,
 * plus every revert record this Page has reported, kept across visits.
 * `previous` is the stored result this one replaces. */
export function storedResult(result, now, previous) {
  const { report, revert: reported, ...fields } = result;
  const revert = mergeRevert(previous?.revert, reported);
  const rest = { ...fields, ...(revert.length && { revert }) };
  if (!report) return { ...rest, at: now };
  const { blocks, ...counts } = report;
  return {
    ...rest,
    report: {
      ...counts,
      refused_block_ids: (blocks ?? [])
        .filter((block) => block.action === "refused")
        .map((block) => block.block_id),
    },
    at: now,
  };
}

/** A Page visit that failed, as a result. */
const failedVisit = (page_id, error) => ({
  page_id,
  status: "error",
  error: String(error?.message ?? error).slice(0, 200),
});

async function visitSafely(visit, page_id, mode, options) {
  try {
    const result = await visit(page_id, mode, options);
    return { ...result, page_id };
  } catch (error) {
    return failedVisit(page_id, error);
  }
}

/**
 * Run one call of the migration against Catalog storage. `visit(page_id,
 * mode, options)` asks the Page host and answers its result (`options`:
 * `{ include_connected }`); `listAll` reads a prefix;
 * `clock()` is milliseconds (Date.now). Returns the response body.
 */
export async function runContentMigration(
  storage,
  { args, listAll, visit, clock = Date.now, budgetMs = CONTENT_MIGRATION_LIMITS.budgetMs },
) {
  const { mode, limit, after, page_ids, include_connected } = args;
  const options = { include_connected };
  const started = clock();
  const inBudget = (visited) => visited === 0 || clock() - started < budgetMs;
  if (mode === "dry_run") {
    const { targets, tombstones } = await contentMigrationTargets(storage, listAll, page_ids);
    const start = after === null ? 0 : targets.findIndex((target) => target.page_id > after);
    const pages = [];
    for (const target of start < 0 ? [] : targets.slice(start, start + limit)) {
      if (!inBudget(pages.length)) break;
      pages.push({
        ...(await visitSafely(visit, target.page_id, mode, options)),
        kind: target.kind,
      });
    }
    const last = pages.at(-1)?.page_id ?? null;
    const kinds = {};
    for (const target of targets) kinds[target.kind] = (kinds[target.kind] ?? 0) + 1;
    return {
      mode,
      targets: { total: targets.length, ...kinds },
      tombstones,
      pages,
      visited: pages.map((page) => page.page_id),
      next: last !== null && targets.at(-1).page_id !== last ? last : null,
      totals: summarize(pages),
      progress: progressOf(await storage.get(CONTENT_MIGRATION_STATE_KEY)),
    };
  }
  let state = (await storage.get(CONTENT_MIGRATION_STATE_KEY)) ?? { phase: "none" };
  const step = (event) => {
    const result = contentMigrationStep(state, event);
    if (result.rejected) throw new Error(`Content migration: ${result.rejected}`);
    state = result.state;
  };
  if (state.phase === "done") return { mode, pages: [], visited: [], progress: progressOf(state) };
  if (state.phase === "none" || state.phase === "incomplete") {
    const { targets } = await contentMigrationTargets(storage, listAll, page_ids);
    const ids =
      state.phase === "none"
        ? targets.map((target) => target.page_id)
        : [...new Set([...state.pending, ...page_ids])].sort();
    step({ type: "start", ids });
    await storage.put(CONTENT_MIGRATION_STATE_KEY, state);
  }
  const pages = [];
  while (state.next < state.ids.length && pages.length < limit && inBudget(pages.length)) {
    const page_id = state.ids[state.next];
    const result = await visitSafely(visit, page_id, mode, options);
    pages.push(result);
    step({ type: "visited", page_id });
    const resultKey = `${CONTENT_MIGRATION_RESULT_PREFIX}${page_id}`;
    // The result and the cursor land together.
    await storage.put({
      [CONTENT_MIGRATION_STATE_KEY]: state,
      [resultKey]: storedResult(
        result,
        new Date(clock()).toISOString(),
        await storage.get(resultKey),
      ),
    });
  }
  if (state.next === state.ids.length) {
    const pending = [];
    for (const page_id of state.ids) {
      const stored = await storage.get(`${CONTENT_MIGRATION_RESULT_PREFIX}${page_id}`);
      if (!SETTLED_STATUSES.has(stored?.status)) pending.push(page_id);
    }
    step({ type: "finished", pending });
    await storage.put(CONTENT_MIGRATION_STATE_KEY, state);
  }
  return {
    mode,
    pages,
    visited: pages.map((page) => page.page_id),
    totals: summarize(pages),
    progress: progressOf(state),
  };
}
