import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { normalizePastedHTML } from "./clipboard-html.mjs";

const { DOMParser } = new JSDOM("").window;
const normalize = (html) => normalizePastedHTML(html, new DOMParser());

test("b and i from Word and web pages become strong and em", () => {
  assert.equal(
    normalize(`<p class=MsoNormal><b><span>Word bold</span></b> plain <i>it</i></p>`),
    `<p class="MsoNormal"><strong><span>Word bold</span></strong> plain <em>it</em></p>`,
  );
  assert.equal(normalize(`<b class="x" data-y="1">a</b>`), `<strong class="x" data-y="1">a</strong>`);
  // Nested renames keep their content and order.
  assert.equal(normalize(`<b>x <i>y</i> z</b>`), `<strong>x <em>y</em> z</strong>`);
});

test("a Google Docs wrapper that turns bold off stays unbolded", () => {
  const html = `<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700;">Bold</span> plain</p></b>`;
  const out = normalize(html);
  assert.ok(!out.includes("<strong"), out);
  assert.ok(out.includes(`<span style="font-weight:700;">Bold</span>`), out);
  assert.ok(!normalize(`<i style="font-style: normal">x</i>`).includes("<em"));
  assert.ok(normalize(`<b style="font-weight: 400">x</b>`).startsWith("<b"));
});

test("HTML without b or i is returned unchanged", () => {
  const html = `<p>Plain <strong>strong</strong> <em>em</em> <br> <blockquote>q</blockquote></p>`;
  assert.equal(normalize(html), html);
  assert.equal(normalize("<body><big>not bold</big></body>"), "<body><big>not bold</big></body>");
});
