import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { focusCreatedPageTitle, titleHandsOffToBody } from "./title-navigation.mjs";

test("creation focus selects the title only while its writable session is still active", () => {
  const dom = new JSDOM('<input value="Untitled"><button>Elsewhere</button>');
  const input = dom.window.document.querySelector("input");
  const elsewhere = dom.window.document.querySelector("button");
  const created = { pageId: "created", canWrite: true };
  try {
    elsewhere.focus();
    assert.equal(focusCreatedPageTitle(input, created, created), true);
    assert.equal(dom.window.document.activeElement, input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 8]);
    elsewhere.focus();
    // A reopen/account change can have the same page ID but a different session.
    assert.equal(focusCreatedPageTitle(input, created, { ...created }), false);
    assert.equal(focusCreatedPageTitle(input, null, created), false);
    created.canWrite = false;
    assert.equal(focusCreatedPageTitle(input, created, created), false);
    created.canWrite = true;
    input.readOnly = true;
    assert.equal(focusCreatedPageTitle(input, created, created), false);
    assert.equal(dom.window.document.activeElement, elsewhere);
    input.readOnly = false;
    input.remove();
    assert.equal(focusCreatedPageTitle(input, created, created), false);
  } finally {
    dom.window.close();
  }
});

test("Enter hands off from an editable title without interrupting composition or modified input", () => {
  assert.equal(titleHandsOffToBody({ key: "Enter" }, true), true);
  assert.equal(titleHandsOffToBody({ key: "Enter" }, false), false);
  assert.equal(titleHandsOffToBody({ key: "Tab" }, true), false);
  for (const condition of [
    { isComposing: true },
    { nativeEvent: { isComposing: true } },
    { keyCode: 229 },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ])
    assert.equal(titleHandsOffToBody({ key: "Enter", ...condition }, true), false);
});
