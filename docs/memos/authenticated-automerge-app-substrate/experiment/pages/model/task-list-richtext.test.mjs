import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  parseMarkdown,
  exportMarkdown,
  enableRich,
  setRichMarkdown,
  textPath,
  validateRich,
  blockMarkdown,
} from "./richtext.mjs";
import { decode, encode, TaskList, TaskChecked } from "../viewer/wordgard-model.mjs";

const path = textPath("one");
const fixture = (markdown) =>
  A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }), (doc) =>
    enableRich(doc, "one"),
  );
const checkedStates = (doc) =>
  A.spans(doc, path)
    .filter((span) => span.type === "block" && String(span.value.type) === "task-list-item")
    .map((span) => span.value.attrs.checked);

test("task Markdown imports native checked values and round trips through Wordgard", () => {
  for (const source of [
    "- [ ] Write the plan\n- [x] Share **the draft**",
    "* [X] Finished\n* [ ] Next",
    "+ [ ] An empty task below\n+ [ ]",
    "> - [x] Quoted task\n> - [ ] Follow up",
    "- [x] Parent\n  - [ ] Child\n\n  More detail",
    "- [ ] First paragraph\n\n  Second paragraph\n\n  - [x] Nested task",
    "- [ ] Wrapped task\n  continuation\n\n- [x] Another task",
    "- [ ] Task\n- Plain bullet\n- [x] Done",
    "- [ ] [Read the plan](https://example.com/plan)\n- [x] **Bold** and `code`",
  ]) {
    const native = fixture(source),
      tree = decode(A.spans(native, path)).doc,
      spans = encode(tree),
      rewritten = A.change(native, (doc) => A.updateSpans(doc, path, spans));
    validateRich(native.blocks.one);
    validateRich(rewritten.blocks.one);
    assert.ok(decode(spans).doc.eq(tree), source);
    assert.deepEqual(checkedStates(rewritten), checkedStates(native), source);
    assert.equal(blockMarkdown(rewritten.blocks.one), source);
    const projected = exportMarkdown(parseMarkdown(source));
    assert.deepEqual(parseMarkdown(projected).toJSON(), parseMarkdown(source).toJSON());
  }
  const list = decode(A.spans(fixture("- [x] Done\n- [ ] Next"), path)).doc.content[0];
  assert.equal(list.type, TaskList.type);
  assert.deepEqual(
    list.content.map((item) => item.mark(TaskChecked)),
    [true, false],
  );
});

test("checkbox-like prose, code, escapes, and invalid markers stay literal", () => {
  for (const source of [
    "Discuss [ ] and [x] in prose",
    "- `[ ]` literal code",
    "- \\[ \\] escaped task",
    "- [y] not a task",
    "- [x]nospace",
    "```text\n- [ ] source only\n```",
  ]) {
    const native = fixture(source);
    assert.deepEqual(checkedStates(native), [], source);
    assert.equal(blockMarkdown(native.blocks.one), source);
    validateRich(native.blocks.one);
  }
});

test("agent checkbox edits retain text identity and merge with concurrent writing", () => {
  const original = fixture("- [ ] Write the plan\n- [ ] Review it"),
    object = A.getObjectId(original.blocks.one, "richText"),
    index = original.blocks.one.richText.indexOf("plan"),
    cursor = A.getCursor(original, path, index);
  const checked = A.change(A.clone(original), (doc) =>
    setRichMarkdown(doc, "one", "- [x] Write the plan\n- [ ] Review it"),
  );
  assert.deepEqual(checkedStates(checked), [true, false]);
  assert.equal(A.getObjectId(checked.blocks.one, "richText"), object);
  assert.equal(A.getCursorPosition(checked, path, cursor), index);
  assert.ok(
    !A.diff(checked, A.getHeads(original), A.getHeads(checked)).some((patch) =>
      ["splice", "spliceText", "del"].includes(patch.action),
    ),
  );
  const writing = A.change(A.clone(original), (doc) => A.splice(doc, path, index, 0, "shared ")),
    merged = A.merge(checked, writing);
  assert.deepEqual(checkedStates(merged), [true, false]);
  assert.match(blockMarkdown(merged.blocks.one), /- \[x\] Write the shared plan/);
  assert.equal(A.getCursorPosition(merged, path, cursor), index + "shared ".length);
  assert.deepEqual(checkedStates(A.load(A.save(merged))), [true, false]);
  validateRich(merged.blocks.one);
});

test("native task state is a boolean, never a truthy string or number", () => {
  for (const invalid of ["true", 1, null]) {
    const original = fixture("- [ ] Task"),
      spans = A.spans(original, path);
    spans[0].value.attrs.checked = invalid;
    const bad = A.change(original, (doc) => A.updateSpans(doc, path, spans));
    assert.throws(() => validateRich(bad.blocks.one), /Invalid task checked state/);
    assert.throws(() => decode(spans), /Invalid task checked state/);
  }
});

test("the alternative editor renders task state without adding checkboxes to ordinary lists", () => {
  const task = parseMarkdown("- [x] Complete").firstChild.firstChild,
    ordinary = parseMarkdown("- Ordinary").firstChild.firstChild;
  assert.equal(task.type.spec.toDOM(task)[2][1].checked, "");
  assert.equal(task.type.spec.toDOM(task)[2][1].disabled, "");
  assert.deepEqual(ordinary.type.spec.toDOM(ordinary), ["li", 0]);
});
