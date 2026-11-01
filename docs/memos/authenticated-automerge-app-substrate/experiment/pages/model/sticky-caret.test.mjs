import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  codePointBefore,
  codePointWidth,
  stickyCaret,
  stickyCaretPosition,
} from "./sticky-caret.mjs";

test("code point boundaries count an emoji once", () => {
  const text = "a🌊b";
  assert.equal(codePointBefore(text, 1), 0);
  assert.equal(codePointBefore(text, 3), 1);
  assert.equal(codePointBefore(text, 4), 3);
  assert.equal(codePointWidth(text, 1), 2);
  assert.equal(codePointWidth(text, 3), 1);
});

test("a sticky caret after an emoji lands after the whole emoji", () => {
  const path = ["t"];
  const doc = A.from({ t: "a🌊b" });
  const cursor = stickyCaret(doc, path, doc.t, 3);
  const peer = A.change(A.clone(doc), (d) => A.splice(d, path, 3, 0, "X"));
  assert.equal(stickyCaretPosition(peer, path, peer.t, cursor), 3);
  const gone = A.change(A.clone(doc), (d) => A.splice(d, path, 1, 2));
  assert.equal(stickyCaretPosition(gone, path, gone.t, cursor), 1);
  assert.equal(stickyCaret(doc, path, doc.t, 0), null);
});
