import assert from "node:assert/strict";
import test from "node:test";
import { caretAndQuoteAttached } from "./presence-expectations.mjs";

const quote = "Second writer selects this 🌊 passage";
const caret = { peer_id: "a", selection: { status: "attached", kind: "caret" } };
const range = { peer_id: "b", selection: { status: "attached", kind: "selection", quote } };

test("the interim focus caret does not satisfy the presence wait", () => {
  // The second browser's focus caret arrives before its range selection.
  const focusCaret = { peer_id: "b", selection: { status: "attached", kind: "caret" } };
  assert.equal(caretAndQuoteAttached([caret, focusCaret], quote), false);
});

test("a caret and the selected quote satisfy the presence wait", () => {
  assert.equal(caretAndQuoteAttached([caret, range], quote), true);
  assert.equal(caretAndQuoteAttached([range, caret], quote), true);
});

test("a different quote, a detached peer or a third selection does not", () => {
  const partial = { ...range, selection: { ...range.selection, quote: "Second writer" } };
  assert.equal(caretAndQuoteAttached([caret, partial], quote), false);
  const detached = { ...range, selection: { ...range.selection, status: "detached" } };
  assert.equal(caretAndQuoteAttached([caret, detached], quote), false);
  assert.equal(caretAndQuoteAttached([caret, range, { ...caret, peer_id: "c" }], quote), false);
  assert.equal(caretAndQuoteAttached([caret, { peer_id: "c" }, range], quote), true);
  assert.equal(caretAndQuoteAttached(undefined, quote), false);
});
