// Copying a dataframe writes a figure carrying its attrs; pasting reads the
// node back. A dataframe from another Page pastes as its title.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse, serialize } from "wordgard/doc";
import { schema, PagesDataframe, filterPastedDataframes } from "./wordgard-model.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const otherPage = "44444444-4444-4444-8444-444444444444";
const asset = (page) => `/api/pages/${page}/assets/${"a".repeat(64)}`;
const attrs = (page = pageId, extra = {}) => ({
  src: asset(page),
  media_type: PARQUET_MEDIA_TYPE,
  title: "Usage <by> day",
  ...extra,
});

test("a copied dataframe pastes back as the same node, unknown attrs included", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const value = attrs(pageId, { view_id: "v1" });
  const copied = serialize(schema.doc([PagesDataframe.of(value)])).toDOM(dom.window.document);
  const html = filterPastedDataframes(
    copied.firstChild.outerHTML,
    pageId,
    new dom.window.DOMParser(),
  );
  const body = dom.window.document.createElement("body");
  body.innerHTML = html;
  const pasted = parse(schema, body);
  assert.equal(pasted.content.length, 1);
  assert.equal(pasted.content[0].type, PagesDataframe);
  assert.deepEqual(pasted.content[0].param, value);
});

test("a dataframe from another Page, or a forged figure, pastes as text", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const foreign = serialize(schema.doc([PagesDataframe.of(attrs(otherPage))])).toDOM(
    dom.window.document,
  ).firstChild.outerHTML;
  for (const html of [
    foreign,
    `<figure data-pages-dataframe='{"src":"https://evil.example/x","media_type":"x"}'>t</figure>`,
    `<figure data-pages-dataframe='not json'>t</figure>`,
  ]) {
    const filtered = filterPastedDataframes(html, pageId, parser);
    const body = dom.window.document.createElement("body");
    body.innerHTML = filtered;
    const pasted = parse(schema, body);
    let found = false;
    pasted.iterate((node) => {
      found ||= node.type === PagesDataframe;
    });
    assert.equal(found, false, html);
  }
  // Even unfiltered, the parse rule refuses a src that isn't a Page asset path.
  const body = dom.window.document.createElement("body");
  body.innerHTML = `<figure data-pages-dataframe='{"src":"https://evil.example/x","media_type":"x"}'>t</figure>`;
  assert.equal(parse(schema, body).content[0].type === PagesDataframe, false);
});

test("with no Page (the comment editor), every pasted dataframe becomes text", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const html = serialize(schema.doc([PagesDataframe.of(attrs(pageId))])).toDOM(dom.window.document)
    .firstChild.outerHTML;
  const filtered = filterPastedDataframes(html, null, new dom.window.DOMParser());
  assert.equal(filtered.includes("data-pages-dataframe"), false);
  assert.match(filtered, /Usage &lt;by&gt; day/);
});

test("a source-bound table keeps its binding only when pasted into its original Page", async (t) => {
  const { markCopiedHTML } = await import("./copy-registry.mjs");
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const value = {
    binding: { source_id: "usage", revision: "2" },
    media_type: PARQUET_MEDIA_TYPE,
    title: "Usage",
  };
  const raw = serialize(schema.doc([PagesDataframe.of(value)])).toDOM(dom.window.document)
    .firstChild.outerHTML;
  const html = markCopiedHTML(raw, pageId, { parser });
  const body = dom.window.document.createElement("body");
  body.innerHTML = filterPastedDataframes(html, pageId, parser);
  assert.deepEqual(parse(schema, body).firstChild.param, value);
  for (const destination of [otherPage, null]) {
    const text = filterPastedDataframes(html, destination, parser);
    assert.equal(text.includes("data-pages-dataframe"), false);
    assert.match(text, /Usage/);
  }
  assert.equal(filterPastedDataframes(raw, pageId, parser).includes("data-pages-dataframe"), false);
});
