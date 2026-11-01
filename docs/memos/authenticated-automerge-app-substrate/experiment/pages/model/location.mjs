/**
 * Where a Page lives, as pure functions over one owner's Catalog entries.
 *
 * The owner's Catalog is the only record of location. Every owned Page has one
 * entry, and location is its `parent_id`. A Project is a root Page with a
 * Project record attached: its entry carries `space_id`, and the Project's
 * Pages are that home Page's descendants. Nothing else stores a Project; it
 * is derived by walking parents to the root.
 *
 * State: `{ revision, entries }`. `revision` is the Catalog's location
 * revision; every location write bumps it, and the D1 projection uses it as a
 * fence. `entries` maps page IDs to entries (a Map or a plain object).
 *
 * Entry:
 * - `page_id`: its own key.
 * - `state`: "active", "pending" (its Page object is still being created) or
 *   "trashed".
 * - `parent_id`: an active owned Page, or null for a root. On a trashed
 *   entry it is a restore hint, not tree membership: the Page has left the
 *   active tree, and the parent it names may be active, trashed, or gone.
 * - `position`: a fractional key among its siblings. Roots without
 *   `space_id` are siblings in Your items; a root with `space_id` is alone.
 * - `space_id`: only on a root that is a Project's home Page.
 * - `restore_parent_id`, `restore_space_id`: only on a trashed entry. Where a
 *   restore returns it: under that parent while it is active, otherwise at
 *   that Project's top level, otherwise in Your items. Both are history from
 *   when the Page was trashed, not live pointers: the parent may since have
 *   been purged or moved, and the Project deleted. A restore must check each
 *   against the current tree (an active parent within MAX_DEPTH, a live home
 *   Page) before using it, and fall through to the next when it fails.
 *
 * The Catalog adapter maps these onto its `page/` and `trash/` keys. This
 * module never reads storage, clocks or randomness.
 */
import { BASE_62_DIGITS, generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Deepest nesting a create or move may produce; a root is at depth 1, so a
 * Project's top-level Pages are at depth 2. The design's open question 2
 * picks the final value; 9 keeps eight levels below a Project's home Page. */
export const MAX_DEPTH = 9;
/** Deepest chain the model holds. Before the home Page was a Project's only
 * root, a Project's chain started at depth 1 and could reach MAX_DEPTH; under
 * the home Page the same chain sits one level lower. Such a chain is read and
 * kept whole; it can't grow (MAX_DEPTH bounds new placements), and a move can
 * only take it somewhere it fits. */
export const MAX_TREE_DEPTH = MAX_DEPTH + 1;

export const ENTRY_STATES = Object.freeze(["active", "pending", "trashed"]);

/** Codes a move can be refused with. The API maps each to its HTTP status. */
export const MOVE_REFUSALS = Object.freeze([
  "page_not_found",
  "home_page_protected",
  "placement_cycle",
  "placement_mismatch",
  "page_trashed",
  "parent_unavailable",
  "nesting_depth_exceeded",
  "project_not_found",
  "move_destination_required",
  "invalid_position",
  "position_sibling_unknown",
]);

/** Longest position key accepted, matching Page block positions. */
export const MAX_KEY_LENGTH = 512;
/** A move whose new keys would grow past this rebalances its destination
 * instead. Repeated inserts at one spot add about one character per six
 * inserts, so this leaves room well short of MAX_KEY_LENGTH. */
export const REBALANCE_KEY_LENGTH = 256;
const DIGITS = new Set(BASE_62_DIGITS);
const isId = (value) => typeof value === "string" && value.length > 0;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `key` is a fractional-indexing key. Every character must be a
 * base-62 digit: the generator doesn't check that, and a key such as "a0!"
 * would sort where new keys can't land between it and its neighbours. The
 * generator then applies the library's structural rules (head, integer
 * length, no trailing zero), so a key accepted here can't make a later
 * insertion throw. */
export function validPositionKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  for (const char of key) if (!DIGITS.has(char)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/** Problems with one entry's shape, as strings; empty when it is valid.
 * Unknown fields are allowed so the Catalog can keep title and timestamps on
 * the same record. */
export function entryProblems(entry, key) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return ["entry is not an object"];
  const problems = [];
  if (!isId(entry.page_id)) problems.push("page_id must be a non-empty string");
  else if (key !== undefined && key !== entry.page_id)
    problems.push("page_id differs from its key");
  if (!ENTRY_STATES.includes(entry.state)) problems.push(`state must be one of ${ENTRY_STATES}`);
  if (entry.parent_id !== null && !isId(entry.parent_id))
    problems.push("parent_id must be a page ID or null");
  if (entry.parent_id === entry.page_id) problems.push("parent_id names the entry itself");
  if (!validPositionKey(entry.position)) problems.push("position must be a fractional key");
  if ("space_id" in entry) {
    if (!isId(entry.space_id)) problems.push("space_id must be a Project ID");
    if (entry.parent_id !== null) problems.push("space_id belongs only on a root");
  }
  const trashed = entry.state === "trashed";
  for (const field of ["restore_parent_id", "restore_space_id"])
    if (field in entry) {
      if (!trashed) problems.push(`${field} belongs only on a trashed entry`);
      if (entry[field] !== null && !isId(entry[field]))
        problems.push(`${field} must be an ID or null`);
    }
  return problems;
}

/** Throw when an entry's shape is invalid. */
export function validateEntry(entry, key) {
  const problems = entryProblems(entry, key);
  if (problems.length) throw new TypeError(`Invalid location entry: ${problems.join("; ")}`);
  return entry;
}

const asMap = (entries) =>
  entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}));

/**
 * Walk from `pageId` to its root. Bounded: it stops after MAX_TREE_DEPTH
 * steps and never revisits an entry, so a corrupt map can't make it loop.
 *
 * Returns `{ ok: true, root, space_id, depth, ancestors }`, with `ancestors`
 * nearest first, or `{ ok: false, problem, page_id }` where `problem` is
 * "missing_page", "missing_parent", "cycle" or "too_deep" and `page_id` names
 * the entry where the walk stopped.
 */
export function deriveLocation(entries, pageId) {
  const map = asMap(entries);
  if (!map.has(pageId)) return { ok: false, problem: "missing_page", page_id: pageId };
  const ancestors = [];
  const seen = new Set([pageId]);
  let current = map.get(pageId);
  for (let depth = 1; ; depth++) {
    if (depth > MAX_TREE_DEPTH) return { ok: false, problem: "too_deep", page_id: current.page_id };
    if (current.parent_id === null)
      return {
        ok: true,
        root: current.page_id,
        space_id: current.space_id ?? null,
        depth: depth,
        ancestors,
      };
    const parent = map.get(current.parent_id);
    if (!parent) return { ok: false, problem: "missing_parent", page_id: current.page_id };
    if (seen.has(parent.page_id)) return { ok: false, problem: "cycle", page_id: parent.page_id };
    seen.add(parent.page_id);
    ancestors.push(parent.page_id);
    current = parent;
  }
}

/** Child IDs by parent ID, in sibling order. Trashed entries count only
 * under trashed parents, which keeps them out of the active tree. */
function childrenByParent(map) {
  const children = new Map();
  for (const entry of map.values()) {
    if (entry.parent_id === null) continue;
    if (!children.has(entry.parent_id)) children.set(entry.parent_id, []);
    children.get(entry.parent_id).push(entry);
  }
  for (const list of children.values()) list.sort(siblingOrder);
  return children;
}

const siblingOrder = (a, b) => compare(a.position, b.position) || compare(a.page_id, b.page_id);

/** The Page and every descendant, top-down, each with its depth below the
 * Page (the Page is 0). It follows every child link, however deep, and visits
 * each entry once, so it ends on corrupt input too: an over-deep chain comes
 * back whole and the caller's depth check sees it. */
export function subtreeOf(entries, pageId) {
  const map = asMap(entries);
  if (!map.has(pageId)) return [];
  const children = childrenByParent(map);
  const members = [];
  const seen = new Set();
  let level = [pageId];
  for (let depth = 0; level.length; depth++) {
    const next = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      members.push({ page_id: id, depth });
      for (const child of children.get(id) ?? []) next.push(child.page_id);
    }
    level = next;
  }
  return members;
}

/** The derived `space_id` (or null) for every Page in a subtree, top-down.
 * These are the rows the D1 projection rewrites when the subtree's Project
 * changes. */
export function subtreeSpaceIds(entries, pageId) {
  const map = asMap(entries);
  const location = deriveLocation(map, pageId);
  if (!location.ok) return [];
  return subtreeOf(map, pageId).map(({ page_id }) => ({ page_id, space_id: location.space_id }));
}

/** Siblings under `parentId` in order, without trashed entries and without
 * `excludeId`. `parentId` null means the roots of Your items: a root with
 * `space_id` is a Project's home Page, alone at the top of its Project, so it
 * is nobody's sibling. */
export function siblingsOf(entries, parentId, excludeId) {
  return [...asMap(entries).values()]
    .filter(
      (entry) =>
        entry.parent_id === parentId &&
        entry.state !== "trashed" &&
        entry.page_id !== excludeId &&
        (parentId !== null || !("space_id" in entry)),
    )
    .sort(siblingOrder);
}

/** The home Page entry of a Project, or undefined. Trashed homes don't
 * count; a pending home means the Project is still being created. */
export function homeOf(entries, spaceId) {
  for (const entry of asMap(entries).values())
    if (entry.space_id === spaceId && entry.state !== "trashed") return entry;
  return undefined;
}

/** Whether `position` has a valid shape: "first", "last", {before: id} or
 * {after: id}. */
export function validPosition(position) {
  if (position === "first" || position === "last") return true;
  if (!position || typeof position !== "object" || Array.isArray(position)) return false;
  const keys = Object.keys(position);
  return keys.length === 1 && ["before", "after"].includes(keys[0]) && isId(position[keys[0]]);
}

/**
 * A key for `position` among `siblings` (sorted by siblingOrder, without the
 * Page being placed). Returns `{ ok: true, position, rekeyed }`, where
 * `rekeyed` maps sibling IDs to new keys, or `{ ok: false, code }`.
 *
 * Equal keys come from concurrent writers in older data or imports. A move
 * leaves its destination with distinct keys: the first sibling of each run
 * of equal keys keeps its key, and every other tied sibling is rekeyed in
 * order, together with the placed Page. Without ties only the placed Page
 * gets a key.
 *
 * If any new key would be longer than REBALANCE_KEY_LENGTH, every sibling
 * and the placed Page get evenly spaced fresh keys instead, in the same
 * order. Keys then stay short however often Pages land in one spot.
 */
export function positionAmong(siblings, position = "last") {
  if (!validPosition(position)) return { ok: false, code: "invalid_position" };
  let index;
  if (position === "first") index = 0;
  else if (position === "last") index = siblings.length;
  else {
    const target = position.before ?? position.after;
    const at = siblings.findIndex((sibling) => sibling.page_id === target);
    if (at < 0) return { ok: false, code: "position_sibling_unknown" };
    index = position.before ? at : at + 1;
  }
  // Slots in their final order; null is the placed Page. A sibling keeps its
  // key when it is the first of its run of equal keys. Kept keys are then
  // distinct and increasing, and every other slot gets a fresh key between
  // the kept keys around it.
  const slots = [...siblings.slice(0, index), null, ...siblings.slice(index)];
  const kept = slots.map((slot, i) => slot !== null && !tiedBefore(slots, i));
  const rekeyed = {};
  let placed;
  for (let i = 0; i < slots.length; ) {
    if (kept[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < slots.length && !kept[end]) end++;
    const lower = i > 0 ? slots[i - 1].position : null;
    const upper = end < slots.length ? slots[end].position : null;
    const keys = generateNKeysBetween(lower, upper, end - i);
    for (let j = i; j < end; j++) {
      if (slots[j] === null) placed = keys[j - i];
      else rekeyed[slots[j].page_id] = keys[j - i];
    }
    i = end;
  }
  const lengths = [placed, ...Object.values(rekeyed)].map((key) => key.length);
  if (Math.max(...lengths) <= REBALANCE_KEY_LENGTH) return { ok: true, position: placed, rekeyed };
  const fresh = generateNKeysBetween(null, null, slots.length);
  const rebalanced = {};
  slots.forEach((slot, i) => {
    if (slot === null) placed = fresh[i];
    else if (slot.position !== fresh[i]) rebalanced[slot.page_id] = fresh[i];
  });
  return { ok: true, position: placed, rekeyed: rebalanced };
}

/** Whether an earlier sibling, skipping the placed Page, has the same key as
 * slot `i`. */
function tiedBefore(slots, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (slots[j] === null) continue;
    return slots[j].position === slots[i].position;
  }
  return false;
}

const refuse = (code, message) => ({ ok: false, code, message });

/**
 * Plan a move as one Catalog write.
 *
 * `destination` is `{ project_id?, parent_id? }`:
 * - `project_id: null` with no parent: a root in Your items.
 * - `project_id: "prj_…"` with no parent: the Project's top level, which is
 *   under its home Page.
 * - `parent_id`: under that Page. A `project_id` given alongside must match
 *   the parent's Project (null for Your items).
 *
 * `position` is "first", "last" (default), {before: id} or {after: id}.
 *
 * Returns a refusal `{ ok: false, code, message }` with a code from
 * MOVE_REFUSALS, or `{ ok: true, revision, entries, moved, projection }`:
 * - `revision`: the next location revision.
 * - `entries`: every changed entry by page ID. That's the moved Page, plus
 *   destination siblings rekeyed to repair ties or rebalance long keys.
 *   Descendants never change: their Project follows their ancestors.
 * - `moved`: `{ page_id, parent_id, space_id, position, descendants }`.
 * - `projection`: derived `space_id` rows for the moved subtree, for D1.
 */
export function planMove(state, pageId, destination = {}, position = "last") {
  const map = asMap(state?.entries);
  const revision = state?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new TypeError("revision must be a non-negative integer");
  if (!destination || typeof destination !== "object")
    throw new TypeError("destination must be an object");
  const { project_id: projectId, parent_id: parentArgument } = destination;
  if (projectId !== undefined && projectId !== null && !isId(projectId))
    throw new TypeError("project_id must be a Project ID, null or omitted");
  if (parentArgument !== undefined && parentArgument !== null && !isId(parentArgument))
    throw new TypeError("parent_id must be a page ID, null or omitted");

  const entry = map.get(pageId);
  if (!entry) return refuse("page_not_found", "Page not found");
  if (entry.state === "trashed")
    return refuse("page_trashed", "Restore this Page from Trash before moving it");
  if ("space_id" in entry)
    return refuse("home_page_protected", "A Project's home Page stays a root; it can't be moved");
  if (projectId === undefined && !parentArgument)
    return refuse(
      "move_destination_required",
      "Name a destination: project_id (null for Your items), parent_id, or both",
    );
  if (!validPosition(position))
    return refuse(
      "invalid_position",
      'position is "first", "last", {"before": page_id} or {"after": page_id}',
    );
  if (typeof position === "object" && (position.before ?? position.after) === pageId)
    return refuse("invalid_position", "position names the Page being moved");

  let parentId = null;
  if (typeof projectId === "string") {
    const home = homeOf(map, projectId);
    if (!home || home.state !== "active") return refuse("project_not_found", "Project not found");
    parentId = home.page_id;
  }
  if (parentArgument) {
    const parent = map.get(parentArgument);
    if (!parent || parent.state !== "active")
      return refuse("parent_unavailable", "The parent Page is missing, pending or in Trash");
    if (projectId !== undefined) {
      const parentLocation = deriveLocation(map, parentArgument);
      if (!parentLocation.ok || parentLocation.space_id !== projectId)
        return refuse(
          "placement_mismatch",
          "parent_id is not in that Project. Omit project_id: a parent implies its Project.",
        );
    }
    parentId = parentArgument;
  }

  const subtree = subtreeOf(map, pageId);
  if (parentId !== null && subtree.some((member) => member.page_id === parentId))
    return refuse("placement_cycle", "A Page can't move under itself or one of its sub-pages");
  let rootDepth = 1;
  let spaceId = null;
  if (parentId !== null) {
    const parentLocation = deriveLocation(map, parentId);
    if (!parentLocation.ok)
      return refuse("parent_unavailable", "The parent Page's location can't be resolved");
    rootDepth = parentLocation.depth + 1;
    spaceId = parentLocation.space_id;
  }
  const height = Math.max(...subtree.map((member) => member.depth));
  if (rootDepth + height > MAX_DEPTH)
    return refuse(
      "nesting_depth_exceeded",
      `Pages nest at most ${MAX_DEPTH} levels deep, and this move would nest a sub-page deeper`,
    );

  const placed = positionAmong(siblingsOf(map, parentId, pageId), position);
  if (!placed.ok)
    return refuse(
      placed.code,
      placed.code === "position_sibling_unknown"
        ? "position names a Page that isn't a sibling at the destination"
        : "Invalid position",
    );

  const entries = { [pageId]: { ...entry, parent_id: parentId, position: placed.position } };
  // Rekeyed siblings (tie repair or a rebalance) change only their position.
  // Their parent and Project stay the same, so they add no D1 space_id rows:
  // `projection` covers the moved subtree alone.
  for (const [id, key] of Object.entries(placed.rekeyed))
    entries[id] = { ...map.get(id), position: key };
  return {
    ok: true,
    revision: revision + 1,
    entries,
    moved: {
      page_id: pageId,
      parent_id: parentId,
      space_id: spaceId,
      position: placed.position,
      descendants: subtree.length - 1,
    },
    projection: subtree.map(({ page_id }) => ({ page_id, space_id: spaceId })),
  };
}

/** `state` with a planned write applied. The Catalog does the same with one
 * multi-key put. */
export function applyWrite(state, write) {
  const entries = new Map(asMap(state.entries));
  for (const [id, entry] of Object.entries(write.entries)) entries.set(id, entry);
  return { revision: write.revision, entries };
}

/**
 * Every invariant violation in a Catalog's entries, as `{ code, page_id,
 * detail? }`. Empty when the location model holds:
 * - every entry has a valid shape (`invalid_entry`);
 * - an active or pending entry's parent is an active owned entry
 *   (`missing_parent`, `inactive_parent`). A trashed entry's parent is a
 *   restore hint and may be in any state or gone, so it isn't checked;
 * - no cycles (`placement_cycle`) and no entry deeper than MAX_TREE_DEPTH
 *   (`nesting_depth_exceeded`);
 * - siblings that aren't in Trash have distinct position keys
 *   (`duplicate_position`, reported for each sibling after the first). Roots
 *   with `space_id` are each alone, so only Your items roots are compared;
 * - at most one live home Page per Project (`duplicate_home`), and a home Page
 *   stays a root, which entryProblems checks.
 *
 * `projects`, when given, maps each of the Catalog's Project IDs to its
 * record's `home_page_id`. Each must match exactly one live home entry, and
 * no home entry may name an unknown Project (`project_home_mismatch`).
 */
export function checkInvariants(state, { projects } = {}) {
  const map = asMap(state?.entries);
  const violations = [];
  const add = (code, page_id, detail) =>
    violations.push(detail === undefined ? { code, page_id } : { code, page_id, detail });
  for (const [key, entry] of map) {
    const problems = entryProblems(entry, key);
    if (problems.length) add("invalid_entry", key, problems.join("; "));
  }
  if (violations.length) return violations;

  for (const entry of map.values()) {
    if (entry.parent_id !== null && entry.state !== "trashed") {
      const parent = map.get(entry.parent_id);
      if (!parent) add("missing_parent", entry.page_id, entry.parent_id);
      else if (parent.state !== "active") add("inactive_parent", entry.page_id, entry.parent_id);
    }
    const location = deriveLocation(map, entry.page_id);
    if (!location.ok && location.problem === "cycle") add("placement_cycle", entry.page_id);
    if (!location.ok && location.problem === "too_deep")
      add("nesting_depth_exceeded", entry.page_id);
  }

  const keysByParent = new Map();
  for (const entry of [...map.values()].sort(siblingOrder)) {
    if (entry.state === "trashed" || (entry.parent_id === null && "space_id" in entry)) continue;
    const keys = keysByParent.get(entry.parent_id) ?? new Set();
    keysByParent.set(entry.parent_id, keys);
    if (keys.has(entry.position)) add("duplicate_position", entry.page_id, entry.position);
    else keys.add(entry.position);
  }

  const homes = new Map();
  for (const entry of map.values()) {
    if (!("space_id" in entry) || entry.state === "trashed") continue;
    if (homes.has(entry.space_id)) add("duplicate_home", entry.page_id, entry.space_id);
    else homes.set(entry.space_id, entry.page_id);
  }
  if (projects) {
    const known = projects instanceof Map ? projects : new Map(Object.entries(projects));
    for (const [spaceId, homePageId] of known)
      if (homes.get(spaceId) !== homePageId) add("project_home_mismatch", homePageId, spaceId);
    for (const [spaceId, homePageId] of homes)
      if (!known.has(spaceId)) add("project_home_mismatch", homePageId, spaceId);
  }
  return violations;
}
