/**
 * ONE-SHOT MIGRATION. DELETE AFTER THE PRODUCTION MIGRATION HAS BEEN APPLIED.
 *
 * This is the only module that reads the retired "home Page" shape. Builds
 * before it gave each Project a separate root Page entry: a Catalog
 * `space/<id>` record and the Space record named it `home_page_id`, the
 * entry carried `home: true` (location shape v1) or was only named by the
 * record (v0), the Project's top-level Pages were that entry's children, and
 * create intents and receipts carried `home_page_id`, `home_page_title`,
 * `homeTitle` and the `home_created` phase.
 *
 * The current shape: the Project's content document keeps its `page/<id>`
 * entry (title, quota slot, index row, direct grants all unchanged) marked
 * `project_content: <space_id>` with no location fields; its former children
 * become roots carrying `space_id` (a trashed child keeps that `space_id` as
 * its restore hint); records and receipts name the document `document_id`.
 *
 * Steady-state code never reads the old names. It calls `hasLegacyHomeShape`
 * (through location-shape.mjs and catalog-location.mjs) and refuses with
 * `503 location_migration_required` while a Catalog still holds them, so it
 * fails closed instead of misreading. When this module is deleted, replace
 * that call with `false`.
 *
 * Invocation: `POST /api/admin/home-removal` as the Catalog's owner (browser
 * session or API key with write), body `{ "mode": "dry_run" | "apply" }`.
 * The Catalog runs it in its serial queue:
 * - `dry_run` writes nothing and answers the report (and, while an apply is
 *   unfinished, where it stands).
 * - `apply` refuses (`409 home_removal_blocked`) while the report lists
 *   blockers. Otherwise it runs the `homeRemovalStep` machine below:
 *   1. `planning`: the state record is written first, so every steady-state
 *      location read and write refuses (503) from here until `done`. Then
 *      each live or pending Space record is rewritten by its Durable Object
 *      (`/internal/space/remove-home`, which keeps its own before-images),
 *      and the whole Catalog plan is saved under `host/home-removal/plan/`.
 *      The plan is computed once from the untouched Catalog, so a resume
 *      replays the same keys and positions; tied siblings keep their order.
 *   2. `applying`: plan items commit in batches. Each batch is one
 *      transaction holding the items, their before-images and the cursor.
 *   3. Final validation over the stored Catalog, then one transaction that
 *      saves the shape record's before-image, stamps location shape v2 and
 *      marks the state `done`. A failed validation leaves `failed` (still
 *      refusing reads) and answers 409 with the problems.
 *   A crash anywhere resumes from the stored state on the next apply.
 *
 * Before-images (manual restore source; each saved once, never overwritten;
 * `{ "home_removal_absent": true }` means the key didn't exist):
 * - Catalog: `host/home-removal/before/<key>` for every rewritten `page/`,
 *   `trash/`, `space/` and `host/operation/` key, and for
 *   `host/location/shape`.
 * - Space Durable Object: `host/home-removal/before/space/record` and
 *   `host/home-removal/before/host/receipt/<id>`.
 * Restore: copy every before-image back over its key (deleting keys whose
 * image is the absent marker) in the Catalog and in each Space object, then
 * delete `host/home-removal/state` and `host/home-removal/plan/*`.
 *
 * Pending create intents: the `home_created` phase maps to
 * `content_created`, and `homeTitle` to `contentTitle`, so a retry with the
 * original idempotency key finishes the creation in this build. Stored
 * receipts lose `home_page_title` and rename `home_page_id` to `document_id`.
 */
import { generateNKeysBetween } from "fractional-indexing";
import { validPositionKey } from "../model/location.mjs";

export const HOME_REMOVAL_BACKUP_PREFIX = "host/home-removal/before/";
export const HOME_REMOVAL_MODES = Object.freeze(["dry_run", "apply"]);

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** Whether a record or receipt still carries the retired field names. */
function hasLegacyFields(value) {
  return (
    isObject(value) &&
    ("home_page_id" in value || "home_page_title" in value || "home_page_url" in value)
  );
}

/**
 * Whether a Catalog still holds the retired shape: any `page/`/`trash/` entry
 * flagged `home`, or any `space/` record naming `home_page_id`. `entries` and
 * `spaces` are iterables of stored values. Steady-state code refuses to read
 * location while this holds.
 */
export function hasLegacyHomeShape(entries, spaces) {
  for (const entry of entries) if (isObject(entry) && entry.home === true) return true;
  for (const space of spaces) if (hasLegacyFields(space)) return true;
  return false;
}

/** A record or receipt in the current names: `document_id`, nothing home. */
export function withoutHomeFields(value) {
  if (!hasLegacyFields(value)) return value;
  const { home_page_id: legacy, home_page_title: _title, home_page_url: _url, ...rest } = value;
  return legacy === undefined ? rest : { ...rest, document_id: rest.document_id ?? legacy };
}

/** `value` with every nested object in the current names. */
function withoutHomeFieldsDeep(value) {
  if (Array.isArray(value)) return value.map(withoutHomeFieldsDeep);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(withoutHomeFields(value)).map(([key, item]) => [
      key,
      withoutHomeFieldsDeep(item),
    ]),
  );
}
const hasLegacyFieldsDeep = (value) =>
  Array.isArray(value)
    ? value.some(hasLegacyFieldsDeep)
    : isObject(value) && (hasLegacyFields(value) || Object.values(value).some(hasLegacyFieldsDeep));

/** A stored create or update intent in the current names, or the same object
 * when nothing changes. Receipts are converted at any depth: a superseded
 * receipt nests the Project it reports. */
export function migrateIntent(intent) {
  if (!isObject(intent)) return intent;
  let next = intent;
  const set = (patch) => {
    next = { ...next, ...patch };
  };
  if (next.phase === "home_created") set({ phase: "content_created" });
  if ("homeTitle" in next) {
    const { homeTitle, ...rest } = next;
    next = { ...rest, contentTitle: next.contentTitle ?? homeTitle };
  }
  if (hasLegacyFieldsDeep(next.receipt)) set({ receipt: withoutHomeFieldsDeep(next.receipt) });
  if (hasLegacyFieldsDeep(next.space)) set({ space: withoutHomeFieldsDeep(next.space) });
  return next;
}

const byOrder = (a, b) =>
  (a.position < b.position ? -1 : a.position > b.position ? 1 : 0) ||
  (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0);

/** New keys (`{ page_id: key }`) for every sibling after the first in each
 * run of equal keys, in (position, page_id) order. */
function repairTies(siblings) {
  const sorted = [...siblings].sort(byOrder);
  const rekeyed = {};
  for (let i = 1; i < sorted.length; ) {
    if (sorted[i - 1].position !== sorted[i].position) {
      i++;
      continue;
    }
    let end = i;
    while (end < sorted.length && sorted[end].position === sorted[i - 1].position) end++;
    const upper = end < sorted.length ? sorted[end].position : null;
    const keys = generateNKeysBetween(sorted[i - 1].position, upper, end - i);
    for (let j = i; j < end; j++) rekeyed[sorted[j].page_id] = keys[j - i];
    i = end;
  }
  return rekeyed;
}

/**
 * Plan the Catalog's migration. Pure.
 *
 * Input: Maps of stored key → value for `page/` (`pages`), `trash/`
 * (`trash`), `space/` (`spaces`) and `host/operation/` (`intents`).
 *
 * Returns `{ writes, spaceIds, report }`: `writes` maps storage keys to
 * their new values; `spaceIds` lists live Projects whose Space record the
 * apply rewrites first; `report` is what dry_run answers:
 * `{ projects: [{ project_id, document_id, content_found, reparented,
 * reparented_trashed }], entries_changed, intents_changed, blockers }`.
 * Blockers (`{ code, page_id?, project_id? }`) stop apply:
 * `content_not_root` (a named content entry with a parent) and
 * `content_trashed` (a named content entry in Trash).
 */
export function planHomeRemoval({ pages, trash, spaces, intents = new Map() }) {
  const writes = new Map();
  const blockers = [];
  const report = { projects: [], entries_changed: 0, intents_changed: 0, blockers };
  const current = (key) => writes.get(key) ?? pages.get(key) ?? trash.get(key);
  const put = (key, value) => writes.set(key, value);

  // Content documents by Project: the record's document, else a flagged root.
  const contentOf = new Map();
  const spaceIds = [];
  for (const [key, record] of spaces) {
    if (!isObject(record) || !record.space_id) continue;
    // A pending Project's Space object may already hold the old record (a
    // creation stopped after `space_recorded`); a retry must read it.
    spaceIds.push(record.space_id);
    const documentId = record.document_id ?? record.home_page_id;
    if (documentId) contentOf.set(record.space_id, documentId);
    if (hasLegacyFields(record)) put(key, withoutHomeFields(record));
  }
  for (const entry of pages.values())
    if (isObject(entry) && entry.home === true && entry.space_id && !contentOf.has(entry.space_id))
      contentOf.set(entry.space_id, entry.page_id);

  const projectOfContent = new Map([...contentOf].map(([spaceId, id]) => [id, spaceId]));
  for (const [spaceId, documentId] of contentOf) {
    const summary = {
      project_id: spaceId,
      document_id: documentId,
      content_found: false,
      reparented: 0,
      reparented_trashed: 0,
    };
    report.projects.push(summary);
    if (trash.has(`trash/${documentId}`)) {
      blockers.push({ code: "content_trashed", page_id: documentId, project_id: spaceId });
      continue;
    }
    const key = `page/${documentId}`;
    const entry = pages.get(key);
    if (!isObject(entry) || entry.reservation) continue;
    summary.content_found = true;
    if (entry.parent_id !== null && entry.parent_id !== undefined) {
      blockers.push({ code: "content_not_root", page_id: documentId, project_id: spaceId });
      continue;
    }
    if (entry.project_content === spaceId && !("home" in entry) && !("space_id" in entry)) continue;
    const {
      home: _home,
      space_id: _space,
      parent_id: _parent,
      position: _position,
      restore_space_id: _restore,
      ...kept
    } = entry;
    put(key, { ...kept, project_content: spaceId });
  }

  // Other flagged entries (a duplicate home, or one in Trash) stay Pages.
  for (const map of [pages, trash])
    for (const [key, entry] of map) {
      if (!isObject(entry) || entry.home !== true || projectOfContent.has(entry.page_id)) continue;
      const { home: _home, ...kept } = writes.get(key) ?? entry;
      put(key, kept);
    }

  // Children of a content document become roots of its Project.
  for (const map of [pages, trash])
    for (const [key, stored] of map) {
      if (!isObject(stored) || stored.reservation) continue;
      const spaceId = projectOfContent.get(stored.parent_id);
      if (!spaceId) continue;
      const entry = current(key);
      const { restore_space_id: _restore, ...kept } = entry;
      put(key, { ...kept, parent_id: null, space_id: spaceId });
      const summary = report.projects.find((project) => project.project_id === spaceId);
      if (map === trash) summary.reparented_trashed++;
      else summary.reparented++;
    }

  // Distinct keys among each Project's active roots, as a move leaves them.
  const roots = new Map();
  for (const [key, stored] of pages) {
    const entry = current(key);
    if (!isObject(entry) || entry.reservation || entry.project_content) continue;
    if (entry.parent_id !== null || !entry.space_id || !validPositionKey(entry.position)) continue;
    if (!roots.has(entry.space_id)) roots.set(entry.space_id, []);
    roots.get(entry.space_id).push({ key, page_id: stored.page_id, position: entry.position });
  }
  for (const siblings of roots.values())
    for (const [pageId, position] of Object.entries(repairTies(siblings)))
      put(`page/${pageId}`, { ...current(`page/${pageId}`), position });

  for (const [key, intent] of intents) {
    const next = migrateIntent(intent);
    if (next !== intent) {
      put(key, next);
      report.intents_changed++;
    }
  }
  report.entries_changed = [...writes.keys()].filter(
    (key) => key.startsWith("page/") || key.startsWith("trash/"),
  ).length;
  return { writes, spaceIds, report };
}

/** The Space Durable Object's record and stored receipts in the current
 * names: `{ writes }` by storage key. Pure. */
export function planSpaceHomeRemoval(record, receipts = new Map()) {
  const writes = new Map();
  if (hasLegacyFields(record)) writes.set("space/record", withoutHomeFields(record));
  for (const [key, stored] of receipts)
    if (isObject(stored) && hasLegacyFieldsDeep(stored.receipt))
      writes.set(key, { ...stored, receipt: withoutHomeFieldsDeep(stored.receipt) });
  return { writes };
}

const transact = (storage, work) =>
  typeof storage.transaction === "function" ? storage.transaction(work) : work(storage);

export const HOME_REMOVAL_STATE_KEY = "host/home-removal/state";
export const HOME_REMOVAL_PLAN_PREFIX = "host/home-removal/plan/";
export const HOME_REMOVAL_ABSENT = Object.freeze({ home_removal_absent: true });
const SHAPE_KEY = "host/location/shape";
const planKey = (index) => `${HOME_REMOVAL_PLAN_PREFIX}${String(index).padStart(8, "0")}`;

/**
 * The apply lifecycle, as a pure transition function over
 * `{ phase, next?, total?, problems? }`:
 *
 *   none|failed --start--> planning --planned{total}--> applying{next:0}
 *   planning --start--> planning (a resume plans again: nothing was applied)
 *   applying --batch{next}--> applying (next only grows, up to total)
 *   applying{next=total} --validated--> done
 *   applying{next=total} --invalid{problems}--> failed
 *
 * Returns `{ state }` or `{ state, rejected }`.
 */
export function homeRemovalStep(state, event) {
  const reject = (rejected) => ({ state, rejected });
  const phase = state?.phase ?? "none";
  switch (event.type) {
    case "start":
      if (!["none", "failed", "planning"].includes(phase)) return reject(`can't start in ${phase}`);
      return { state: { phase: "planning" } };
    case "planned":
      if (phase !== "planning") return reject("no plan is being made");
      if (!Number.isSafeInteger(event.total) || event.total < 0) return reject("bad total");
      return { state: { phase: "applying", next: 0, total: event.total } };
    case "batch":
      if (phase !== "applying") return reject("not applying");
      if (!(event.next > state.next && event.next <= state.total)) return reject("bad cursor");
      return { state: { ...state, next: event.next } };
    case "validated":
      if (phase !== "applying" || state.next !== state.total) return reject("plan not applied");
      return { state: { phase: "done" } };
    case "invalid":
      if (phase !== "applying" || state.next !== state.total) return reject("plan not applied");
      return { state: { phase: "failed", problems: event.problems ?? [] } };
    default:
      return reject("unknown event");
  }
}

/** A planned write as a change to whatever the key holds when it applies:
 * fields set and fields removed. Title projections may touch an entry
 * between planning and applying; only the planned fields change. */
export function patchOf(before, after) {
  const set = {};
  for (const [field, value] of Object.entries(after))
    if (JSON.stringify(before?.[field]) !== JSON.stringify(value)) set[field] = value;
  const unset = Object.keys(before ?? {}).filter((field) => !(field in after));
  return { set, unset };
}
const applyPatch = (current, { set, unset }) => {
  const next = { ...current, ...set };
  for (const field of unset) delete next[field];
  return next;
};

/**
 * Problems with a Catalog that claims to be through the migration, as
 * strings; empty when it is sound: no retired marker, no entry whose parent
 * is a content document, and distinct keys among each Project's roots.
 */
export function validateHomeRemoval({ pages, trash, spaces }) {
  const problems = [];
  const entries = [...pages.values(), ...trash.values()].filter(
    (entry) => isObject(entry) && !entry.reservation,
  );
  if (hasLegacyHomeShape(entries, spaces.values())) problems.push("retired marker remains");
  const contents = new Set(
    [...pages.values()].filter((entry) => entry?.project_content).map((entry) => entry.page_id),
  );
  for (const entry of entries)
    if (entry.parent_id && contents.has(entry.parent_id))
      problems.push(`${entry.page_id} is under content ${entry.parent_id}`);
  const seen = new Set();
  for (const entry of pages.values())
    if (isObject(entry) && !entry.reservation && entry.parent_id === null && entry.space_id) {
      const key = `${entry.space_id}/${entry.position}`;
      if (seen.has(key)) problems.push(`${entry.page_id} ties at ${key}`);
      seen.add(key);
    }
  return problems;
}

/** Read what `planHomeRemoval` needs from Catalog storage. */
export async function readHomeRemovalInput(storage, listAll) {
  return {
    pages: await listAll(storage, "page/"),
    trash: await listAll(storage, "trash/"),
    spaces: await listAll(storage, "space/"),
    intents: await listAll(storage, "host/operation/"),
  };
}

/**
 * Run (or resume) an apply against Catalog storage. `rewriteSpaces(ids)` is
 * the effect that migrates each Space object; `perBatch` bounds keys per
 * storage call. Returns `{ state, report, writes }`; throws a `blockers`
 * error before writing anything when the plan can't proceed.
 */
export async function applyHomeRemoval(storage, { listAll, rewriteSpaces, perBatch }) {
  let state = (await storage.get(HOME_REMOVAL_STATE_KEY)) ?? { phase: "none" };
  const step = (event) => {
    const result = homeRemovalStep(state, event);
    if (result.rejected) throw new Error(`Home removal: ${result.rejected}`);
    state = result.state;
  };
  let report;
  if (state.phase === "done") return { state, report: null, writes: 0 };
  if (state.phase !== "applying") {
    const input = await readHomeRemovalInput(storage, listAll);
    const plan = planHomeRemoval(input);
    report = plan.report;
    if (plan.report.blockers.length)
      throw Object.assign(new Error("blocked"), { blockers: plan.report.blockers });
    step({ type: "start" });
    // From here every steady-state read refuses until `done`.
    await storage.put(HOME_REMOVAL_STATE_KEY, state);
    await rewriteSpaces(plan.spaceIds);
    const original = (key) =>
      input.pages.get(key) ??
      input.trash.get(key) ??
      input.spaces.get(key) ??
      input.intents.get(key);
    const items = [...plan.writes].map(([key, value]) => ({
      key,
      ...patchOf(original(key), value),
    }));
    for (let at = 0; at < items.length; at += perBatch)
      await storage.put(
        Object.fromEntries(
          items.slice(at, at + perBatch).map((item, i) => [planKey(at + i), item]),
        ),
      );
    step({ type: "planned", total: items.length });
    await storage.put(HOME_REMOVAL_STATE_KEY, state);
  }
  // Each batch: items, their before-images and the cursor, in one call.
  const itemsPerBatch = Math.max(1, Math.floor((perBatch - 1) / 2));
  while (state.next < state.total) {
    const end = Math.min(state.total, state.next + itemsPerBatch);
    const from = state.next;
    step({ type: "batch", next: end });
    const record = state;
    await transact(storage, async (target) => {
      const puts = { [HOME_REMOVAL_STATE_KEY]: record };
      for (let index = from; index < end; index++) {
        const item = await target.get(planKey(index));
        const current = await target.get(item.key);
        const backup = `${HOME_REMOVAL_BACKUP_PREFIX}${item.key}`;
        if ((await target.get(backup)) === undefined)
          puts[backup] = current === undefined ? HOME_REMOVAL_ABSENT : current;
        if (current !== undefined) puts[item.key] = applyPatch(current, item);
      }
      await target.put(puts);
    });
  }
  const total = state.total;
  const problems = validateHomeRemoval(await readHomeRemovalInput(storage, listAll));
  step(problems.length ? { type: "invalid", problems } : { type: "validated" });
  const shapeBackup = `${HOME_REMOVAL_BACKUP_PREFIX}${SHAPE_KEY}`;
  const priorShape = await storage.get(SHAPE_KEY);
  const finished = state;
  await transact(storage, async (target) => {
    const puts = { [HOME_REMOVAL_STATE_KEY]: finished };
    if (finished.phase === "done") {
      if ((await target.get(shapeBackup)) === undefined)
        puts[shapeBackup] = priorShape === undefined ? HOME_REMOVAL_ABSENT : priorShape;
      puts[SHAPE_KEY] = { version: 2, state: "migrated" };
    }
    await target.put(puts);
  });
  return { state, report, writes: total };
}
