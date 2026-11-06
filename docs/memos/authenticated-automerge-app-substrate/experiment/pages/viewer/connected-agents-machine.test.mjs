import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENTS,
  STATES,
  agentsBusy,
  initialAgents,
  openingEffects,
  transition,
} from "./connected-agents-machine.mjs";
import { agentAccess } from "./ConnectedAgents.jsx";

const kilo = { id: "a".repeat(43), name: "Kilo" };
const chatgpt = { id: "b".repeat(43), name: "ChatGPT" };

function run(state, ...events) {
  const effects = [];
  for (const event of events) {
    const result = transition(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
const ready = () => run(initialAgents(), { type: "loaded", agents: [kilo, chatgpt] }).state;

// One representative state per phase, for the exhaustive sweep below.
const samples = () => {
  const browsing = ready();
  return {
    loading: initialAgents(),
    failed: run(initialAgents(), { type: "loadFailed", message: "Offline" }).state,
    browsing,
    revoking: run(browsing, { type: "revoke", id: kilo.id }).state,
    confirming: run(browsing, { type: "confirm" }).state,
    signing_out: run(browsing, { type: "confirm" }, { type: "signOut" }).state,
    done: run(browsing, { type: "confirm" }, { type: "signOut" }, { type: "signedOut" }).state,
  };
};
const eventFor = (type) =>
  ({
    loaded: { type, agents: [kilo] },
    loadFailed: { type, message: "Offline" },
    revoke: { type, id: kilo.id },
    revoked: { type, id: kilo.id },
    revokeFailed: { type, id: kilo.id, message: "Nope" },
    signOutFailed: { type, message: "Nope" },
  })[type] ?? { type };

test("opening loads the list, and its answer settles it once", () => {
  assert.deepEqual(openingEffects(initialAgents()), [{ type: "load" }]);
  const state = ready();
  assert.deepEqual(state.list, { status: "ready", agents: [kilo, chatgpt], message: "" });
  assert.equal(transition(state, { type: "loaded", agents: [] }).state, state);
  const failed = run(initialAgents(), { type: "loadFailed" });
  assert.equal(failed.state.list.status, "failed");
  assert.match(failed.state.list.message, /Try again/);
  const retried = transition(failed.state, { type: "retry" });
  assert.equal(retried.state.list.status, "loading");
  assert.deepEqual(retried.effects, [{ type: "load" }]);
});

test("one disconnect at a time, and a stale answer changes nothing", () => {
  const { state, effects } = run(ready(), { type: "revoke", id: kilo.id });
  assert.deepEqual(effects, [{ type: "revoke", id: kilo.id }]);
  assert.equal(agentsBusy(state), true);
  assert.equal(transition(state, { type: "revoke", id: chatgpt.id }).state, state);
  assert.equal(transition(state, { type: "revoked", id: chatgpt.id }).state, state);
  assert.equal(transition(state, { type: "close" }).effects.length, 0);
  assert.equal(transition(state, { type: "confirm" }).state, state);
  const done = transition(state, { type: "revoked", id: kilo.id }).state;
  assert.deepEqual(done.list.agents, [chatgpt]);
  assert.equal(done.revoking, null);
  const failed = transition(state, { type: "revokeFailed", id: kilo.id, message: "Nope" }).state;
  assert.deepEqual(failed.list.agents, [kilo, chatgpt]);
  assert.equal(failed.error, "Nope");
  // An id the list doesn't hold is never sent.
  assert.equal(transition(ready(), { type: "revoke", id: "c".repeat(43) }).effects.length, 0);
});

test("sign out everywhere asks first, can be cancelled, and stays open while it runs", () => {
  const confirming = run(ready(), { type: "confirm" });
  assert.equal(confirming.state.name, "confirming");
  assert.deepEqual(confirming.effects, []);
  assert.equal(transition(confirming.state, { type: "cancel" }).state.name, "browsing");
  const signing = transition(confirming.state, { type: "signOut" });
  assert.deepEqual(signing.effects, [{ type: "signOut" }]);
  assert.equal(agentsBusy(signing.state), true);
  assert.equal(transition(signing.state, { type: "close" }).effects.length, 0);
  assert.deepEqual(transition(signing.state, { type: "signedOut" }).effects, [{ type: "finish" }]);
  const failed = transition(signing.state, { type: "signOutFailed", message: "Offline" }).state;
  assert.deepEqual(
    { name: failed.name, error: failed.error },
    { name: "browsing", error: "Offline" },
  );
});

test("every state answers every event without throwing, and done is final", () => {
  for (const [name, state] of Object.entries(samples())) {
    assert.ok(STATES.includes(state.name), name);
    for (const type of [...EVENTS, "unknown"]) {
      const result = transition(state, eventFor(type));
      assert.ok(STATES.includes(result.state.name), `${name} + ${type}`);
      if (name === "done") assert.equal(result.state, state, `${name} + ${type}`);
    }
  }
  assert.deepEqual(transition(ready(), { type: "close" }).effects, [{ type: "dismiss" }]);
});

test("access reads from the connection's scope", () => {
  assert.equal(agentAccess("pages:read"), "Read only");
  assert.equal(agentAccess("offline_access pages:read pages:write"), "Read and edit");
  assert.equal(agentAccess("pages:read pages:share pages:write"), "Read and edit, share");
});
