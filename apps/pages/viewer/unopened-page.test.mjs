import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENTS,
  STATES,
  UNOPENED_INITIAL,
  formatRefused,
  sessionFormatStopped,
  trashArguments,
  trashOutcome,
  unopenedAction,
  unopenedPageStep,
} from "./unopened-page.mjs";
import { signingKeyRefused } from "./session.mjs";

const OWNER = { role: "owner", canRead: true, canDelete: true };
const MEMBER = { role: "editor", canRead: true, canDelete: false };
const SAMPLE = {
  answered: { type: "answered", access: OWNER },
  unanswered: { type: "unanswered" },
  trash: { type: "trash", nonce: "new-nonce" },
  succeeded: { type: "succeeded" },
  failed: { type: "failed", message: "Offline" },
  refused: { type: "refused", message: "No" },
};
const at = (name) =>
  name === "trashing" || name === "failed"
    ? { name, nonce: "held-nonce", ...(name === "failed" && { message: "Earlier" }) }
    : { name };
// [next state, effect types] for each state × event.
const same = (name) => Object.fromEntries(EVENTS.map((event) => [event, [name, []]]));
const NEXT = {
  checking: {
    ...same("checking"),
    answered: ["owner", []],
    unanswered: ["reader", []],
  },
  reader: same("reader"),
  owner: { ...same("owner"), trash: ["trashing", ["trash"]] },
  inTrash: same("inTrash"),
  trashing: {
    ...same("trashing"),
    succeeded: ["trashed", ["leave"]],
    failed: ["failed", []],
    refused: ["checking", ["check"]],
  },
  failed: { ...same("failed"), trash: ["trashing", ["trash"]] },
  trashed: same("trashed"),
};

test("every state × event lands where the table says", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...EVENTS].sort());
  assert.deepEqual(Object.keys(NEXT).sort(), [...STATES].sort());
  for (const name of STATES)
    for (const event of EVENTS) {
      const [expected, effects] = NEXT[name][event];
      const state = at(name);
      const result = unopenedPageStep(state, SAMPLE[event]);
      const label = `${name} × ${event}`;
      assert.equal(result.state.name, expected, label);
      assert.deepEqual(
        result.effects.map((effect) => effect.type),
        effects,
        label,
      );
      if (expected === name && effects.length === 0)
        assert.equal(result.state, state, `${label} returns the same state`);
    }
});

test("unknown states and events throw", () => {
  assert.throws(() => unopenedPageStep({ name: "open" }, SAMPLE.trash), /Unknown unopened/);
  assert.throws(() => unopenedPageStep(UNOPENED_INITIAL, { type: "open" }), /Unknown unopened/);
});

test("only the host's answer that this account owns the Page offers Move to Trash", () => {
  const answered = (access) =>
    unopenedPageStep(UNOPENED_INITIAL, { type: "answered", access }).state;
  assert.equal(unopenedAction(UNOPENED_INITIAL), null, "nothing while the host is asked");
  assert.equal(unopenedAction(answered(OWNER)), "trash");
  assert.equal(unopenedAction(answered(MEMBER)), null);
  assert.equal(unopenedAction(answered(undefined)), null);
  assert.equal(
    unopenedAction(unopenedPageStep(UNOPENED_INITIAL, { type: "unanswered" }).state),
    null,
    "no answer offers nothing",
  );
  // A Page already in its owner's Trash offers Trash instead.
  const inTrash = answered({ ...OWNER, trashed: true, canRestore: true });
  assert.equal(inTrash.name, "inTrash");
  assert.equal(unopenedAction(inTrash), "trashView");
  assert.equal(unopenedAction(answered({ trashed: true, canDelete: true })), null);
  assert.equal(unopenedAction(at("failed")), "trash");
  assert.equal(unopenedAction(at("trashed")), null);
});

test("a retry after an uncertain failure resends its nonce", () => {
  let { state, effects } = unopenedPageStep({ name: "owner" }, { type: "trash", nonce: "first" });
  assert.deepEqual(effects, [{ type: "trash", nonce: "first" }]);
  ({ state } = unopenedPageStep(state, { type: "failed", message: "Offline" }));
  assert.deepEqual(state, { name: "failed", nonce: "first", message: "Offline" });
  ({ state, effects } = unopenedPageStep(state, { type: "trash", nonce: "second" }));
  assert.deepEqual(effects, [{ type: "trash", nonce: "first" }]);
  assert.equal(state.name, "trashing");
});

test("a move the host settled as not applied asks again and spends its nonce", () => {
  let { state, effects } = unopenedPageStep({ name: "owner" }, { type: "trash", nonce: "first" });
  ({ state, effects } = unopenedPageStep(state, { type: "refused", message: "Changed" }));
  assert.deepEqual(state, { name: "checking", message: "Changed" });
  assert.deepEqual(effects, [{ type: "check" }]);
  // The Page may be in Trash now, or no longer this account's to trash.
  assert.deepEqual(
    unopenedPageStep(state, { type: "answered", access: { trashed: true, canRestore: true } })
      .state,
    { name: "inTrash", message: "Changed" },
  );
  assert.deepEqual(unopenedPageStep(state, { type: "answered", access: MEMBER }).state, {
    name: "reader",
    message: "Changed",
  });
  ({ state } = unopenedPageStep(state, { type: "answered", access: OWNER }));
  assert.deepEqual(state, { name: "owner", message: "Changed" });
  ({ state, effects } = unopenedPageStep(state, { type: "trash", nonce: "second" }));
  assert.deepEqual(effects, [{ type: "trash", nonce: "second" }], "a new nonce");
  assert.deepEqual(state, { name: "trashing", nonce: "second" });
});

test("delete_page outcomes split into uncertain and settled", () => {
  // The move may have landed: the same nonce replays it.
  for (const error of [
    Object.assign(new TypeError("Failed to fetch"), { code: "NETWORK_ERROR" }),
    Object.assign(Error("The request timed out."), { code: "REQUEST_TIMEOUT" }),
    Object.assign(Error("Unexpected"), { code: "INVALID_RESPONSE", httpStatus: 404 }),
    Object.assign(Error("Pages request failed"), { status: 500 }),
    Object.assign(Error("Unavailable"), { status: 503, retryable: true }),
    Object.assign(Error("Still settling"), { status: 409, code: "lifecycle_unsettled" }),
  ])
    assert.equal(trashOutcome(error).type, "failed", error.message);
  // The host answered that nothing applied: the nonce is spent.
  for (const error of [
    Object.assign(Error("Only the owner"), { status: 403, code: "page_access_denied" }),
    Object.assign(Error("Not found"), { status: 404, code: "page_not_found" }),
    Object.assign(Error("Trash full"), { status: 409, code: "trash_capacity" }),
    Object.assign(Error("Bad"), { status: 400, code: "invalid_revision" }),
  ])
    assert.equal(trashOutcome(error).type, "refused", error.message);
  assert.equal(trashOutcome(undefined, { superseded: true }).type, "refused");
  assert.equal(trashOutcome(undefined, { applied: false }).type, "refused");
  assert.deepEqual(trashOutcome(undefined, { state: "trashed" }), { type: "succeeded" });
});

test("a move to Trash names heads unless the host stopped the Page for its format", () => {
  const args = { pageId: "page", principal: "user:owner", nonce: "n" };
  assert.deepEqual(trashArguments({ ...args, heads: ["h1"] }), {
    page_id: "page",
    expected_principal: "user:owner",
    base_heads: ["h1"],
    nonce: "n",
  });
  const unopened = trashArguments({ ...args, heads: undefined });
  assert.deepEqual(unopened, { page_id: "page", expected_principal: "user:owner", nonce: "n" });
  assert.equal(Object.hasOwn(unopened, "base_heads"), false);
  assert.equal(Object.hasOwn(unopened, "revision"), false);
  assert.equal(sessionFormatStopped({ formatGate: { name: "stopped" } }), true);
  assert.equal(sessionFormatStopped({ formatGate: { name: "open" } }), false);
  assert.equal(sessionFormatStopped(null), false);
});

test("the format refusal is recognized from discovery and from the socket", () => {
  assert.equal(formatRefused({ status: 409, code: "document_format_unsupported" }), true);
  assert.equal(formatRefused(signingKeyRefused({ code: "document_format_unsupported" })), true);
  assert.equal(formatRefused(signingKeyRefused({ code: "signing_key_rejected" })), false);
  assert.equal(formatRefused({ status: 409, code: "stored_form_unsupported" }), false);
  assert.equal(formatRefused(undefined), false);
});
