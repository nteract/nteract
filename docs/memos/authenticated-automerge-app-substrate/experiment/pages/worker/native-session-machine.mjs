import { defineMachine, reject } from "../shared/machine.mjs";

/**
 * One signing key's native session slot on a Page host.
 *
 * A browser tab holds its signing key exclusively (a Web Lock per seed, see
 * viewer/session.mjs exclusiveIdentity), so a second admitted connection for
 * a key held by the same principal and driver is that tab again: a reload, or
 * a reconnect after its old socket died without the host seeing the close.
 * Behind Cloudflare's tunnel that close can take minutes to arrive. The new
 * connection takes the slot and the host closes the one it replaced, so the
 * tab never waits on a session nobody is using.
 *
 * States:
 * - free: no admitted connection holds the key.
 * - held: the admitted connection `session` holds it, for `principal` and
 *   `driver` (null when the credential names none).
 *
 * Events:
 * - admit: a connection for the key finished admission.
 * - end: connection `session` ended. Its socket closed, or the host ended it
 *   (access changed, a failed lease check, a refused comment, shutdown).
 *
 * Effects:
 * - install: `session` now holds the key.
 * - replace: close connection `session`; a newer one holds its key.
 * - remove: no connection holds the key.
 *
 * `end` for a session that no longer holds the key is a late cleanup from a
 * replaced or already-ended connection. It must not free the replacement.
 * An `admit` for another principal or driver can't follow a persisted binding
 * check (policy.mjs bind refuses it first); the guard keeps the slot anyway.
 */
export const REJECT = Object.freeze({
  mismatch: "native_binding_mismatch",
  empty: "No connection holds this key",
  replaced: "Another connection holds this key",
});

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sessionId = (value) =>
  check(Number.isSafeInteger(value) && value > 0, "session must be a positive integer");
const holder = (value) => {
  check(typeof value.principal === "string" && value.principal !== "", "principal is required");
  check(value.driver === null || typeof value.driver === "string", "driver is a string or null");
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};

export const nativeSessionMachine = defineMachine({
  name: "native-session",
  states: ["free", "held"],
  events: ["admit", "end"],
  initial: { name: "free" },
  cases: {
    "held/admit": ["same-holder", "other-holder"],
    "held/end": ["this-session", "replaced-session"],
  },
  validate: {
    states: {
      free: (state) => only(state, ["name"]),
      held(state) {
        only(state, ["name", "session", "principal", "driver"]);
        sessionId(state.session);
        holder(state);
      },
    },
    events: {
      admit(event) {
        only(event, ["type", "session", "principal", "driver"]);
        sessionId(event.session);
        holder(event);
      },
      end(event) {
        only(event, ["type", "session"]);
        sessionId(event.session);
      },
    },
    effects: {
      install: (effect) => sessionId(effect.session),
      replace: (effect) => sessionId(effect.session),
      remove: (effect) => sessionId(effect.session),
    },
  },
  transition(state, event) {
    switch (event.type) {
      case "admit": {
        const next = {
          name: "held",
          session: event.session,
          principal: event.principal,
          driver: event.driver,
        };
        const install = { type: "install", session: event.session };
        if (state.name === "free") return { state: next, effects: [install] };
        if (state.principal !== event.principal || state.driver !== event.driver)
          return reject(state, REJECT.mismatch);
        return {
          state: next,
          effects: [install, { type: "replace", session: state.session }],
        };
      }
      case "end":
        if (state.name === "free") return reject(state, REJECT.empty);
        if (state.session !== event.session) return reject(state, REJECT.replaced);
        return { state: { name: "free" }, effects: [{ type: "remove", session: state.session }] };
    }
  },
});
