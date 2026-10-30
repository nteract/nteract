import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPACE_CREATION_EVENTS,
  SPACE_CREATION_STATES,
  spaceCreationEffect,
  spaceCreationTransition,
} from "./space-lifecycle.mjs";

test("Space creation: every state and event has exactly one outcome", () => {
  const expected = {
    reserved: { space_recorded: ["space_recorded", "create_home_page"] },
    space_recorded: { home_created: ["home_created", "commit_catalog"] },
    home_created: { committed: ["ready", null] },
    ready: {},
  };
  for (const state of SPACE_CREATION_STATES)
    for (const event of SPACE_CREATION_EVENTS) {
      const outcome = expected[state][event];
      if (outcome)
        assert.deepEqual(spaceCreationTransition(state, event), {
          state: outcome[0],
          effect: outcome[1],
        });
      else assert.throws(() => spaceCreationTransition(state, event), /cannot take/);
    }
  assert.deepEqual(SPACE_CREATION_STATES.map(spaceCreationEffect), [
    "create_space_record",
    "create_home_page",
    "commit_catalog",
    null,
  ]);
  assert.throws(() => spaceCreationEffect("creating"), /Unknown/);
});

test("Space creation resumes from any persisted state to ready", () => {
  for (const start of SPACE_CREATION_STATES) {
    let state = start;
    const effects = [];
    const events = {
      create_space_record: "space_recorded",
      create_home_page: "home_created",
      commit_catalog: "committed",
    };
    for (let effect = spaceCreationEffect(state); effect; ) {
      effects.push(effect);
      ({ state, effect } = spaceCreationTransition(state, events[effect]));
    }
    assert.equal(state, "ready");
    assert.deepEqual(
      effects,
      ["create_space_record", "create_home_page", "commit_catalog"].slice(
        SPACE_CREATION_STATES.indexOf(start),
      ),
    );
  }
});
