import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Leaf, parse, serialize } from "wordgard/doc";
import {
  schema,
  encode,
  decode,
  TaskList,
  TaskChecked,
  ListItem,
  Paragraph,
  BulletList,
} from "./wordgard-model.mjs";

const item = (checked, text) =>
  ListItem.withMarks([TaskChecked.of(checked)]).create([Paragraph.create([Leaf.text(text)])]);

test("task checked booleans survive clipboard DOM and native round trips", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const tree = schema.doc([TaskList.create([item(true, "Done"), item(false, "Next")])]),
    fragment = serialize(tree).toDOM(dom.window.document),
    pasted = parse(schema, fragment);
  assert.equal(fragment.querySelector("ul").getAttribute("data-task-list"), "true");
  assert.equal(pasted.content[0].type, TaskList.type);
  assert.deepEqual(
    pasted.content[0].content.map((node) => node.mark(TaskChecked)),
    [true, false],
  );
  assert.ok(decode(encode(pasted)).doc.eq(tree));
});

test("ordinary HTML lists do not become task lists", (t) => {
  const dom = new JSDOM("<ul><li><p>Ordinary</p></li></ul>");
  t.after(() => dom.window.close());
  const pasted = parse(schema, dom.window.document.body);
  assert.equal(pasted.content[0].type, BulletList.type);
  assert.equal(pasted.content[0].content[0].mark(TaskChecked), undefined);
  assert.ok(decode(encode(pasted)).doc.eq(pasted));
});

test("invalid checkbox values cannot be encoded as native task state", () => {
  for (const value of ["true", "false", 0, 1, null]) {
    assert.throws(
      () => encode(schema.doc([TaskList.create([item(value, "Task")])])),
      /Invalid task/,
    );
  }
});
