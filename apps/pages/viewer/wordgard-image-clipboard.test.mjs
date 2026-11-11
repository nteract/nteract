import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parse, serialize } from "wordgard/doc";
import { schema, encode, decode, Paragraph, PagesImage } from "./wordgard-model.mjs";

const value = {
  src: "https://example.com/image.png",
  alt: "Diagram",
  title: null,
  future: "opaque",
  enabled: false,
  count: 1.5,
  empty: null,
  onerror: "alert(1)",
  style: "display:none",
};
const tree = (attrs) => schema.doc([Paragraph.create([PagesImage.of(attrs)])]);
test("image scalar attrs survive native and clipboard codecs without becoming DOM attrs", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const original = tree(value);
  const decoded = decode(encode(original));
  assert.equal(decoded.lossy, false);
  assert.ok(decoded.doc.eq(original));
  const fragment = serialize(original).toDOM(dom.window.document);
  const img = fragment.querySelector("img");
  assert.equal(img.getAttribute("onerror"), null);
  assert.equal(img.getAttribute("style"), null);
  assert.ok(parse(schema, fragment).eq(original));
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(
    serialize(tree(reordered))
      .toDOM(dom.window.document)
      .querySelector("img")
      .getAttribute("data-pages-image"),
    img.getAttribute("data-pages-image"),
    "native key ordering must not redraw the selected image after a peer edit",
  );
});
test("malformed, oversized and identity-changing clipboard metadata refuses the image", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  for (const metadata of [
    "{",
    "null",
    "x".repeat(16385),
    JSON.stringify({ ...value, src: "javascript:alert(1)" }),
    JSON.stringify({ ...value, future: {} }),
    JSON.stringify({ ...value, alt: "different" }),
  ]) {
    const img = dom.window.document.createElement("img");
    img.setAttribute("src", value.src);
    img.setAttribute("alt", value.alt);
    img.setAttribute("data-pages-image", metadata);
    const container = dom.window.document.createElement("div");
    container.append(img);
    assert.ok(
      !encode(parse(schema, container)).some(
        (s) => s.type === "block" && String(s.value.type) === "image",
      ),
    );
  }
});
test("unsupported native scalars block writes and oversized attrs still render", (t) => {
  for (const future of [
    { nested: true },
    [1],
    new Date(),
    new Uint8Array([1]),
    NaN,
    Infinity,
    -0,
  ]) {
    assert.throws(() => encode(tree({ ...value, future })), /Invalid Pages image/);
    const spans = encode(tree(value));
    spans.find((s) => s.type === "block" && String(s.value.type) === "image").value.attrs.future =
      future;
    assert.equal(decode(spans).lossy, true);
  }
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const fragment = serialize(tree({ ...value, future: "x".repeat(16385) })).toDOM(
    dom.window.document,
  );
  assert.equal(fragment.querySelector("img").getAttribute("data-pages-image"), "null");
  assert.ok(
    !encode(parse(schema, fragment)).some(
      (s) => s.type === "block" && String(s.value.type) === "image",
    ),
  );
});
