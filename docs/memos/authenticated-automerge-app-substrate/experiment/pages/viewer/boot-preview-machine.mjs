/**
 * The boot preview of a Page as a state machine.
 *
 * On a Page route the head script asks the host for that Page's discovery and
 * read-only preview (early-session.mjs). The shell may show that preview
 * while the editor loads, for this page load only, and only to the account
 * that the host authenticated for the answer.
 *
 * States:
 * - idle: no preview was asked for. Boot on a route that is not a Page stays
 *   here until something retires it.
 * - pending: the preview of `pageId` was asked for. `principal` is the
 *   signed-in account once the session check answers; `answer` is the host's
 *   preview and the principal it authenticated, once it arrives. Both are
 *   needed before anything shows.
 * - shown: the shell may show `preview` while the route is still `pageId`
 *   and the signed-in account is still `principal`.
 * - retired: terminal for this page load. `reason` says why. Every later
 *   event is ignored, a late answer included.
 *
 * Events: `start` (boot on a Page route), `session` (the session check's
 * signed-in principal, or null when signed out), `resolved` (the host
 * answered with a preview), `refused` (the host refused, or answered without
 * a usable preview, or with the Page hidden in Trash, or opening it failed),
 * `navigated` (the route now names `pageId`, or null for no Page),
 * `installed` (the live Page session rendered) and `invalidated` (the head
 * script's request was dropped: the tab became visible or came back from the
 * back/forward cache, so its answer may predate a sign-in elsewhere).
 *
 * Effects: `release` drops the interpreter's hold on the early request and
 * the preview, once, on retirement.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const id = (value, label) =>
  check(typeof value === "string" && value !== "", `${label} must be a non-empty string`);
const principalOrNull = (value, label) =>
  check(
    value === null || (typeof value === "string" && value !== ""),
    `${label} must be a principal or null`,
  );
const previewData = (value) =>
  check(
    !!value &&
      typeof value === "object" &&
      typeof value.title === "string" &&
      Array.isArray(value.blocks),
    "preview must be { title, blocks }",
  );

export const RETIRE = Object.freeze([
  "signed-out",
  "principal-changed",
  "principal-mismatch",
  "refused",
  "navigated",
  "installed",
  "invalidated",
  "wrong-page",
]);

export const bootPreviewSpec = Object.freeze({
  name: "boot-preview",
  states: ["idle", "pending", "shown", "retired"],
  events: ["start", "session", "resolved", "refused", "navigated", "installed", "invalidated"],
  unreachable: [
    ["idle", "resolved", "The early answer is read only after start"],
    ["idle", "invalidated", "Only a started preview watches the early request"],
    ["shown", "resolved", "The early answer resolves once, and shown already holds it"],
  ],
  cases: {
    "pending/session": ["signed-out", "changed", "shows", "mismatch", "records", "unchanged"],
    "pending/resolved": ["wrong-page", "duplicate", "shows", "mismatch", "records"],
    "pending/navigated": ["same-page", "other-route"],
    "shown/session": ["unchanged", "signed-out", "changed"],
    "shown/navigated": ["same-page", "other-route"],
  },
  validate: {
    states: {
      idle: (state) => only(state, ["name"]),
      pending: (state) => {
        only(state, ["name", "pageId", "principal", "answer"]);
        id(state.pageId, "pageId");
        if ("principal" in state) id(state.principal, "principal");
        if ("answer" in state) {
          only(state.answer, ["principal", "preview"]);
          id(state.answer.principal, "answer.principal");
          previewData(state.answer.preview);
        }
      },
      shown: (state) => {
        only(state, ["name", "pageId", "principal", "preview"]);
        id(state.pageId, "pageId");
        id(state.principal, "principal");
        previewData(state.preview);
      },
      retired: (state) => {
        only(state, ["name", "reason"]);
        check(RETIRE.includes(state.reason), `unknown reason ${state.reason}`);
      },
    },
    events: {
      start: (event) => (only(event, ["type", "pageId"]), id(event.pageId, "pageId")),
      session: (event) => (
        only(event, ["type", "principal"]), principalOrNull(event.principal, "principal")
      ),
      resolved: (event) => {
        only(event, ["type", "pageId", "principal", "preview"]);
        id(event.pageId, "pageId");
        id(event.principal, "principal");
        previewData(event.preview);
      },
      refused: (event) => only(event, ["type"]),
      navigated: (event) => {
        only(event, ["type", "pageId"]);
        check(
          event.pageId === null || typeof event.pageId === "string",
          "pageId must be a string or null",
        );
      },
      installed: (event) => only(event, ["type"]),
      invalidated: (event) => only(event, ["type"]),
    },
    effects: { release: (effect) => only(effect, ["type"]) },
  },
});

export const REJECT = Object.freeze({
  retired: "The preview is retired for this page load",
  started: "The preview was already asked for",
  idle: "No preview was asked for",
  samePage: "The route still names the previewed Page",
  unchanged: "The signed-in account is unchanged",
  duplicate: "The early answer already arrived",
});

const retire = (reason) => ({ state: { name: "retired", reason }, effects: [{ type: "release" }] });
const show = (pageId, principal, preview) => ({
  state: { name: "shown", pageId, principal, preview },
  effects: [],
});

function transition(state, event) {
  if (state.name === "retired") return reject(state, REJECT.retired);
  if (event.type === "start")
    return state.name === "idle"
      ? { state: { name: "pending", pageId: event.pageId }, effects: [] }
      : reject(state, REJECT.started);
  if (state.name === "idle") {
    if (event.type === "session") return reject(state, REJECT.idle);
    // A route change, a failed open or a live Page before any preview: the
    // boot moment is gone, so none can start later in this load.
    if (event.type === "navigated") return retire("navigated");
    return retire(event.type === "installed" ? "installed" : "refused");
  }
  if (event.type === "refused") return retire("refused");
  if (event.type === "installed") return retire("installed");
  if (event.type === "invalidated") return retire("invalidated");
  if (event.type === "navigated")
    return event.pageId === state.pageId ? reject(state, REJECT.samePage) : retire("navigated");
  if (event.type === "session") {
    const known = state.principal;
    if (event.principal === null) return retire("signed-out");
    if (known !== undefined && known !== event.principal) return retire("principal-changed");
    if (state.name === "shown") return reject(state, REJECT.unchanged);
    if (state.answer)
      return state.answer.principal === event.principal
        ? show(state.pageId, event.principal, state.answer.preview)
        : retire("principal-mismatch");
    if (known === event.principal) return reject(state, REJECT.unchanged);
    return { state: { ...state, principal: event.principal }, effects: [] };
  }
  // resolved, while pending.
  if (event.pageId !== state.pageId) return retire("wrong-page");
  if (state.answer) return reject(state, REJECT.duplicate);
  if (state.principal !== undefined)
    return state.principal === event.principal
      ? show(state.pageId, event.principal, event.preview)
      : retire("principal-mismatch");
  return {
    state: { ...state, answer: { principal: event.principal, preview: event.preview } },
    effects: [],
  };
}

export const bootPreviewMachine = defineMachine({
  ...bootPreviewSpec,
  initial: { name: "idle" },
  transition,
});
