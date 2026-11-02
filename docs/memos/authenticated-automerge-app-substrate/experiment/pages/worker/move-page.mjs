/**
 * move_page as a state machine over one queued Catalog request.
 *
 * A move changes where an owned Page sits in the owner's Catalog: its
 * `parent_id` and `position`, and so the Project its subtree derives from its
 * root. Nothing else records location, so the whole move is one Catalog
 * write. No Page is called and no Page's heads change. The request runs in the
 * Catalog's serial queue, after the location-shape pass every queued write
 * runs first (location-shape.mjs), and persists no intermediate state: the
 * journal row that holds its receipt goes into the same put as the moved
 * entry, so a retry either replays the receipt or plans again from what is
 * stored.
 *
 * States:
 * - received: input is sound and the Catalog is in the current shape. The
 *   journal is read next.
 * - settling: the Page's and the parent's unsettled Trash or restore
 *   reservations are reconciled with their Pages (a bounded pass), so the
 *   plan sees a parent that is really leaving for Trash as unavailable.
 * - planning: the location entries are read and `planMove`
 *   (model/location.mjs) decides.
 * - writing: the receipt is in storage, its durability not yet confirmed. A
 *   new request put the moved entry, the rekeyed siblings, the location
 *   revision, the completed journal row and the index's dirty mark here in
 *   one transaction; a replay found the row already there. The barrier
 *   decides.
 * - replied: the receipt went back with 200.
 * - refused: the request ended with an error code and status. A refused
 *   request writes nothing, except the `synced` failure, whose put may or
 *   may not be durable; its retry replays or re-plans.
 *
 * Events carry what the interpreter read: `inspected` the journal's answer,
 * `settled` whether the reservations settled within budget, `planned` the
 * plan's receipt or its refusal, `synced` whether the barrier held.
 *
 * Effects, which the interpreter runs in order: `settle` the reservations,
 * `plan` the move, `write` the plan it holds, `sync` the barrier. Each
 * effect's answer is the next event; `write` has none of its own, since a
 * failed put throws like any storage failure.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** The HTTP status for each code a move can end with. */
export const MOVE_STATUS = Object.freeze({
  page_not_found: 404,
  not_page_owner: 403,
  home_page_protected: 409,
  page_trashed: 409,
  parent_unavailable: 409,
  placement_cycle: 409,
  placement_mismatch: 400,
  project_not_found: 404,
  nesting_depth_exceeded: 400,
  move_destination_required: 400,
  invalid_position: 400,
  position_sibling_unknown: 400,
  lifecycle_unsettled: 409,
  idempotency_conflict: 409,
  operation_pending: 409,
  move_unconfirmed: 503,
});

/** Where the Catalog keeps its location revision, the fence every location
 * write bumps. Absent means 0. */
export const LOCATION_REVISION_KEY = "host/location/revision";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const receiptShape = (receipt) => {
  check(isObject(receipt), "receipt must be an object");
  check(typeof receipt.page_id === "string", "receipt names its page_id");
  check(typeof receipt.parent_id === "string", "receipt names its parent_id");
  check(typeof receipt.position === "string", "receipt carries the position");
  check(
    Number.isSafeInteger(receipt.location_revision) && receipt.location_revision >= 0,
    "receipt carries the location revision",
  );
};
const noFields = (value) => only(value, ["type"]);

const ROWS = ["absent", "completed", "pending", "conflict"];

export const movePageSpec = Object.freeze({
  name: "move-page",
  states: ["received", "settling", "planning", "writing", "replied", "refused"],
  events: ["inspected", "settled", "planned", "synced"],
  unreachable: [
    ["received", "settled", "nothing settles before the journal is read"],
    ["received", "planned", "nothing is planned before the journal is read"],
    ["received", "synced", "nothing is written before the journal is read"],
    ["settling", "inspected", "the journal is read once"],
    ["settling", "planned", "the plan runs after the reservations settle"],
    ["settling", "synced", "nothing is written before the plan"],
    ["planning", "inspected", "the journal is read once"],
    ["planning", "settled", "the reservations settle once, before the plan"],
    ["planning", "synced", "nothing is written before the plan answers"],
    ["writing", "inspected", "the journal is read once"],
    ["writing", "settled", "the reservations settle once, before the plan"],
    ["writing", "planned", "the plan ran once; its write is in storage"],
    ["replied", "inspected", "the request was answered"],
    ["replied", "settled", "the request was answered"],
    ["replied", "planned", "the request was answered"],
    ["replied", "synced", "the request was answered"],
    ["refused", "inspected", "the request was answered"],
    ["refused", "settled", "the request was answered"],
    ["refused", "planned", "the request was answered"],
    ["refused", "synced", "the request was answered"],
  ],
  cases: {
    "received/inspected": ROWS,
    "settling/settled": ["settled", "unsettled"],
    "planning/planned": ["planned", "refused"],
    "writing/synced": ["durable", "failed"],
  },
  validate: {
    states: {
      received: (state) => only(state, ["name"]),
      settling: (state) => only(state, ["name"]),
      planning: (state) => only(state, ["name"]),
      writing: (state) => {
        only(state, ["name", "receipt"]);
        receiptShape(state.receipt);
      },
      replied: (state) => {
        only(state, ["name", "receipt"]);
        receiptShape(state.receipt);
      },
      refused: (state) => {
        only(state, ["name", "code"]);
        check(Object.hasOwn(MOVE_STATUS, state.code), "code must be a move refusal");
      },
    },
    events: {
      inspected: (event) => {
        only(event, ["type", "row", "receipt"]);
        check(ROWS.includes(event.row), "row must be absent, completed, pending or conflict");
        check(
          (event.row === "completed") === (event.receipt !== undefined),
          "only a completed row carries its receipt",
        );
        if (event.receipt !== undefined) receiptShape(event.receipt);
      },
      settled: (event) => {
        only(event, ["type", "ok"]);
        check(typeof event.ok === "boolean", "ok says whether the reservations settled");
      },
      planned: (event) => {
        only(event, ["type", "ok", "receipt", "code", "message"]);
        check(typeof event.ok === "boolean", "ok says whether the plan succeeded");
        if (event.ok) {
          check(event.code === undefined && event.message === undefined, "a plan has no code");
          receiptShape(event.receipt);
        } else {
          check(event.receipt === undefined, "a refusal has no receipt");
          check(Object.hasOwn(MOVE_STATUS, event.code), "code must be a move refusal");
          check(typeof event.message === "string" && event.message !== "", "message is required");
        }
      },
      synced: (event) => {
        only(event, ["type", "ok"]);
        check(typeof event.ok === "boolean", "ok says whether the barrier held");
      },
    },
    effects: {
      settle: noFields,
      plan: noFields,
      write: noFields,
      sync: noFields,
    },
  },
});

const effect = (type) => ({ type });
const refuse = (code, error, extra = {}) => ({
  state: { name: "refused", code },
  effects: [],
  response: { status: MOVE_STATUS[code], body: { error, code, ...extra } },
});

export const MOVE_MESSAGES = Object.freeze({
  lifecycle_unsettled:
    "A Trash or restore of this Page or its new parent is still settling; retry the same request shortly",
  idempotency_conflict: "idempotency_key was used for a different request",
  operation_pending: "An earlier request with this idempotency_key is still being applied",
  move_unconfirmed:
    "The move was written but its durability could not be confirmed; retry the same key, token and payload",
});

function transition(state, event) {
  switch (state.name) {
    case "received": {
      if (event.row === "absent")
        return { state: { name: "settling" }, effects: [effect("settle")] };
      if (event.row === "completed")
        // The receipt is already in storage; a previous attempt may have
        // stored it before its barrier failed, so the barrier runs again.
        return { state: { name: "writing", receipt: event.receipt }, effects: [effect("sync")] };
      if (event.row === "pending")
        return refuse("operation_pending", MOVE_MESSAGES.operation_pending);
      return refuse("idempotency_conflict", MOVE_MESSAGES.idempotency_conflict);
    }
    case "settling":
      return event.ok
        ? { state: { name: "planning" }, effects: [effect("plan")] }
        : refuse("lifecycle_unsettled", MOVE_MESSAGES.lifecycle_unsettled);
    case "planning":
      return event.ok
        ? {
            state: { name: "writing", receipt: event.receipt },
            effects: [effect("write"), effect("sync")],
          }
        : refuse(event.code, event.message);
    case "writing":
      return event.ok
        ? {
            state: { name: "replied", receipt: state.receipt },
            effects: [],
            response: { status: 200, body: state.receipt },
          }
        : refuse("move_unconfirmed", MOVE_MESSAGES.move_unconfirmed, { retryable: true });
    default:
      return reject(state, "the request was answered");
  }
}

export const movePage = defineMachine({ ...movePageSpec, transition });
