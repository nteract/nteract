import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  SPACE_CREATION_EVENTS,
  SPACE_CREATION_STATES,
  spaceCreationEffect,
  spaceCreationTransition,
  spaceDeletion,
} from "./space-lifecycle.mjs";

const DELETION_TABLE = new URL("../test/fixtures/machines/space-deletion.json", import.meta.url);

test("Space deletion: every phase and answer has one outcome", async () => {
  await runTable(spaceDeletion, loadTable(DELETION_TABLE));
});

test("Space deletion resumes from any persisted phase and records its receipt last", () => {
  const answers = {
    close_space: { type: "closed", ok: true },
    trash_content: { type: "trashed", outcome: "trashed" },
    purge_content: { type: "purged" },
    forget_catalog: { type: "forgotten" },
    remove_space: { type: "removed" },
  };
  // Each phase runs the answer at the same index first.
  const phases = [
    "reserved",
    "space_closed",
    "content_trashed",
    "content_deleted",
    "catalog_forgotten",
  ];
  for (const start of phases) {
    let state = { name: start };
    let event = { type: "resume" };
    const ran = [];
    for (;;) {
      const result = spaceDeletion.step(state, event);
      const types = result.effects.map((effect) => effect.type);
      ran.push(...types.filter((type) => Object.hasOwn(answers, type)));
      if (result.response) {
        assert.deepEqual(result.response, { reply: "receipt" });
        assert.equal(result.state.name, "deleted");
        assert.deepEqual(types, ["persist", "sync"], "the receipt is the last write");
        break;
      }
      state = result.state;
      event = answers[types.at(-1)];
    }
    assert.deepEqual(ran, Object.keys(answers).slice(phases.indexOf(start)), start);
  }
});

test("Space creation: every state and event has exactly one outcome", () => {
  const expected = {
    reserved: { space_recorded: ["space_recorded", "create_content_document"] },
    space_recorded: { content_created: ["content_created", "commit_catalog"] },
    content_created: { committed: ["ready", null] },
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
    "create_content_document",
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
      create_content_document: "content_created",
      commit_catalog: "committed",
    };
    for (let effect = spaceCreationEffect(state); effect; ) {
      effects.push(effect);
      ({ state, effect } = spaceCreationTransition(state, events[effect]));
    }
    assert.equal(state, "ready");
    assert.deepEqual(
      effects,
      ["create_space_record", "create_content_document", "commit_catalog"].slice(
        SPACE_CREATION_STATES.indexOf(start),
      ),
    );
  }
});
