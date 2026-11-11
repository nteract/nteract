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
import { PagesImage } from "./wordgard-doc.mjs";
import { assertDocumentLimits } from "./limits.mjs";
import { imageIds } from "./image-ids.mjs";
import { documentFeatures } from "./schema-features.mjs";

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
  assert.equal(image.type, PagesImage);
  assert.equal(image.param.alt, alt);
  assert.equal(image.param.src, inserted.asset_url);
  const markdown = projectPage(after).blocks[1].markdown;
  const reparsed = parseMarkdown(markdown).firstChild.firstChild;
  assert.equal(reparsed.type, PagesImage);
  assert.equal(reparsed.param.alt, alt);
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
test("ordinary inserted images remain editable through Markdown", () => {
  const { after, result } = apply(fixture(), [
    { op: "insert_image", asset_id, alt: "Diagram", title: "Title" },
  ]);
  const { block_id, asset_url } = result.inserted_images[0];
  const marker = A.spans(after, ["blocks", block_id, "richText"]).find(
    (span) => span.type === "block" && String(span.value.type) === "image",
  );
  assert.ok(!Object.hasOwn(marker.value.attrs, "dark_src"));
  const changed = apply(after, [
    {
      op: "replace_block_markdown",
      block_id,
      markdown: `![Changed](${asset_url} "New title")`,
    },
  ]).after;
  const image = richDoc(changed.blocks[block_id]).firstChild.firstChild;
  assert.equal(image.param.alt, "Changed");
  assert.equal(image.param.title, "New title");
  assert.equal(image.param.src, asset_url);
  const removed = apply(changed, [
    { op: "replace_block_markdown", block_id, markdown: "Gone" },
  ]).after;
  assert.equal(projectPage(removed).blocks.find((block) => block.id === block_id).markdown, "Gone");
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

test("two sources share metadata, preserve marker identity and stamp monotonically", () => {
  const { after, result } = apply(fixture(), [
    { op: "insert_image", asset_id, dark_asset_id: "b".repeat(64), alt: "", title: "Chart" },
  ]);
  const { block_id, image_id } = result.inserted_images[0];
  assert.equal(imageIds(after, block_id)[0].image_id, image_id);
  assert.ok(documentFeatures(after).includes("image-theme-variants"));
  assert.equal(
    richDoc(after.blocks[block_id]).firstChild.firstChild.param.dark_src,
    `/api/pages/${pageId}/assets/${"b".repeat(64)}`,
  );
  const changed = apply(after, [
    { op: "set_image", block_id, image_id, dark_asset_id: null, alt: "Updated" },
  ]).after;
  assert.equal(imageIds(changed, block_id)[0].image_id, image_id);
  assert.ok(documentFeatures(changed).includes("image-theme-variants"));
  const image = richDoc(changed.blocks[block_id]).firstChild.firstChild;
  assert.equal(image.param.dark_src, undefined);
  assert.equal(image.param.alt, "Updated");
  assert.equal(image.param.title, "Chart");
  assert.throws(
    () =>
      apply(changed, [
        { op: "set_image", block_id, image_id, alt: "one" },
        { op: "set_image", block_id, image_id, alt: "two" },
      ]),
    /same image twice/,
  );
  const deleted = A.change(A.clone(changed), (doc) =>
    A.splice(doc, ["blocks", block_id, "richText"], 1, 1),
  );
  assert.throws(() => apply(deleted, [{ op: "set_image", block_id, image_id, alt: "Gone" }]), {
    code: "image_not_found",
  });
});
