// A small reconnect machine for the machine, table and store tests. It is a
// test fixture, not the viewer's connection logic.

import { defineMachine, reject } from "../shared/machine.mjs";

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 10_000;

export const backoffDelay = (attempt) => Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);

export const reconnect = defineMachine({
  name: "example-reconnect",
  states: ["idle", "connecting", "open", "backoff"],
  events: ["connect", "opened", "closed", "timer"],
  initial: { name: "idle", generation: 0, attempt: 0 },
  unreachable: [
    ["idle", "opened", "no socket exists before the first connect"],
    ["idle", "closed", "no socket exists before the first connect"],
    ["idle", "timer", "no timer exists before the first connect"],
    ["connecting", "timer", "leaving backoff cancels or consumes its timer"],
    ["open", "timer", "leaving backoff cancels or consumes its timer"],
  ],
  transition(state, event) {
    // Socket events carry the generation that dialed them, so a late event from
    // an older socket can't move a newer connection.
    if (
      (event.type === "opened" || event.type === "closed") &&
      event.generation !== state.generation
    )
      return reject(state, "stale generation");
    const dial = (...before) => {
      const generation = state.generation + 1;
      return {
        state: { name: "connecting", generation, attempt: state.attempt },
        effects: [...before, { type: "dial", generation }],
      };
    };
    const backoff = () => {
      const attempt = state.attempt + 1;
      return {
        state: { name: "backoff", generation: state.generation, attempt },
        effects: [{ type: "schedule", delayMs: backoffDelay(attempt) }],
      };
    };
    switch (state.name) {
      case "idle":
        return dial();
      case "connecting":
        if (event.type === "connect") return reject(state, "already connecting");
        if (event.type === "opened")
          return { state: { name: "open", generation: state.generation, attempt: 0 }, effects: [] };
        return backoff();
      case "open":
        if (event.type === "closed") return backoff();
        return reject(state, "already open");
      case "backoff":
        if (event.type === "connect") return dial({ type: "cancelTimer" });
        if (event.type === "timer") return dial();
        return reject(state, "socket already closed");
    }
  },
});
