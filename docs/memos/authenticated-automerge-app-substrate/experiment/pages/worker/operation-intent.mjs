/**
 * Catalog operation intents as a state machine.
 *
 * The owner's Catalog journals each delete_page (Trash), restore_page and
 * purge_page confirmation under `host/operation/<key>` before it forwards the
 * request to the Page, the authority for the Page's lifecycle. While the
 * intent is pending, a Trash or restore request also holds a hidden
 * destination slot (`trash/<id>` or `page/<id>` with `reservation`) that counts
 * toward capacity. One machine covers both: the intent's state is the state
 * name, and its slot is the `slot` field.
 *
 * Intent states:
 * - absent: no journal row for this key.
 * - reserved: the row (and slot, when there was room) is written; the Page has
 *   not seen the request.
 * - forwarded: the row is marked forwarded before the Page sees the request,
 *   so it may have applied and its slot no longer expires.
 * - completed / superseded: the row holds a receipt. A superseded receipt
 *   reports the Page's state instead of applying a stale request.
 * - released: the row was deleted after the Page refused the request before
 *   changing anything. The next request with this key reads absent.
 *
 * Slot values: `none` (purge holds no slot), `live` (this intent's
 * reservation is stored), `lapsed` (this intent holds no reservation),
 * `entry` (the destination holds the Page's real entry, which needs no slot)
 * and `reconciling` (a reservation is being checked against the Page; `check`
 * says whether capacity counting or a placement check asked).
 *
 * Fences: every forward carries `expectedRevision`, the lifecycle revision the
 * request was reserved against, so the Page never applies it after a newer
 * transition. A projection never replaces an entry observed at a newer
 * lifecycle revision (`known`). Projections copy the Page's placement,
 * including the `placement_epoch` a restore to the top level advances.
 *
 * `retarget` and `replayOnly` live in memory for one Catalog request:
 * `retarget` says the Page has never seen this key, so a superseded first
 * answer may be retried once at the Page's current revision. `replayOnly`
 * says a resumed request lost its slot with no room to take another, so the
 * Page may only replay what it already did.
 *
 * Effects, which the Catalog runs in order: `persist` writes the intent row,
 * together with a new slot when `slot` is true, in one put; `reserve_slot`
 * writes the slot alone; `release_slot` removes this intent's slot;
 * `delete_intent` removes the row; `sync` is the durability barrier before a
 * reply; `forward` sends the request to the Page, whose answer is the next
 * `page_reply`; `read_lifecycle` asks the Page for its lifecycle state, the
 * next `lifecycle`; `project` copies a Page state into the Catalog's entries;
 * `forget_trash` and `notify_tombstone` clean up after a permanent deletion
 * recorded by an earlier build.
 *
 * Events carry what the Catalog read: `request` holds the facts gathered
 * before the step (capacity counts run this machine for every slot they
 * visit), `known` is the newest lifecycle revision among this Page's entries.
 */
import { defineAlphabet, defineMachine, reject } from "../shared/machine.mjs";

export const OPERATIONS = Object.freeze(["delete_page", "restore_page", "purge_page"]);
const SLOTS = new Set(["none", "live", "lapsed", "entry", "reconciling"]);
const DESTINATIONS = new Set(["room", "entry", "taken", "full", "none"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const optionalRevision = (value, field) =>
  check(value === undefined || isRevision(value), `${field} must be a lifecycle revision`);

function pending(state, extra) {
  only(state, ["name", "operation", "pageId", "expectedRevision", "slot", "check", ...extra]);
  check(OPERATIONS.includes(state.operation), "operation must be a lifecycle operation");
  check(typeof state.pageId === "string" && state.pageId !== "", "pageId is required");
  optionalRevision(state.expectedRevision, "expectedRevision");
  check(SLOTS.has(state.slot), "slot must be none, live, lapsed, entry or reconciling");
  check(
    (state.slot === "none") === (state.operation === "purge_page"),
    "only purge_page holds no slot",
  );
  check(
    (state.slot === "reconciling") === (state.check !== undefined),
    "check names why a reconciling slot is read, and only then",
  );
  check(typeof state.retarget === "boolean", "retarget must be a boolean");
}

function terminal(state) {
  only(state, ["name", "operation", "receipt"]);
  check(OPERATIONS.includes(state.operation), "operation must be a lifecycle operation");
  check(isObject(state.receipt), "receipt is required");
  check(
    (state.receipt.superseded === true) === (state.name === "superseded"),
    "only a superseded intent holds a superseded receipt",
  );
}

const noFields = (value) => only(value, ["type"]);

export const operationIntentSpec = Object.freeze({
  name: "operation-intent",
  states: ["absent", "reserved", "forwarded", "completed", "superseded", "released"],
  events: ["request", "tombstone", "page_reply", "count", "settle", "lifecycle"],
  unreachable: [
    ["absent", "page_reply", "nothing is forwarded before the intent is reserved"],
    ["absent", "lifecycle", "only a pending intent's reservation is read against its Page"],
    ["reserved", "page_reply", "an intent is marked forwarded before the Page sees it"],
    ["completed", "tombstone", "a completed intent replays its receipt before any other check"],
    ["completed", "page_reply", "a completed intent forwards nothing"],
    ["completed", "lifecycle", "a completed intent's stale slot is removed without a read"],
    ["superseded", "tombstone", "a superseded intent replays its receipt before any other check"],
    ["superseded", "page_reply", "a superseded intent forwards nothing"],
    ["superseded", "lifecycle", "a superseded intent's stale slot is removed without a read"],
    ["released", "request", "release deletes the row; the next request reads absent"],
    ["released", "tombstone", "release deletes the row; the next request reads absent"],
    ["released", "page_reply", "the release answered the Page's reply"],
    ["released", "count", "release removes the slot before the row"],
    ["released", "settle", "release removes the slot before the row"],
    ["released", "lifecycle", "release removes the slot before the row"],
  ],
  cases: {
    "absent/request": ["room", "entry", "taken", "full", "unslotted"],
    "reserved/request": ["held", "lost-room", "lost-full", "leaf-refused"],
    "reserved/count": ["unexpired", "expired"],
    "reserved/lifecycle": ["missing", "moved-here", "moved-away", "unchanged", "unavailable"],
    "forwarded/request": ["held", "lost-room", "lost-full", "leaf-refused"],
    "forwarded/page_reply": [
      "applied",
      "retarget",
      "superseded",
      "rejected",
      "missing",
      "failed",
      "unavailable",
    ],
    "forwarded/count": ["unexpired", "expired"],
    "forwarded/lifecycle": [
      "count-missing",
      "count-moved-here",
      "count-moved-away",
      "count-fenced",
      "count-unchanged",
      "count-unavailable",
      "settle-missing",
      "settle-moved-here",
      "settle-moved-away",
      "settle-unchanged",
      "settle-unavailable",
    ],
    "completed/request": ["receipt", "deleted"],
  },
  validate: {
    states: {
      absent: (state) => only(state, ["name"]),
      reserved(state) {
        pending(state, ["retarget"]);
        check(state.check !== "count", "capacity counting never reads a reserved slot");
        check(state.check === undefined || state.check === "settle", "check must be settle");
      },
      forwarded(state) {
        pending(state, ["retarget", "replayOnly"]);
        check(typeof state.replayOnly === "boolean", "replayOnly must be a boolean");
        check(
          state.check === undefined || ["count", "settle"].includes(state.check),
          "check must be count or settle",
        );
      },
      completed: terminal,
      superseded: terminal,
      released(state) {
        only(state, ["name", "operation"]);
        check(OPERATIONS.includes(state.operation), "operation must be a lifecycle operation");
      },
    },
    events: {
      request(event) {
        if ("operation" in event) {
          // A new request: what the Catalog found before reserving it.
          only(event, ["type", "operation", "pageId", "destination", "revision"]);
          check(OPERATIONS.includes(event.operation), "operation must be a lifecycle operation");
          check(typeof event.pageId === "string" && event.pageId !== "", "pageId is required");
          check(
            DESTINATIONS.has(event.destination),
            "destination is room, entry, taken, full or none",
          );
          check(
            (event.destination === "none") === (event.operation === "purge_page"),
            "only purge_page has no destination",
          );
          check(isRevision(event.revision), "revision must be a lifecycle revision");
          return;
        }
        // A pending intent continuing: its slot's expiry, then capacity and
        // the leaf guard, gathered only when the slot is not held. A
        // completed intent replays with no facts.
        only(event, ["type", "expired", "capacity", "leaf", "refusal"]);
        check(event.expired === undefined || typeof event.expired === "boolean", "expired");
        check(event.capacity === undefined || typeof event.capacity === "boolean", "capacity");
        check(event.leaf === undefined || ["ok", "refused"].includes(event.leaf), "leaf");
        check((event.leaf === "refused") === (event.refusal !== undefined), "refusal");
        if (event.refusal) {
          only(event.refusal, ["status", "body"]);
          check(Number.isSafeInteger(event.refusal.status), "refusal.status");
          check(isObject(event.refusal.body), "refusal.body");
        }
      },
      tombstone: noFields,
      page_reply(event) {
        if (event.unavailable !== undefined) {
          only(event, ["type", "unavailable"]);
          check(event.unavailable === true, "unavailable must be true");
          return;
        }
        only(event, ["type", "status", "receipt", "current", "known", "rejected"]);
        check(Number.isSafeInteger(event.status), "status must be an HTTP status");
        const ok = event.status >= 200 && event.status < 300;
        check(ok === isObject(event.receipt) && ok === isObject(event.current), "receipt/current");
        optionalRevision(event.known, "known");
        check(
          event.rejected === undefined ||
            (event.rejected === "before-change" && event.status >= 400 && event.status < 500),
          "rejected marks a 4xx refused before change",
        );
      },
      count(event) {
        only(event, ["type", "expired"]);
        check(typeof event.expired === "boolean", "expired must be a boolean");
      },
      settle: noFields,
      lifecycle(event) {
        if (event.unavailable !== undefined) {
          only(event, ["type", "unavailable"]);
          check(event.unavailable === true, "unavailable must be true");
          return;
        }
        only(event, ["type", "current", "known"]);
        check(isObject(event.current) && typeof event.current.state === "string", "current");
        optionalRevision(event.known, "known");
      },
    },
    effects: {
      persist(effect) {
        only(effect, ["type", "state", "expectedRevision", "slot", "receipt"]);
        check(
          ["reserved", "forwarded", "completed", "superseded"].includes(effect.state),
          "persist writes reserved, forwarded, completed or superseded",
        );
        optionalRevision(effect.expectedRevision, "expectedRevision");
        check(effect.slot === undefined || effect.slot === true, "slot is true when written");
        check(effect.slot === undefined || effect.state === "reserved", "only a reservation");
        check(
          ["completed", "superseded"].includes(effect.state) === isObject(effect.receipt),
          "a receipt completes the intent",
        );
      },
      reserve_slot: noFields,
      release_slot: noFields,
      delete_intent: noFields,
      sync: noFields,
      forward(effect) {
        only(effect, ["type", "expectedRevision", "replayOnly"]);
        optionalRevision(effect.expectedRevision, "expectedRevision");
        check(effect.replayOnly === undefined || effect.replayOnly === true, "replayOnly");
      },
      project(effect) {
        only(effect, ["type", "current"]);
        check(isObject(effect.current) && typeof effect.current.state === "string", "current");
      },
      forget_trash: noFields,
      notify_tombstone: noFields,
      read_lifecycle: noFields,
    },
  },
});

export const operationIntentAlphabet = defineAlphabet(operationIntentSpec);

/** Replies the Catalog gives without asking the Page. */
export const replies = Object.freeze({
  notFound: { status: 404, body: { error: "Page not found" } },
  trashFull: {
    status: 409,
    body: {
      error: "Trash is full. Permanently delete Pages from Trash before moving more Pages there.",
      code: "trash_capacity",
    },
  },
  pageQuota: { status: 409, body: { error: "This prototype permits 100 pages per account" } },
  unsettled: {
    status: 409,
    body: {
      error: "A Page's Trash or restore is still settling. Retry shortly.",
      code: "lifecycle_unsettled",
    },
  },
  unreachable: { status: 500, body: { error: "Pages request failed" } },
});
const fullReply = { delete_page: replies.trashFull, restore_page: replies.pageQuota };
/** The lifecycle state a request moves its Page to, which its slot stands for. */
const destinationState = { delete_page: "trashed", restore_page: "active" };
const DELETED = Object.freeze({ state: "deleted" });
const effect = (type) => ({ type });

/** Whether this intent holds capacity at its destination. A forwarded
 * reservation never expires on its own: its request may already have
 * applied, so only the Page's state settles it. */
export function holdsSlot(state, expired) {
  if (state.slot === "none" || state.slot === "entry") return true;
  return state.slot === "live" && (state.name === "forwarded" || expired === false);
}

/** Where projecting `current` leaves this intent's slot. A projection writes
 * the Page's entry under its state's prefix and removes the other, unless an
 * entry was already observed at a newer lifecycle revision. */
function projectedSlot(state, current, known) {
  const stored = state.slot === "reconciling" ? "live" : state.slot;
  if (stored === "none") return "none";
  if (current.state === "deleted") return "lapsed";
  if (known !== undefined && known > (current.revision ?? 0)) return stored;
  return current.state === destinationState[state.operation] ? "entry" : "lapsed";
}

function forward(state) {
  return {
    type: "forward",
    ...(state.expectedRevision !== undefined && { expectedRevision: state.expectedRevision }),
    ...(state.replayOnly && { replayOnly: true }),
  };
}

function pendingFields(state) {
  return {
    operation: state.operation,
    pageId: state.pageId,
    ...(state.expectedRevision !== undefined && { expectedRevision: state.expectedRevision }),
  };
}

/** A new request: refuse it when its destination is full, or reserve it. */
function reserve(state, event) {
  const { operation, pageId, destination, revision } = event;
  if (destination === "full") return reject(state, "full", { response: fullReply[operation] });
  const slot = { room: "live", entry: "entry", taken: "lapsed", none: "none" }[destination];
  return {
    state: {
      name: "reserved",
      operation,
      pageId,
      expectedRevision: revision,
      slot,
      retarget: true,
    },
    effects: [
      {
        type: "persist",
        state: "reserved",
        expectedRevision: revision,
        ...(destination === "room" && { slot: true }),
      },
    ],
  };
}

/** A pending request continues: hold a slot or replay only, mark it
 * forwarded, then forward it with its revision fence. */
function proceed(state, event) {
  if (state.slot === "reconciling") return reject(state, "reconciling");
  const effects = [];
  let slot = state.slot;
  let replayOnly = false;
  if (!holdsSlot(state, event.expired)) {
    if (typeof event.capacity !== "boolean")
      throw new Error("a request without its slot needs the capacity fact");
    if (event.capacity && event.leaf === "refused")
      return {
        state: { name: "released", operation: state.operation },
        effects: [effect("delete_intent"), effect("sync")],
        response: event.refusal,
      };
    if (event.capacity) {
      effects.push(effect("reserve_slot"));
      slot = "live";
    } else replayOnly = true;
  }
  if (state.name === "reserved") effects.push({ type: "persist", state: "forwarded" });
  const next = {
    name: "forwarded",
    ...pendingFields(state),
    slot,
    retarget: state.retarget && !replayOnly,
    replayOnly,
  };
  effects.push(forward(next));
  return { state: next, effects };
}

/** The Page answered a forwarded request. */
function answer(state, event) {
  if (state.slot === "reconciling") return reject(state, "reconciling");
  if (event.unavailable) return { state, effects: [], response: replies.unreachable };
  const passthrough = { source: "page", status: event.status };
  // Every 4xx with this mark was raised before the Page changed anything.
  if (event.rejected === "before-change")
    return {
      state: { name: "released", operation: state.operation },
      effects: [
        ...(state.slot === "live" ? [effect("release_slot")] : []),
        effect("delete_intent"),
        effect("sync"),
      ],
      response: passthrough,
    };
  const ok = event.status >= 200 && event.status < 300;
  if (!ok && event.status !== 404) return { state, effects: [], response: passthrough };
  // A missing Page is already permanently absent: that is the outcome.
  const { receipt, current } = ok
    ? event
    : { receipt: { page_id: state.pageId, deleted: true }, current: DELETED };
  const effects = [{ type: "project", current }];
  const slot = projectedSlot(state, current, event.known);
  if (receipt.superseded && state.retarget && !state.replayOnly) {
    // The Page has never seen this key, so retry it once at the Page's
    // current revision.
    const next = { ...state, expectedRevision: current.revision, slot, retarget: false };
    effects.push({ type: "persist", state: "forwarded", expectedRevision: current.revision });
    effects.push(forward(next));
    return { state: next, effects };
  }
  const name = receipt.superseded ? "superseded" : "completed";
  effects.push({ type: "persist", state: name, receipt }, effect("sync"));
  return {
    state: { name, operation: state.operation, receipt },
    effects,
    response: { status: 200, body: receipt },
  };
}

/** Capacity counting visits this intent's slot. */
function count(state, event) {
  if (state.slot !== "live") return reject(state, "no reservation");
  if (!event.expired) return { state, effects: [], response: { counted: true } };
  if (state.name === "reserved")
    return {
      state: { ...state, slot: "lapsed" },
      effects: [effect("release_slot")],
      response: { counted: false },
    };
  return {
    state: { ...state, slot: "reconciling", check: "count" },
    effects: [effect("read_lifecycle")],
  };
}

/** The Page's lifecycle state settles a reservation being read. Capacity
 * counting releases a slot the Page never moved past; a placement check keeps
 * it, since the request may still apply. */
function reconcile(state, event) {
  if (state.slot !== "reconciling") return reject(state, "not reading");
  const { check: reader, ...rest } = state;
  const counting = reader === "count";
  const live = { ...rest, slot: "live" };
  if (event.unavailable)
    return { state: live, effects: [], response: counting ? { counted: true } : replies.unsettled };
  const missing = event.current.state === "missing";
  if (!missing && (event.current.revision ?? 0) === state.expectedRevision)
    return counting
      ? {
          state: { ...rest, slot: "lapsed" },
          effects: [effect("release_slot")],
          response: { counted: false },
        }
      : { state: live, effects: [] };
  const current = missing ? DELETED : event.current;
  const slot = projectedSlot(state, current, event.known);
  return {
    state: { ...rest, slot },
    effects: [{ type: "project", current }],
    ...(counting && { response: { counted: slot === "entry" } }),
  };
}

function transition(state, event) {
  const terminal = state.name === "completed" || state.name === "superseded";
  // A slot whose intent row is gone or finished is stale.
  if ((terminal || state.name === "absent") && ["count", "settle"].includes(event.type))
    return {
      state,
      effects: [effect("release_slot")],
      ...(event.type === "count" && { response: { counted: false } }),
    };
  if (terminal)
    // Only terminal deletion is projected again: another outcome may have
    // been superseded since.
    return {
      state,
      effects: [
        ...(state.receipt.deleted ? [{ type: "project", current: DELETED }] : []),
        effect("sync"),
      ],
      response: { status: 200, body: state.receipt },
    };
  if (event.type === "tombstone") {
    // The Catalog drops the Page's Trash entry, which is where a Trash
    // request keeps its slot.
    const loses = state.operation === "delete_page" && ["live", "entry"].includes(state.slot);
    const effects = [effect("forget_trash"), effect("notify_tombstone")];
    if (state.name === "absent") return { state, effects, response: replies.notFound };
    return { state: loses ? { ...state, slot: "lapsed" } : state, effects };
  }
  if (state.name === "absent") return reserve(state, event);
  switch (event.type) {
    case "request":
      return proceed(state, event);
    case "page_reply":
      return answer(state, event);
    case "count":
      return count(state, event);
    case "settle":
      return state.slot === "live"
        ? {
            state: { ...state, slot: "reconciling", check: "settle" },
            effects: [effect("read_lifecycle")],
          }
        : reject(state, "no reservation");
    default:
      return reconcile(state, event);
  }
}

export const operationIntent = defineMachine({ ...operationIntentSpec, transition });
