import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENTS,
  STATES,
  formReady,
  initialCreate,
  initialMove,
  openingEffects,
  transition,
} from "./container-dialog-machine.mjs";

const attempt = { retry_token: "token", idempotency_key: "v1_abc_nonce1234" };
const PRJ = "prj_one";
const OTHER = "prj_two";

const create = (name, extra = {}) => ({
  ...initialCreate(),
  form: { title: "Notes", description: "" },
  name,
  ...extra,
});
const move = (name, extra = {}) => ({ ...initialMove(PRJ), name, ...extra });

// One event of each type, and the state each starting state should end in.
const SAMPLE = {
  edit: { type: "edit", form: { title: "Conference" } },
  submit: { type: "submit" },
  succeeded: { type: "succeeded", result: { project_id: PRJ } },
  failed: { type: "failed", message: "Nope", attempt },
  close: { type: "close" },
  parentsLoaded: { type: "parentsLoaded", target: PRJ, rows: [] },
  parentsFailed: { type: "parentsFailed", target: PRJ, message: "offline" },
};
const NEXT = {
  editing: {
    edit: "editing",
    submit: "submitting",
    succeeded: "editing",
    failed: "editing",
    close: "editing",
    parentsLoaded: "editing",
    parentsFailed: "editing",
  },
  submitting: {
    edit: "submitting",
    submit: "submitting",
    succeeded: "done",
    failed: "editing",
    close: "submitting",
    parentsLoaded: "submitting",
    parentsFailed: "submitting",
  },
  done: Object.fromEntries(EVENTS.map((event) => [event, "done"])),
};

test("every state × event lands where the table says, for both dialogs", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...EVENTS].sort());
  for (const name of STATES)
    for (const event of EVENTS)
      for (const state of [create(name), move(name)]) {
        const { state: next } = transition(state, SAMPLE[event]);
        assert.equal(next.name, NEXT[name][event], `${state.kind} ${name} × ${event}`);
      }
});

test("an event that changes nothing returns the same state and no effects", () => {
  for (const name of STATES) {
    const state = create(name);
    for (const event of [{ type: "unknown" }, undefined, SAMPLE.parentsLoaded]) {
      const result = transition(state, event);
      assert.equal(result.state, state);
      assert.deepEqual(result.effects, []);
    }
  }
  const editing = create("editing");
  assert.equal(transition(editing, { type: "edit", form: { title: "Notes" } }).state, editing);
});

test("create: submit writes the form; success finishes; failure keeps the attempt for a retry", () => {
  let state = initialCreate();
  assert.deepEqual(openingEffects(state), []);
  assert.equal(formReady("create", state.form), false);
  // An empty or blank title can't submit.
  assert.equal(transition(state, SAMPLE.submit).state, state);
  state = transition(state, { type: "edit", form: { title: "  " } }).state;
  assert.equal(transition(state, SAMPLE.submit).state, state);
  state = transition(state, {
    type: "edit",
    form: { title: "Conference", description: "Q4" },
  }).state;
  let result = transition(state, SAMPLE.submit);
  assert.deepEqual(result.effects, [
    { type: "write", form: { title: "Conference", description: "Q4" }, attempt: null },
  ]);
  state = result.state;
  // Closing while the write is in flight is ignored.
  assert.deepEqual(transition(state, SAMPLE.close).effects, []);
  result = transition(state, SAMPLE.failed);
  assert.equal(result.state.error, "Nope");
  assert.deepEqual(result.state.attempt, attempt);
  // The retry replays the same key.
  result = transition(result.state, SAMPLE.submit);
  assert.deepEqual(result.effects[0].attempt, attempt);
  // A failed write without a message still says something.
  assert.match(transition(result.state, { type: "failed" }).state.error, /went wrong/);
  // An edit after a failure drops the attempt and the error.
  const failed = transition(result.state, SAMPLE.failed).state;
  const edited = transition(failed, { type: "edit", form: { title: "Other" } }).state;
  assert.equal(edited.attempt, null);
  assert.equal(edited.error, "");
  result = transition(transition(edited, SAMPLE.submit).state, SAMPLE.succeeded);
  assert.equal(result.state.name, "done");
  assert.deepEqual(result.effects, [{ type: "finish", result: { project_id: PRJ } }]);
  assert.deepEqual(transition(create("editing"), SAMPLE.close).effects, [{ type: "dismiss" }]);
});

test("move: opening loads the current container's parents; a new target reloads them", () => {
  let state = initialMove(PRJ);
  assert.deepEqual(openingEffects(state), [{ type: "loadParents", target: PRJ }]);
  assert.equal(formReady("move", state.form), true, "the top level of the current Project");
  assert.equal(formReady("other", state.form), false);
  // A stale answer for another target changes nothing.
  assert.equal(transition(state, { type: "parentsLoaded", target: OTHER, rows: [] }).state, state);
  const rows = [{ page_id: "a", title: "A", depth: 0 }];
  state = transition(state, { type: "parentsLoaded", target: PRJ, rows }).state;
  assert.deepEqual(state.parents, { status: "ready", target: PRJ, rows });
  // A second answer for a settled load is ignored.
  assert.equal(transition(state, { type: "parentsFailed", target: PRJ }).state, state);
  state = transition(state, { type: "edit", form: { parent_id: "a" } }).state;
  assert.equal(state.form.parent_id, "a");
  // Choosing Your items clears the parent and loads its Pages.
  const result = transition(state, { type: "edit", form: { target: null } });
  assert.deepEqual(result.state.form, { target: null, parent_id: null });
  assert.deepEqual(result.state.parents, { status: "loading", target: null, rows: [] });
  assert.deepEqual(result.effects, [{ type: "loadParents", target: null }]);
  state = transition(result.state, {
    type: "parentsFailed",
    target: null,
    message: "offline",
  }).state;
  assert.equal(state.parents.status, "failed");
  // Moving to the top level still works while parents are unavailable.
  const submitted = transition(state, SAMPLE.submit);
  assert.deepEqual(submitted.effects, [
    { type: "write", form: { target: null, parent_id: null }, attempt: null },
  ]);
  // parents events reach only the Move dialog.
  const creating = create("editing");
  assert.equal(transition(creating, SAMPLE.parentsLoaded).state, creating);
});
