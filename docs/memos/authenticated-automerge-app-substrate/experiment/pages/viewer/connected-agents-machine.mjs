// The Connected agents dialog (ConnectedAgents.jsx): the account's agent
// connections, Disconnect for each, and Sign out everywhere.
//
//   browsing ──confirm──▶ confirming ──signOut──▶ signing_out ──signedOut──▶ done
//      ▲                     │                        │
//      └───────cancel────────┘                        │
//      └───────────────signOutFailed──────────────────┘   (error shown)
//
// The list loads on open and has its own status:
// `list` is `{ status: "loading" | "ready" | "failed", agents, message }`.
// While browsing, one agent at a time may be disconnecting (`revoking` is its
// id). A `revoked` or `revokeFailed` for another id is stale and changes
// nothing. A disconnect the host reports as already gone still leaves the
// list: either way the connection no longer works.
//
// `close` leaves from browsing or confirming, and not while a disconnect or
// the sign-out is in flight, so its answer stays on screen. `done` is final:
// the component runs `finish`, which leaves the signed-in app.
//
// Events:
//   { type: "loaded", agents }   { type: "loadFailed", message }
//   { type: "retry" }
//   { type: "revoke", id }       { type: "revoked", id }
//   { type: "revokeFailed", id, message }
//   { type: "confirm" }          { type: "cancel" }
//   { type: "signOut" }          { type: "signedOut" }
//   { type: "signOutFailed", message }
//   { type: "close" }
//
// Effects, run by the component after the transition, in order:
//   { type: "load" }             GET /api/auth/grants
//   { type: "revoke", id }       POST /api/auth/grants/<id>/revoke
//   { type: "signOut" }          POST /api/auth/logout-all
//   { type: "finish" }           forget account data and leave
//   { type: "dismiss" }          close the dialog

export const STATES = Object.freeze(["browsing", "confirming", "signing_out", "done"]);
export const EVENTS = Object.freeze([
  "loaded",
  "loadFailed",
  "retry",
  "revoke",
  "revoked",
  "revokeFailed",
  "confirm",
  "cancel",
  "signOut",
  "signedOut",
  "signOutFailed",
  "close",
]);

const failure = (message) => message || "Something went wrong. Try again.";

export const initialAgents = () => ({
  name: "browsing",
  list: { status: "loading", agents: [], message: "" },
  revoking: null,
  error: "",
});

/** The effects that start the dialog: the list loads. */
export const openingEffects = () => [{ type: "load" }];

/** Whether a write is in flight, so the dialog must stay open. */
export const agentsBusy = (state) => state.revoking !== null || state.name === "signing_out";

const stay = (state) => ({ state, effects: [] });

/** The next state and its effects. Pure: an event that changes nothing
 * returns the same state object and no effects. */
export function transition(state, event) {
  switch (event?.type) {
    case "loaded":
    case "loadFailed": {
      if (state.list.status !== "loading" || state.name === "done") return stay(state);
      const list =
        event.type === "loaded"
          ? { status: "ready", agents: [...(event.agents ?? [])], message: "" }
          : { status: "failed", agents: [], message: failure(event.message) };
      return { state: { ...state, list }, effects: [] };
    }
    case "retry":
      if (state.name !== "browsing" || state.list.status !== "failed") return stay(state);
      return {
        state: { ...state, list: { status: "loading", agents: [], message: "" } },
        effects: [{ type: "load" }],
      };
    case "revoke":
      if (
        state.name !== "browsing" ||
        state.revoking !== null ||
        state.list.status !== "ready" ||
        !state.list.agents.some((agent) => agent.id === event.id)
      )
        return stay(state);
      return {
        state: { ...state, revoking: event.id, error: "" },
        effects: [{ type: "revoke", id: event.id }],
      };
    case "revoked":
      if (state.revoking === null || state.revoking !== event.id) return stay(state);
      return {
        state: {
          ...state,
          revoking: null,
          list: {
            ...state.list,
            agents: state.list.agents.filter((agent) => agent.id !== event.id),
          },
        },
        effects: [],
      };
    case "revokeFailed":
      if (state.revoking === null || state.revoking !== event.id) return stay(state);
      return { state: { ...state, revoking: null, error: failure(event.message) }, effects: [] };
    case "confirm":
      if (state.name !== "browsing" || state.revoking !== null) return stay(state);
      return { state: { ...state, name: "confirming", error: "" }, effects: [] };
    case "cancel":
      if (state.name !== "confirming") return stay(state);
      return { state: { ...state, name: "browsing" }, effects: [] };
    case "signOut":
      if (state.name !== "confirming") return stay(state);
      return { state: { ...state, name: "signing_out" }, effects: [{ type: "signOut" }] };
    case "signedOut":
      if (state.name !== "signing_out") return stay(state);
      return { state: { ...state, name: "done" }, effects: [{ type: "finish" }] };
    case "signOutFailed":
      if (state.name !== "signing_out") return stay(state);
      return {
        state: { ...state, name: "browsing", error: failure(event.message) },
        effects: [],
      };
    case "close":
      if (agentsBusy(state) || !["browsing", "confirming"].includes(state.name)) return stay(state);
      return { state, effects: [{ type: "dismiss" }] };
    default:
      return stay(state);
  }
}
