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
import { blockAddress, nodeAddresses } from "./addresses.mjs";
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
/** The key of the block `address` names. */
const keyOf = (doc, address) =>
  orderedBlockIds(doc).find((key) => blockAddress(doc, key) === address);
test("image insertion creates a native embed without interpreting alt text as Markdown", () => {
  const before = fixture();
  const first = orderedBlockIds(before)[0];
  const identity = A.getObjectId(before.blocks[first], "richText");
  const alt = "A cat ](https://elsewhere.example) ![other] — **bold** & <tag> 🐈";
  const { after, result } = apply(before, [{ op: "insert_image", asset_id, alt }]);
  const [inserted] = result.edits;
  assert.equal(inserted.op, "insert_image");
  const key = keyOf(after, inserted.node_id);
  assert.deepEqual(orderedBlockIds(after), [first, key]);
  assert.deepEqual(inserted.nodes, nodeAddresses(after, key));
  assert.equal(inserted.image, imageIds(after, key)[0].id);
  assert.equal(A.getObjectId(after.blocks[first], "richText"), identity);
  assert.equal(projectPage(after).blocks[0].markdown, projectPage(before).blocks[0].markdown);
  assert.equal(inserted.asset_url, `/api/pages/${pageId}/assets/${asset_id}`);
  assert.equal(inserted.alt, alt);
  const image = richDoc(after.blocks[key]).firstChild.firstChild;
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
    [{ after_node_id: null }, "first"],
    [{ after_node_id: blockAddress(before, first) }, "last"],
  ]) {
    const { after, result } = apply(before, [
      { op: "insert_image", asset_id, alt: "", ...placement },
    ]);
    const ids = orderedBlockIds(after);
    const key = keyOf(after, result.edits[0].node_id);
    assert.equal(expected === "first" ? ids[0] : ids.at(-1), key);
    assert.equal(A.isRawString(after.blocks[key].position), true);
  }
  const { result } = apply(before, [
    { op: "insert_image", asset_id, alt: "one" },
    { op: "insert_image", asset_id, alt: "two" },
  ]);
  assert.equal(new Set(result.edits.map((edit) => edit.node_id)).size, 2);
});
test("ordinary inserted images remain editable through Markdown", () => {
  const { after, result } = apply(fixture(), [
    { op: "insert_image", asset_id, alt: "Diagram", title: "Title" },
  ]);
  const { node_id, asset_url } = result.edits[0];
  const key = keyOf(after, node_id);
  const marker = A.spans(after, ["blocks", key, "richText"]).find(
    (span) => span.type === "block" && String(span.value.type) === "image",
  );
  assert.ok(!Object.hasOwn(marker.value.attrs, "dark_src"));
  const changed = apply(after, [
    {
      op: "replace_block_markdown",
      node_id,
      markdown: `![Changed](${asset_url} "New title")`,
    },
  ]).after;
  const image = richDoc(changed.blocks[key]).firstChild.firstChild;
  assert.equal(image.param.alt, "Changed");
  assert.equal(image.param.title, "New title");
  assert.equal(image.param.src, asset_url);
  const removed = apply(changed, [
    { op: "replace_block_markdown", node_id, markdown: "Gone" },
  ]).after;
  assert.equal(projectPage(removed).blocks.find((block) => block.id === key).markdown, "Gone");
});
test("malformed or unplaceable images reject the entire structural batch", () => {
  const before = fixture();
  for (const invalid of [
    { asset_id: "https://elsewhere.example/image.png" },
    { alt: null },
    { alt: "a".repeat(2049) },
    { after_node_id: "missing" },
    { after_node_id: "" },
    { after_node_id: "999@abcdef" },
    { after_block_id: null },
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
  const { node_id: block, image } = result.edits[0];
  const key = keyOf(after, block);
  assert.equal(imageIds(after, key)[0].id, image);
  assert.ok(documentFeatures(after).includes("image-theme-variants"));
  assert.equal(
    richDoc(after.blocks[key]).firstChild.firstChild.param.dark_src,
    `/api/pages/${pageId}/assets/${"b".repeat(64)}`,
  );
  const changed = apply(after, [
    { op: "set_image", node_id: image, dark_asset_id: null, alt: "Updated" },
  ]).after;
  assert.equal(imageIds(changed, key)[0].id, image);
  assert.ok(documentFeatures(changed).includes("image-theme-variants"));
  const node = richDoc(changed.blocks[key]).firstChild.firstChild;
  assert.equal(node.param.dark_src, undefined);
  assert.equal(node.param.alt, "Updated");
  assert.equal(node.param.title, "Chart");
  assert.throws(
    () =>
      apply(changed, [
        { op: "set_image", node_id: image, alt: "one" },
        { op: "set_image", node_id: image, alt: "two" },
      ]),
    /same image twice/,
  );
  const deleted = A.change(A.clone(changed), (doc) =>
    A.splice(doc, ["blocks", key, "richText"], 1, 1),
  );
  assert.throws(() => apply(deleted, [{ op: "set_image", node_id: image, alt: "Gone" }]), {
    code: "node_not_found",
  });
});
