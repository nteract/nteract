import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";
import { richDoc, parseMarkdown } from "./richtext.mjs";
import { assertDocumentLimits } from "./limits.mjs";

const asset_id = "a".repeat(64);
const pageId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  return A.change(A.from(createPageData({ pageId })), (doc) =>
    initializePage(doc, "Keep **this** prose."),
  );
}
function apply(doc, operations) {
  let result;
  const after = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
  return { after, result };
}
test("image insertion creates a native embed without interpreting alt text as Markdown", () => {
  const before = fixture();
  const first = orderedBlockIds(before)[0];
  const identity = A.getObjectId(before.blocks[first], "richText");
  const alt = "A cat ](https://elsewhere.example) ![other] — **bold** & <tag> 🐈";
  const { after, result } = apply(before, [{ op: "insert_image", asset_id, alt }]);
  const [inserted] = result.inserted_images;
  assert.deepEqual(orderedBlockIds(after), [first, inserted.block_id]);
  assert.equal(A.getObjectId(after.blocks[first], "richText"), identity);
  assert.equal(projectPage(after).blocks[0].markdown, projectPage(before).blocks[0].markdown);
  assert.equal(inserted.asset_url, `/api/pages/${pageId}/assets/${asset_id}`);
  assert.equal(inserted.alt, alt);
  const image = richDoc(after.blocks[inserted.block_id]).firstChild.firstChild;
  assert.equal(image.type.name, "image");
  assert.equal(image.attrs.alt, alt);
  assert.equal(image.attrs.src, inserted.asset_url);
  const markdown = projectPage(after).blocks[1].markdown;
  const reparsed = parseMarkdown(markdown).firstChild.firstChild;
  assert.equal(reparsed.type.name, "image");
  assert.equal(reparsed.attrs.alt, alt);
  assertDocumentLimits(after);
});
test("image placement reuses append, prepend and explicit fractional block anchors", () => {
  const before = fixture();
  const first = orderedBlockIds(before)[0];
  for (const [placement, expected] of [
    [{}, "last"],
    [{ after_block_id: null }, "first"],
    [{ after_block_id: first }, "last"],
  ]) {
    const { after, result } = apply(before, [
      { op: "insert_image", asset_id, alt: "", ...placement },
    ]);
    const ids = orderedBlockIds(after);
    assert.equal(expected === "first" ? ids[0] : ids.at(-1), result.inserted_images[0].block_id);
    assert.equal(A.isRawString(after.blocks[result.inserted_images[0].block_id].position), true);
  }
  const { result } = apply(before, [
    { op: "insert_image", asset_id, alt: "one" },
    { op: "insert_image", asset_id, alt: "two" },
  ]);
  assert.equal(new Set(result.inserted_images.map((i) => i.block_id)).size, 2);
});
test("malformed or unplaceable images reject the entire structural batch", () => {
  const before = fixture();
  for (const invalid of [
    { asset_id: "https://elsewhere.example/image.png" },
    { alt: null },
    { alt: "a".repeat(2049) },
    { after_block_id: "missing" },
    { after_block_id: "" },
    { src: "https://elsewhere.example" },
  ]) {
    assert.throws(() =>
      apply(before, [
        { op: "set_title", title: "Must not commit" },
        { op: "insert_image", asset_id, alt: "cat", ...invalid },
      ]),
    );
    assert.equal(before.title, "Untitled");
    assert.equal(orderedBlockIds(before).length, 1);
  }
});
