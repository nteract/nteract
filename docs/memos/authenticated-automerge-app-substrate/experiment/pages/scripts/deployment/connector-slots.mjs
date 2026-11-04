// Two connector units, slots `a` and `b`, serve one tunnel. Changing routes
// starts the idle slot with the new config, waits until it holds an edge
// connection, then stops the live one. Cloudflare balances across every
// connector of a tunnel, so the edge always has an origin.
//
// `legacy` is the single connector unit releases before slots installed. It
// can be live, never next: the first handoff moves it to slot `a`.
//
// The state file records which unit is live and which step is in flight. Every
// state except `absent` and `serving` owes one effect. A retry runs that effect
// again, so a crash at any point resumes instead of replaying a reported step.

export const SLOTS = Object.freeze(["a", "b"]);
const LIVE = new Set(["legacy", ...SLOTS]);
const sha256 = /^[a-f0-9]{64}$/;

export const otherSlot = (live) => (live === "a" ? "b" : "a");

// Pure. `config` is the sha256 of the tunnel config the live unit started with;
// `nextConfig` is the one the next unit starts with.
export function connectorTransition(state, event) {
  const key = state.phase + ":" + event.type;
  if (event.type === "swap" && !sha256.test(event.config ?? ""))
    throw new Error("Connector swap needs the config digest it serves");
  switch (key) {
    case "absent:swap":
      return { phase: "starting", live: "none", config: null, next: "a", nextConfig: event.config };
    case "serving:swap":
      return {
        phase: "starting",
        live: state.live,
        config: state.config,
        next: otherSlot(state.live),
        nextConfig: event.config,
      };
    case "starting:ready":
      return state.live === "none"
        ? { phase: "serving", live: state.next, config: state.nextConfig }
        : { phase: "stopping", live: state.next, config: state.nextConfig, previous: state.live };
    case "starting:failed":
      return { phase: "reverting", live: state.live, config: state.config, next: state.next };
    case "stopping:stopped":
      return { phase: "serving", live: state.live, config: state.config };
    case "reverting:stopped":
      return state.live === "none"
        ? { phase: "absent" }
        : { phase: "serving", live: state.live, config: state.config };
    default:
      throw new Error("Connector cannot handle " + event.type + " while " + state.phase);
  }
}

// The effect a state owes, or null when nothing is in flight.
export function connectorEffect(state) {
  if (state.phase === "starting") return { kind: "start", unit: state.next };
  if (state.phase === "stopping") return { kind: "stop", unit: state.previous };
  if (state.phase === "reverting") return { kind: "stop", unit: state.next };
  return null;
}

const shapes = {
  absent: [],
  serving: ["live", "config"],
  starting: ["live", "config", "next", "nextConfig"],
  stopping: ["live", "config", "previous"],
  reverting: ["live", "config", "next"],
};
export function parseConnectorState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    state = null;
  }
  const keys = shapes[state?.phase];
  const valid =
    keys !== undefined &&
    state.schema === 1 &&
    Object.keys(state).length === keys.length + 2 &&
    keys.every((key) => Object.hasOwn(state, key)) &&
    (() => {
      const { phase, live, config, next, nextConfig, previous } = state;
      const none = live === "none" && config === null;
      const running = LIVE.has(live) && sha256.test(config ?? "");
      if (phase === "absent") return true;
      if (phase === "serving") return running;
      if (phase === "stopping")
        return SLOTS.includes(live) && running && LIVE.has(previous) && previous !== live;
      const nextOk = SLOTS.includes(next) && next !== live && (none ? next === "a" : true);
      if (phase === "starting") return (none || running) && nextOk && sha256.test(nextConfig ?? "");
      return (none || running) && nextOk;
    })();
  if (!valid) throw new Error("Invalid tunnel connector state; inspect before retrying");
  const { schema: _schema, ...rest } = state;
  return rest;
}
export const serializeConnectorState = (state) => JSON.stringify({ schema: 1, ...state }) + "\n";

// Runs owed effects until the state is steady. `start(unit)` brings the unit up
// and returns once it serves, or throws. `stop(unit)` throws if the unit is
// still up; the persisted state then still owes the stop. A start failure is
// returned after the revert, not thrown, so the caller can restore its files.
export function settleConnector(state, { persist, start, stop }) {
  let failure = null;
  for (let effect = connectorEffect(state); effect; effect = connectorEffect(state)) {
    let event;
    if (effect.kind === "start") {
      try {
        start(effect.unit);
        event = { type: "ready" };
      } catch (error) {
        failure ??= error;
        event = { type: "failed" };
      }
    } else {
      stop(effect.unit);
      event = { type: "stopped" };
    }
    state = connectorTransition(state, event);
    persist(state);
  }
  return { state, failure };
}
