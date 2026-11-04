// Recovery from a refused tool call: the machine over every state and event,
// and the interpreter with the real ProjectList, whose reset a second 401
// triggers mid-recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { runTable } from "../shared/machine-test.mjs";
import {
  RECOVERY_RERUNS,
  REJECT,
  SignedOutRecovery,
  recoveryMachine,
  recoverySpec,
} from "./signed-out-recovery.mjs";
import { ProjectList } from "./project-list.mjs";

const idle = { name: "idle" };
const recovering = (rearm = false, reruns = 0) => ({ name: "recovering", rearm, reruns });
const refused = { type: "refused" };
const other = { type: "other" };
const settled = { type: "settled" };

const ROWS = [
  {
    label: "a refusal forgets and starts a check",
    state: idle,
    event: refused,
    expect: { state: recovering(), effects: [{ type: "forget" }, { type: "check" }] },
  },
  {
    label: "a check settling with nothing pending is late news",
    state: idle,
    event: settled,
    expect: { state: idle, effects: [], rejected: REJECT.idle },
  },
  {
    label: "a refusal during a check forgets and rearms, starting no second check",
    state: recovering(),
    event: refused,
    expect: { state: recovering(true), effects: [{ type: "forget" }] },
  },
  {
    label: "another account's answer starts a check and forgets nothing",
    state: idle,
    event: other,
    expect: { state: recovering(), effects: [{ type: "check" }] },
  },
  {
    label: "another account's answer during a check rearms it",
    state: recovering(false, 1),
    event: other,
    expect: { state: recovering(true, 1), effects: [] },
  },
  {
    label: "a check with nothing since is done",
    case: "done",
    state: recovering(),
    event: settled,
    expect: { state: idle, effects: [{ type: "done" }] },
  },
  {
    label: "a rearmed check runs once more",
    case: "rerun",
    state: recovering(true, 0),
    event: settled,
    expect: { state: recovering(false, 1), effects: [{ type: "check" }] },
  },
  {
    label: "after the cap, a rearmed check stops",
    case: "spent",
    state: recovering(true, RECOVERY_RERUNS),
    event: settled,
    expect: { state: idle, effects: [{ type: "done" }] },
  },
];

test("the recovery table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(recoveryMachine, ROWS), {
    rows: ROWS.length,
    pairs: recoverySpec.states.length * recoverySpec.events.length,
    unreachable: 0,
    cases: 3,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** The shell's wiring around the real ProjectList: `forget` resets it, and a
 * check asks for Alice's Projects afresh once the session check answers. */
function shell() {
  const calls = [];
  const sessions = [];
  let n = 0;
  const projects = new ProjectList({
    call: () => {
      const reply = deferred();
      calls.push(reply);
      return reply.promise;
    },
    newKey: () => `k${++n}`,
  });
  let forgets = 0;
  let dones = 0;
  let inFlight = 0;
  let mostInFlight = 0;
  const recovery = new SignedOutRecovery({
    forget: () => {
      forgets++;
      projects.reset();
    },
    check: async () => {
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      try {
        const session = deferred();
        sessions.push(session);
        await session.promise;
        await projects.request("alice", { fresh: true });
      } finally {
        inFlight--;
      }
    },
    done: () => dones++,
  });
  return {
    recovery,
    calls,
    sessions,
    shown: () => projects.store.snapshot(),
    forgets: () => forgets,
    dones: () => dones,
    mostInFlight: () => mostInFlight,
  };
}

const ALICES = { projects: [{ project_id: "launch" }], next_cursor: null, principal: "alice" };

test("a 401 during recovery still ends with the account's Projects shown", async () => {
  const { recovery, calls, sessions, shown, forgets, dones } = shell();
  recovery.refused();
  sessions[0].resolve();
  await settle();
  assert.equal(calls.length, 1, "recovery asked for the Projects");
  // Another 401 lands while that request is in flight: it resets the list,
  // so the answer below belongs to a request the list no longer waits for.
  recovery.refused();
  assert.equal(forgets(), 2);
  calls[0].resolve(ALICES);
  await settle();
  assert.equal(shown().ready, false, "the reset dropped it");
  assert.equal(dones(), 0, "a rerun is still to come");
  // The rearmed recovery runs once more and asks again.
  assert.equal(sessions.length, 2);
  sessions[1].resolve();
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve(ALICES);
  await settle();
  assert.deepEqual(shown(), { principal: "alice", projects: ALICES.projects, ready: true });
  assert.equal(recovery.state.name, "idle");
  assert.equal(dones(), 1, "done once, after the last check");
});

test("one check at a time, and a server that keeps refusing stops after the cap", async () => {
  const { recovery, calls, sessions, mostInFlight } = shell();
  // Every list_projects is refused, and each refusal reaches recovery.
  recovery.refused();
  recovery.refused();
  recovery.refused();
  assert.equal(sessions.length, 1, "refusals during a check start no other");
  for (let round = 0; round < 10; round++) {
    const session = sessions.at(-1);
    session.resolve();
    await settle();
    const call = calls.at(-1);
    if (call && !call.answered) {
      call.answered = true;
      recovery.refused();
      call.reject(Object.assign(Error("Sign in required"), { status: 401 }));
    }
    await settle();
  }
  assert.equal(mostInFlight(), 1);
  assert.equal(sessions.length, 1 + RECOVERY_RERUNS, "bounded by the cap");
  assert.equal(calls.length, 1 + RECOVERY_RERUNS);
  assert.equal(recovery.state.name, "idle");
  // A later refusal starts a new recovery.
  recovery.refused();
  assert.equal(sessions.length, 2 + RECOVERY_RERUNS);
});

test("a stopped recovery runs nothing more", async () => {
  const { recovery, sessions, forgets, dones } = shell();
  recovery.refused();
  recovery.stop();
  recovery.refused();
  sessions[0].resolve();
  await settle();
  assert.equal(forgets(), 1);
  assert.equal(sessions.length, 1);
  assert.equal(dones(), 0);
});

test("answers for another account recheck the session through the same bounded recovery", async () => {
  const { recovery, calls, sessions, forgets, mostInFlight } = shell();
  recovery.otherAccount();
  recovery.otherAccount();
  assert.equal(sessions.length, 1, "one check at a time");
  assert.equal(forgets(), 0, "nothing was remembered for the other account");
  // The session check says Alice, but every list_projects answers for Bob,
  // and each answer reaches recovery again.
  for (let round = 0; round < 10; round++) {
    sessions.at(-1).resolve();
    await settle();
    const call = calls.at(-1);
    if (call && !call.answered) {
      call.answered = true;
      recovery.otherAccount();
      call.resolve({ projects: [], next_cursor: null, principal: "bob" });
    }
    await settle();
  }
  assert.equal(mostInFlight(), 1);
  assert.equal(sessions.length, 1 + RECOVERY_RERUNS, "bounded by the cap");
  assert.equal(recovery.state.name, "idle");
  assert.equal(forgets(), 0);
});
