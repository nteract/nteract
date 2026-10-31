/**
 * The inline comment composer as a state machine.
 *
 * Choosing Comment on a selection opens a popover next to the passage. The
 * composer's draft text and captured anchor live beside this state in
 * CommentComposer (comment-composer.mjs); the machine owns only which surface
 * shows the draft and whether a send is in flight. Nothing reaches the shared
 * document until a send succeeds.
 *
 * States:
 * - idle: no composer.
 * - open: the popover shows the draft for `key`. `error` is the last send's
 *   failure, shown until the next send or retarget.
 * - dismissed: the popover closed with text still in it. The comments panel
 *   offers Continue and Discard, and the reload gate counts the draft.
 * - sending: the popover is disabled while `key`'s comment is written.
 *
 * Events:
 * - start: Comment was chosen. A new `key` retargets the draft to a new
 *   passage and keeps its text; the same `key` reopens a dismissed draft.
 * - dismiss: Escape or a pointer outside the popover. `empty` says whether the
 *   draft has text; `returnFocus` is true when focus should go back to the
 *   Page (Escape), false when the pointer already chose where it goes.
 * - cancel: the Cancel or Discard button. The draft is thrown away.
 * - submit: Comment or Mod+Enter with a non-empty draft.
 * - sent / failed: the send for `key` settled. A key that no longer matches
 *   belongs to a composer that was reset, so its result is ignored.
 * - reset: the Page closed or changed.
 *
 * Effects: `focusComposer` moves focus into the popover; `returnFocus` moves
 * it back to the Page editor; `send` writes `key`'s draft as a new thread;
 * `discardDraft` clears the stored text and anchor; `flash` briefly shows the
 * new thread's passage.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isKey = (value) => typeof value === "string" && value !== "";
const named = (keys = []) => (value) => only(value, ["name", ...keys]);
const keyed = (head) => (extra = []) => (value) => {
  only(value, [head, "key", ...extra]);
  check(isKey(value.key), "key is required");
};
const keyedState = keyed("name");
const keyedEvent = keyed("type");
const typed = (keys = []) => (value) => only(value, ["type", ...keys]);
const booleans = (keys) => (value) => {
  only(value, ["type", ...keys]);
  for (const key of keys) check(typeof value[key] === "boolean", `${key} must be a boolean`);
};

export const commentComposerSpec = Object.freeze({
  name: "comment-composer",
  states: ["idle", "open", "dismissed", "sending"],
  events: ["start", "dismiss", "cancel", "submit", "sent", "failed", "reset"],
  cases: {
    "open/start": ["retarget", "same"],
    "open/dismiss": ["keep", "empty"],
    "sending/sent": ["current", "stale"],
    "sending/failed": ["current", "stale"],
  },
  validate: {
    states: {
      idle: named(),
      open: (value) => {
        keyedState(["error"])(value);
        check(
          value.error === undefined || (typeof value.error === "string" && value.error !== ""),
          "error must be a message",
        );
      },
      dismissed: keyedState(),
      sending: keyedState(),
    },
    events: {
      start: keyedEvent(),
      dismiss: booleans(["empty", "returnFocus"]),
      cancel: typed(),
      submit: typed(),
      sent: (value) => {
        keyedEvent(["threadId"])(value);
        check(value.threadId === null || isKey(value.threadId), "threadId is a string or null");
      },
      failed: (value) => {
        keyedEvent(["message"])(value);
        check(typeof value.message === "string" && value.message !== "", "message is required");
      },
      reset: typed(),
    },
    effects: {
      focusComposer: typed(),
      returnFocus: typed(),
      send: (value) => {
        only(value, ["type", "key"]);
        check(isKey(value.key), "key is required");
      },
      discardDraft: typed(),
      flash: (value) => {
        only(value, ["type", "threadId"]);
        check(isKey(value.threadId), "threadId is required");
      },
    },
  },
});

export const REJECT = Object.freeze({
  noComposer: "No comment is being written",
  notOpen: "The composer is not open",
  sending: "A comment is being sent",
  notSending: "No comment is being sent",
  stale: "The result belongs to an earlier composer",
});

const focus = { type: "focusComposer" };
const back = { type: "returnFocus" };
const discard = { type: "discardDraft" };
const idle = { name: "idle" };

function transition(state, event) {
  switch (event.type) {
    case "start":
      if (state.name === "sending") return reject(state, REJECT.sending);
      return { state: { name: "open", key: event.key }, effects: [focus] };
    case "dismiss":
      if (state.name === "sending") return reject(state, REJECT.sending);
      if (state.name !== "open") return reject(state, REJECT.notOpen);
      return {
        state: event.empty ? idle : { name: "dismissed", key: state.key },
        effects: [...(event.empty ? [discard] : []), ...(event.returnFocus ? [back] : [])],
      };
    case "cancel":
      if (state.name === "sending") return reject(state, REJECT.sending);
      if (state.name === "idle") return reject(state, REJECT.noComposer);
      return { state: idle, effects: state.name === "open" ? [discard, back] : [discard] };
    case "submit":
      if (state.name === "sending") return reject(state, REJECT.sending);
      if (state.name !== "open") return reject(state, REJECT.notOpen);
      return {
        state: { name: "sending", key: state.key },
        effects: [{ type: "send", key: state.key }],
      };
    case "sent":
    case "failed":
      if (state.name !== "sending") return reject(state, REJECT.notSending);
      if (state.key !== event.key) return reject(state, REJECT.stale);
      if (event.type === "failed")
        return { state: { name: "open", key: state.key, error: event.message }, effects: [focus] };
      return {
        state: idle,
        effects: [
          discard,
          ...(event.threadId ? [{ type: "flash", threadId: event.threadId }] : []),
          back,
        ],
      };
    case "reset":
      if (state.name === "idle") return reject(state, REJECT.noComposer);
      return { state: idle, effects: [discard] };
  }
  throw new Error(`unknown event ${event.type}`);
}

export const commentComposerMachine = defineMachine({
  ...commentComposerSpec,
  initial: idle,
  transition,
});
