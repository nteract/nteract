// The New Project and Move to… dialogs (ProjectCreator.jsx, MoveDialog.jsx).
//
// Both are one write behind a small form, so they share a lifecycle:
//
//   editing ──submit──▶ submitting ──succeeded──▶ done
//      ▲                    │
//      └──────failed────────┘   (back to editing, with the error shown)
//
// `close` leaves from editing only: a write in flight can't be taken back, so
// the dialog stays until it answers. `done` is final; the component runs the
// `finish` effect (navigate, refresh) and unmounts.
//
// A failed write keeps its `attempt` ({ retry_token, idempotency_key }) so
// Submit again with the same form replays the same request: a create or move
// whose answer was lost lands once. Any edit drops the attempt, since a new
// payload needs a new key.
//
// The Move dialog also loads the possible parents of the chosen destination.
// `parents` is `{ status: "loading" | "ready" | "failed", target, rows }`.
// A `parentsLoaded` or `parentsFailed` for a destination no longer chosen is
// stale and changes nothing.
//
// State: `{ name, form, attempt, error, parents?, result? }`
//   form (create)  { title, description }
//   form (move)    { target, parent_id } where target is a Project ID, or
//                  null for Your items, and parent_id is null for the top level
//
// Events:
//   { type: "edit", form }            fields changed (merged into form)
//   { type: "submit" }                Create / Move pressed
//   { type: "succeeded", result }     the write answered
//   { type: "failed", message, attempt }
//   { type: "close" }                 Cancel, Escape, the backdrop
//   { type: "parentsLoaded", target, rows }
//   { type: "parentsFailed", target, message }
//
// Effects, run by the component after the transition, in order:
//   { type: "write", form, attempt }  run the write, replaying `attempt` if set
//   { type: "loadParents", target }   list the destination's Pages
//   { type: "finish", result }        the write landed: navigate or refresh
//   { type: "dismiss" }               close the dialog

export const STATES = Object.freeze(["editing", "submitting", "done"]);
export const EVENTS = Object.freeze([
  "edit",
  "submit",
  "succeeded",
  "failed",
  "close",
  "parentsLoaded",
  "parentsFailed",
]);

const same = (left, right) =>
  Object.keys({ ...left, ...right }).every((key) => left[key] === right[key]);

/** Whether a form can be submitted. */
export function formReady(kind, form) {
  if (kind === "create") return typeof form.title === "string" && form.title.trim() !== "";
  if (kind === "move") return form.target !== undefined;
  return false;
}

/** The New Project dialog's first state. */
export const initialCreate = () => ({
  kind: "create",
  name: "editing",
  form: { title: "", description: "" },
  attempt: null,
  error: "",
});

/** The Move dialog's first state, opened on the Page's current container:
 * `target` is its Project ID or null for Your items. Its parents load first. */
export function initialMove(target = null) {
  return {
    kind: "move",
    name: "editing",
    form: { target, parent_id: null },
    attempt: null,
    error: "",
    parents: { status: "loading", target, rows: [] },
  };
}

/** The effects that start a dialog: the Move dialog loads its first parents. */
export const openingEffects = (state) =>
  state.kind === "move" ? [{ type: "loadParents", target: state.form.target }] : [];

const stay = (state) => ({ state, effects: [] });

/** The next state and its effects. Pure: an event that changes nothing
 * returns the same state object and no effects. */
export function transition(state, event) {
  switch (event?.type) {
    case "edit": {
      if (state.name !== "editing") return stay(state);
      const form = { ...state.form, ...event.form };
      if (same(form, state.form)) return stay(state);
      const effects = [];
      let { parents } = state;
      if (state.kind === "move" && form.target !== state.form.target) {
        // A new destination: its parents load, and the old parent choice
        // can't apply there.
        form.parent_id = event.form.parent_id ?? null;
        parents = { status: "loading", target: form.target, rows: [] };
        effects.push({ type: "loadParents", target: form.target });
      }
      return { state: { ...state, form, parents, attempt: null, error: "" }, effects };
    }
    case "submit":
      if (state.name !== "editing" || !formReady(state.kind, state.form)) return stay(state);
      return {
        state: { ...state, name: "submitting", error: "" },
        effects: [{ type: "write", form: state.form, attempt: state.attempt }],
      };
    case "succeeded":
      if (state.name !== "submitting") return stay(state);
      return {
        state: { ...state, name: "done", result: event.result },
        effects: [{ type: "finish", result: event.result }],
      };
    case "failed":
      if (state.name !== "submitting") return stay(state);
      return {
        state: {
          ...state,
          name: "editing",
          error: event.message || "Something went wrong. Try again.",
          attempt: event.attempt ?? null,
        },
        effects: [],
      };
    case "close":
      if (state.name !== "editing") return stay(state);
      return { state, effects: [{ type: "dismiss" }] };
    case "parentsLoaded":
    case "parentsFailed": {
      if (state.kind !== "move" || state.parents.status !== "loading") return stay(state);
      if (event.target !== state.parents.target) return stay(state);
      const parents =
        event.type === "parentsLoaded"
          ? { status: "ready", target: event.target, rows: event.rows }
          : { status: "failed", target: event.target, rows: [], message: event.message };
      return { state: { ...state, parents }, effects: [] };
    }
    default:
      return stay(state);
  }
}
