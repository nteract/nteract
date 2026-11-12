// A Page whose host refuses its document format (format-gate.mjs) opens no
// document here, so its screen is the refusal and, for the Page's owner, a
// way to move it to Trash. The host decides who that is: the screen asks it
// with the access read (/api/access, a record route the format refusal
// doesn't cover) and offers only what that answer allows.
//
//   checking ─answered─▶ owner ─trash─▶ trashing ─succeeded─▶ trashed
//   trashing ─failed─▶ failed ─trash─▶ trashing        (same nonce)
//   trashing ─refused─▶ checking ─answered─▶ …         (nonce spent)
//
// `checking` also goes to `inTrash` or `reader` on the host's answer, and to
// `reader` when there is none.
//
// A move's outcome is one of three (trashOutcome):
// - succeeded: the Page is in Trash.
// - failed: the answer was lost, so the move may have landed. A retry sends
//   the same nonce, which the host replays instead of moving twice.
// - refused: the host answered that nothing applied (superseded, or a
//   definite refusal). The host keeps that answer for the nonce and replays
//   it, so the nonce is spent. The Page may have changed (in Trash already,
//   or no longer this account's), so the screen asks the host again, and the
//   next move gets a new nonce.
//
// States:
// - checking: the access read is in flight. No action yet. Carries the
//   `message` of a refused move when it asks again.
// - reader: the host said this account can't trash the Page, or couldn't
//   say. The refusal alone.
// - owner: the host said this account may trash it. Offers Move to Trash.
// - inTrash: the Page is already in this account's Trash. Offers Trash.
// - trashing: delete_page is in flight with `nonce`.
// - failed: delete_page's answer was lost (`message`). Offers Move to Trash
//   again with the same `nonce`.
// - trashed: the Page is in Trash; the driver leaves the screen.
// `reader`, `owner` and `inTrash` keep a refused move's `message`.
//
// Events:
// - answered `{ access }`: the access read's `access` object.
// - unanswered: the access read failed.
// - trash `{ nonce }`: the person chose Move to Trash. `nonce` is a new
//   one, used only when the state holds none.
// - succeeded: delete_page moved the Page to Trash.
// - failed `{ message }`: delete_page's answer was lost.
// - refused `{ message }`: delete_page was settled as not applied.
//
// Effects, run by the driver after the transition:
// - `{ type: "check" }`: read access again, answering answered/unanswered.
// - `{ type: "trash", nonce }`: delete_page with trashArguments.
// - `{ type: "leave" }`: leave for the library.

import { failureMessage } from "./alerts.mjs";
import { FORMAT_UNSUPPORTED_CODE } from "./format-gate.mjs";

export const STATES = Object.freeze([
  "checking",
  "reader",
  "owner",
  "inTrash",
  "trashing",
  "failed",
  "trashed",
]);
export const EVENTS = Object.freeze([
  "answered",
  "unanswered",
  "trash",
  "succeeded",
  "failed",
  "refused",
]);
export const UNOPENED_INITIAL = Object.freeze({ name: "checking" });

const stay = (state) => ({ state, effects: [] });
/** `{ name }`, with the refused move's `message` a re-check carries. */
const carried = (state, name) => ({
  name,
  ...(state.message !== undefined && { message: state.message }),
});

/** The next state and its effects. Pure: an event that changes nothing
 * returns the same state object and no effects. */
export function unopenedPageStep(state, event) {
  if (!STATES.includes(state?.name)) throw Error(`Unknown unopened Page state ${state?.name}`);
  switch (event?.type) {
    case "answered": {
      if (state.name !== "checking") return stay(state);
      const access = event.access ?? {};
      const name =
        access.trashed && access.canRestore
          ? "inTrash"
          : !access.trashed && access.canDelete
            ? "owner"
            : "reader";
      return { state: carried(state, name), effects: [] };
    }
    case "unanswered":
      return state.name === "checking"
        ? { state: carried(state, "reader"), effects: [] }
        : stay(state);
    case "trash": {
      if (state.name !== "owner" && state.name !== "failed") return stay(state);
      const nonce = state.nonce ?? event.nonce;
      return { state: { name: "trashing", nonce }, effects: [{ type: "trash", nonce }] };
    }
    case "succeeded":
      if (state.name !== "trashing") return stay(state);
      return { state: { name: "trashed" }, effects: [{ type: "leave" }] };
    case "failed":
      if (state.name !== "trashing") return stay(state);
      return {
        state: { name: "failed", nonce: state.nonce, message: event.message },
        effects: [],
      };
    case "refused":
      if (state.name !== "trashing") return stay(state);
      return {
        state: { name: "checking", message: event.message },
        effects: [{ type: "check" }],
      };
  }
  throw Error(`Unknown unopened Page event ${event?.type}`);
}

/** The action a state offers: "trash" (Move to Trash), "trashView" (open
 * Trash), or null. Only a host answer that this account owns the Page
 * reaches a state that offers one. */
export function unopenedAction(state) {
  if (state.name === "owner" || state.name === "failed" || state.name === "trashing")
    return "trash";
  if (state.name === "inTrash") return "trashView";
  return null;
}

// A move the host may still apply: lifecycle_unsettled is the Catalog
// holding this nonce's request open while its Trash settles.
const STILL_SETTLING = "lifecycle_unsettled";
const NOT_APPLIED = "This Page changed before it could move to Trash.";

/** The event for delete_page's outcome: `error` when tool() rejected, else
 * its `result`. tool() (request.mjs) rejects in two ways:
 * - with no answer, or none the host stands behind: a transport failure
 *   (NETWORK_ERROR), the request deadline (REQUEST_TIMEOUT), a response that
 *   isn't the host's JSON (INVALID_RESPONSE, such as a proxy's page), a 5xx
 *   or a `retryable` error. The move may have landed: `failed`.
 * - with the host's own JSON 4xx, a definite refusal that changed nothing,
 *   except lifecycle_unsettled, which may still apply: `refused`.
 * A 2xx marked superseded or not applied is settled too: `refused`. */
export function trashOutcome(error, result) {
  if (error === undefined)
    return result?.superseded || result?.applied === false
      ? { type: "refused", message: NOT_APPLIED }
      : { type: "succeeded" };
  const message = failureMessage(error);
  const settled =
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== STILL_SETTLING &&
    error.code !== "INVALID_RESPONSE" &&
    !error.retryable;
  return { type: settled ? "refused" : "failed", message };
}

/** Whether `error` is the host refusing a Page's document format: discovery's
 * 409, or the socket's admission stop (signingKeyRefused). */
export function formatRefused(error) {
  return (
    error?.code === FORMAT_UNSUPPORTED_CODE || error?.admission?.code === FORMAT_UNSUPPORTED_CODE
  );
}

/** Whether a session's host stopped it for the Page's document format. */
export const sessionFormatStopped = (session) => session?.formatGate?.name === "stopped";

/** delete_page's arguments from the browser. `heads` are the Page heads this
 * tab shows; the host refuses the move if a peer's edit landed first
 * (BROWSER_TRASH_GUARD). A Page whose documents the host doesn't open has
 * none to match, and the host refuses a move that sends them, so `heads` is
 * undefined there and the argument is left out. */
export function trashArguments({ pageId, principal, nonce, heads }) {
  return {
    page_id: pageId,
    expected_principal: principal,
    ...(heads !== undefined && { base_heads: heads }),
    nonce,
  };
}
