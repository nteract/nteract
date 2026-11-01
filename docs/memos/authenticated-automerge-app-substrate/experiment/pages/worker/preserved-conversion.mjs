import { defineMachine, reject } from "../shared/machine.mjs";

/**
 * The Page host's preserved-block conversion, and the write fence it holds.
 *
 * A Page that holds preserved Markdown blocks (`pages-opaque`) takes no peer
 * writes until the host has converted them (model/raw-migration.mjs). A peer
 * edit that lands first can be a competing conversion, which Automerge keeps
 * beside the host's, or it can move the heads the conversion journaled. So
 * `held`, `converting` and `failed` are fenced: the host refuses native
 * connections to an active Page, refuses native puts, and refuses HTTP edits
 * after one more attempt to convert.
 *
 * The work is done when no preserved block remains and no journaled
 * conversion is unfinished. An unfinished one (applied, but its flush or
 * receipt failed) replays under its original key until its journal entry is
 * terminal, so the fence never clears over a stranded reservation.
 *
 * States:
 * - unchecked: the host hasn't observed a document yet. The host observes
 *   wherever a document appears, before a peer can write: at the end of
 *   loadDocument (inside `ready`), when a creation imports its bytes, and
 *   on a connection or HTTP edit that finds nothing observed.
 * - clear: no work. Open.
 * - held: work the host may not do now: the Page isn't active (in Trash), its
 *   recovery is blocked, or it carries a schema feature this build doesn't
 *   know. Fenced. Restore observes again after it installs the active record.
 * - converting { mode, attempt }: a journaled run. Fenced. `mode` is `native`
 *   (each source as Markdown) or `literal` (each source as plain text), the
 *   fallback when a native run fails for a reason that won't pass.
 * - failed { mode, attempt }: the last run failed transiently (storage, a
 *   pending edit), or failed after its journal entry was reserved. Fenced; a
 *   retry is scheduled (5 s doubling to 5 minutes), and every refused
 *   connection or edit observes again. A reserved run retries its exact
 *   intent indefinitely, whatever the failure: it is never reauthored,
 *   abandoned or unfenced, because its change may already be in the serving
 *   document. Every STUCK_LOG_EVERY failures it is logged for an operator.
 * - stuck { reason }: a run with nothing reserved failed for good in both
 *   modes. Open: with no host conversion coming, and none reserved, a peer's
 *   edit can't compete with one, so the Page edits normally and its
 *   preserved blocks stay read-only. The next load tries again.
 *   DEPLOYMENT.md describes the recovery.
 *
 * Events:
 * - observe { preserved, unfinished, eligible }: what the host sees now.
 *   `preserved`: the document holds a preserved block. `unfinished`: a
 *   journaled conversion hasn't finished. `eligible`: the host may convert.
 * - succeeded; failed { permanent, unfinished, reason }: the run's outcome.
 *   `unfinished`: its journal entry is still reserved after the failure.
 *
 * Effects:
 * - convert { mode }: run the journaled conversion; report its outcome.
 * - observe: observe the document again.
 * - scheduleRetry { attempt }: observe again after a backoff.
 * - logStuck { reason }: record that the Page is stuck, fenced or not.
 */
/** A reserved run that keeps failing is logged every this many attempts. */
export const STUCK_LOG_EVERY = 5;
export const PRESERVED_CONVERSION_STATES = Object.freeze([
  "unchecked",
  "clear",
  "held",
  "converting",
  "failed",
  "stuck",
]);
const MODES = ["native", "literal"];

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const run = (state) => {
  only(state, ["name", "mode", "attempt"]);
  check(MODES.includes(state.mode), "mode is native or literal");
  check(Number.isSafeInteger(state.attempt) && state.attempt > 0, "attempt counts runs");
};
const reason = (value) =>
  check(typeof value.reason === "string" && value.reason.length <= 200, "reason is a short string");

export const preservedConversionMachine = defineMachine({
  name: "preserved-conversion",
  states: [...PRESERVED_CONVERSION_STATES],
  events: ["observe", "succeeded", "failed"],
  initial: { name: "unchecked" },
  unreachable: ["unchecked", "clear", "held", "failed", "stuck"].flatMap((state) =>
    ["succeeded", "failed"].map((event) => [
      state,
      event,
      "only a running conversion reports an outcome",
    ]),
  ),
  validate: {
    states: {
      unchecked: (state) => only(state, ["name"]),
      clear: (state) => only(state, ["name"]),
      held: (state) => only(state, ["name"]),
      converting: run,
      failed: run,
      stuck: (state) => {
        only(state, ["name", "reason"]);
        reason(state);
      },
    },
    events: {
      observe: (event) => {
        only(event, ["type", "preserved", "unfinished", "eligible"]);
        for (const key of ["preserved", "unfinished", "eligible"])
          check(typeof event[key] === "boolean", `${key} is a boolean`);
      },
      succeeded: (event) => only(event, ["type"]),
      failed: (event) => {
        only(event, ["type", "permanent", "unfinished", "reason"]);
        check(typeof event.permanent === "boolean", "permanent is a boolean");
        check(typeof event.unfinished === "boolean", "unfinished is a boolean");
        reason(event);
      },
    },
    effects: {
      convert: (effect) => {
        only(effect, ["type", "mode"]);
        check(MODES.includes(effect.mode), "mode is native or literal");
      },
      observe: (effect) => only(effect, ["type"]),
      scheduleRetry: (effect) => {
        only(effect, ["type", "attempt"]);
        check(Number.isSafeInteger(effect.attempt) && effect.attempt > 0, "attempt counts runs");
      },
      logStuck: (effect) => {
        only(effect, ["type", "reason"]);
        reason(effect);
      },
    },
  },
  transition(state, event) {
    switch (event.type) {
      case "observe": {
        // The run observes again when it settles.
        if (state.name === "converting") return reject(state, "a conversion is running");
        const work = event.preserved || event.unfinished;
        if (!work) return { state: { name: "clear" }, effects: [] };
        // Stuck waits for the next load; an unfinished entry can't exist here
        // (a stuck run never reserved).
        if (state.name === "stuck") return reject(state, "stuck until the next load");
        if (!event.eligible) return { state: { name: "held" }, effects: [] };
        const mode = state.name === "failed" ? state.mode : "native";
        const attempt = state.name === "failed" ? state.attempt + 1 : 1;
        return {
          state: { name: "converting", mode, attempt },
          effects: [{ type: "convert", mode }],
        };
      }
      case "succeeded":
        return { state: { name: "unchecked" }, effects: [{ type: "observe" }] };
      case "failed":
        // A reserved run keeps the fence and retries its exact intent, with
        // a log line for an operator every STUCK_LOG_EVERY failures.
        if (event.unfinished)
          return {
            state: { name: "failed", mode: state.mode, attempt: state.attempt },
            effects: [
              ...(state.attempt % STUCK_LOG_EVERY === 0
                ? [{ type: "logStuck", reason: event.reason }]
                : []),
              { type: "scheduleRetry", attempt: state.attempt },
            ],
          };
        if (!event.permanent)
          return {
            state: { name: "failed", mode: state.mode, attempt: state.attempt },
            effects: [{ type: "scheduleRetry", attempt: state.attempt }],
          };
        if (state.mode === "native")
          return {
            state: { name: "converting", mode: "literal", attempt: 1 },
            effects: [{ type: "convert", mode: "literal" }],
          };
        return {
          state: { name: "stuck", reason: event.reason },
          effects: [{ type: "logStuck", reason: event.reason }],
        };
    }
  },
});

/** Whether the host refuses peer writes in `state`. */
export const conversionFenced = (state) => ["held", "converting", "failed"].includes(state.name);

/** The retry delay after `attempt` failed runs: 5 s doubling to 5 minutes. */
export const conversionRetryDelay = (attempt) => Math.min(5_000 * 2 ** (attempt - 1), 300_000);

/** Whether a failed run will fail the same way again: the document or the
 * change is too large, the conversion itself threw, or a request-shaped
 * refusal. Storage errors, pending edits (429) and moved heads (409) pass. */
export function permanentFailure(error, { isHistoryCapacityError = () => false } = {}) {
  if (error?.conversion || isHistoryCapacityError(error)) return true;
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && ![409, 429].includes(status);
}

/** The refusal while the fence is up. */
export function conversionFenceError() {
  return Object.assign(
    Error(
      "This Page is converting Markdown saved by an older version of Pages. It's read-only until that finishes; try again shortly.",
    ),
    { status: 503, code: "preserved_markdown_converting" },
  );
}
