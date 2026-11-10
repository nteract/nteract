import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Leaf, parse, serialize } from "wordgard/doc";
import { schema, encode, decode, Alignment, Table, TableRow, Cell } from "./wordgard-model.mjs";

function table(mark) {
  return schema.doc([
    Table.create([TableRow.create([Cell.withMarks([mark]).create([Leaf.text("Cell content")])])]),
  ]);
}

test("physical cell alignment survives clipboard DOM and native round trips", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  for (const align of ["left", "center", "right"]) {
    const tree = table(Alignment.of(align));
    const fragment = serialize(tree).toDOM(dom.window.document);
    assert.equal(fragment.querySelector("td").style.textAlign, align);
    const pasted = parse(schema, fragment);
    assert.equal(pasted.content[0].content[0].content[0].mark(Alignment), align);
    assert.ok(decode(encode(pasted)).doc.eq(tree));
  }
});

test("logical clipboard alignment is normalized for the Pages LTR schema", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  for (const [style, expected] of [
    ["start", "left"],
    ["end", "right"],
    ["right", "right"],
    ["center", "center"],
  ]) {
    dom.window.document.body.innerHTML = `<table><tr><td style="text-align:${style}">Value</td></tr></table>`;
    const pasted = parse(schema, dom.window.document.body);
    assert.equal(pasted.content[0].content[0].content[0].mark(Alignment), expected);
    assert.ok(decode(encode(pasted)).doc.eq(pasted));
  }
});

test("noncanonical alignment cannot enter native table spans", () => {
  for (const value of ["end", "start", "justify", "", 1, null, "right;color:red"]) {
    // Wordgard mark factories do not invoke validators, so the encoder must
    // reject invalid values before they can be admitted into Automerge.
    assert.throws(() => encode(table(Alignment.of(value))), /Invalid table alignment/);
  }
});

test("unsupported clipboard styles are ignored without creating invalid native state", (t) => {
  const dom = new JSDOM('<table><tr><td style="text-align:justify">Value</td></tr></table>');
  t.after(() => dom.window.close());
  const pasted = parse(schema, dom.window.document.body);
  assert.equal(pasted.content[0].content[0].content[0].mark(Alignment), undefined);
  assert.ok(decode(encode(pasted)).doc.eq(pasted));
});
