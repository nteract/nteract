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
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { richDoc, textPath } from "./richtext.mjs";

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Original" }));
  doc = A.change(doc, (draft) => initializePage(draft, markdown));
  return { doc, id: orderedBlockIds(doc)[0] };
}
function replace(doc, id, input) {
  let result;
  const after = A.change(doc, (draft) => {
    result = applyPageOperation(draft, {
      operation: "patch_page",
      arguments: { operations: [{ op: "replace_match", block_id: id, ...input }] },
    });
  });
  return { after, result };
}

test("visible text replacement crosses marks while preserving untouched marks, objects, and comment anchors", () => {
  let { doc, id } = fixture(
    "Before **hello** *world* — [🌊 passage](https://example.com).\n\nLater.",
  );
  const { comments } = comment(
    doc,
    newCommentsDoc(),
    { action: "add", block_id: id, selected_text: "🌊 passage", body: "Keep this" },
    { principal: "user:one", displayName: "Kyle", driver: "Browser" },
  );
  const object = A.getObjectId(doc.blocks[id], "richText");
  const cursor = A.getCursor(doc, textPath(id), doc.blocks[id].richText.indexOf("🌊"));
  const markers = A.spans(doc.blocks[id], ["richText"]).filter((span) => span.type === "block");
  const { after, result } = replace(doc, id, { match_text: "hello world", replacement: "friends" });
  const [{ warnings, ...edit }] = result.edits;
  assert.deepEqual(edit, { op: "replace_match", block_id: id, matched: 1 });
  // Neither mark covered the whole match, so neither survives; the receipt says so.
  assert.deepEqual(
    warnings.map(({ code, marks }) => ({ code, marks })),
    [{ code: "marks_dropped", marks: ["strong", "em"] }],
  );
  assert.equal(A.getObjectId(after.blocks[id], "richText"), object);
  assert.equal(
    A.getCursorPosition(after, textPath(id), cursor),
    after.blocks[id].richText.indexOf("🌊"),
  );
  assert.deepEqual(
    A.spans(after.blocks[id], ["richText"]).filter((span) => span.type === "block"),
    markers,
  );
  assert.equal(projectComments(after, comments)[0].selectionContext.text, "🌊 passage");
  assert.equal(projectComments(after, comments)[0].selectionContext.status, "attached");
  assert.ok(projectPage(after).blocks[0].markdown.includes("[🌊 passage](https://example.com)"));
  assert.match(richDoc(after.blocks[id]).textContent, /Before friends — 🌊 passage.Later./);
  richDoc(after.blocks[id]).check();
});

test("context disambiguates repeated visible text without becoming replacement content", () => {
  const { doc, id } = fixture("First apple, middle apple, last apple.");
  const { after } = replace(doc, id, {
    match_text: "apple",
    replacement: "pear",
    context_before: "middle",
    context_after: ", last",
  });
  assert.equal(projectPage(after).blocks[0].markdown, "First apple, middle pear, last apple.");
});

test("UTF-16 offsets preserve emoji and reject unpaired surrogate input", () => {
  const { doc, id } = fixture("🌊 Keep 🌳 target and 🌞 tail.");
  const { after } = replace(doc, id, { match_text: "🌳 target", replacement: "🪴 garden" });
  assert.equal(projectPage(after).blocks[0].markdown, "🌊 Keep 🪴 garden and 🌞 tail.");
  for (const input of [
    { match_text: "\ud83c", replacement: "x" },
    { match_text: "target", replacement: "\ud800" },
    { match_text: "target", replacement: "x", context_before: "\udc00" },
  ])
    assert.throws(() => replace(A.clone(doc), id, input), /unpaired surrogate/);
});

test("zero, ambiguous, overlapping and contextual misses reject the whole batch", () => {
  for (const input of [
    { match_text: "missing", replacement: "x" },
    { match_text: "apple", replacement: "x" },
    { match_text: "apple", replacement: "x", context_before: "missing" },
    { match_text: "aa", replacement: "x" },
  ]) {
    const { doc, id } = fixture("apple apple aaa");
    const before = A.getHeads(doc);
    assert.throws(
      () =>
        A.change(doc, (draft) =>
          applyPageOperation(draft, {
            operation: "patch_page",
            arguments: {
              operations: [
                { op: "set_title", title: "Must roll back" },
                { op: "replace_match", block_id: id, ...input },
              ],
            },
          }),
        ),
      /exactly one is required/,
    );
    assert.deepEqual(A.getHeads(doc), before);
    assert.equal(doc.title, "Original");
    assert.equal(projectPage(doc).blocks[0].markdown, "apple apple aaa");
  }
});

test("rich structural markers and embedded nodes cannot be matched or deleted", () => {
  for (const markdown of [
    "before\n\nafter",
    "before ![image](https://example.com/image.png) after",
    "before  \nafter",
  ]) {
    const { doc, id } = fixture(markdown);
    const raw = doc.blocks[id].richText;
    assert.ok(raw.includes("\ufffc"));
    assert.throws(
      () => replace(A.clone(doc), id, { match_text: raw, replacement: "flatten" }),
      /found 0 matches/,
    );
    assert.throws(
      () => replace(A.clone(doc), id, { match_text: "\ufffc", replacement: "" }),
      /found 0 matches/,
    );
    assert.throws(
      () =>
        replace(A.clone(doc), id, {
          match_text: "after",
          replacement: "changed",
          context_before: "before",
        }),
      /found 0 matches/,
    );
    assert.equal(doc.blocks[id].richText, raw);
  }
});

test("replacement is literal text, can delete a match, and leaves the next paragraph intact", () => {
  const { doc, id } = fixture("Keep word here.\n\nOther paragraph.");
  const { after } = replace(doc, id, { match_text: "word", replacement: "**literal** $1" });
  assert.ok(richDoc(after.blocks[id]).textContent.includes("**literal** $1"));
  const deleted = replace(after, id, { match_text: "**literal** $1 ", replacement: "" }).after;
  assert.equal(projectPage(deleted).blocks[0].markdown, "Keep here.\n\nOther paragraph.");
});

test("targeted replacement merges with concurrent edits to untouched characters", () => {
  const { doc, id } = fixture("First target. Last text.");
  const left = replace(A.clone(doc), id, { match_text: "target", replacement: "edited" }).after;
  const right = A.change(A.clone(doc), (draft) =>
    A.splice(draft, textPath(id), draft.blocks[id].richText.indexOf("Last"), 0, "New "),
  );
  const merged = A.merge(left, right);
  assert.equal(projectPage(merged).blocks[0].markdown, "First edited. New Last text.");
});

test("matching rejects malformed or unbounded requests before editing", () => {
  const { doc, id } = fixture("small");
  for (const input of [
    { match_text: "", replacement: "x" },
    { match_text: null, replacement: "x" },
    { match_text: "small" },
    { match_text: "small", replacement: "x", context_before: 1 },
    { match_text: "small", replacement: "x".repeat(262145) },
  ])
    assert.throws(() => replace(A.clone(doc), id, input));
  const many = fixture("a".repeat(10001));
  assert.throws(
    () => replace(many.doc, many.id, { match_text: "a", replacement: "b" }),
    /Too many matches/,
  );
});

test("whole formatted runs preserve their shared marks, including link destinations and titles", () => {
  for (const [source, expected] of [
    ["Before **old words** after.", "Before **new phrase** after."],
    ["Before *old words* after.", "Before *new phrase* after."],
    ["Before `old words` after.", "Before `new phrase` after."],
    [
      'Before [old words](https://example.com "Title") after.',
      'Before [new phrase](https://example.com "Title") after.',
    ],
    [
      'Before [**old words**](https://example.com "Title") after.',
      'Before [**new phrase**](https://example.com "Title") after.',
    ],
  ]) {
    const { doc, id } = fixture(source);
    const { after } = replace(doc, id, { match_text: "old words", replacement: "new phrase" });
    assert.equal(projectPage(after).blocks[0].markdown, expected, source);
    richDoc(after.blocks[id]).check();
  }
});

test("replacement at either link boundary stays linked without absorbing adjacent text", () => {
  for (const [match_text, expected] of [
    ["old", '[new words](https://example.com "Title")'],
    ["words", '[old new](https://example.com "Title")'],
  ]) {
    const { doc, id } = fixture('Before [old words](https://example.com "Title") after.');
    const { after } = replace(doc, id, { match_text, replacement: "new" });
    assert.equal(projectPage(after).blocks[0].markdown, `Before ${expected} after.`);
    const mark = A.marks(after, textPath(id)).find((value) => value.name === "link");
    assert.equal(
      after.blocks[id].richText.slice(mark.start, mark.end),
      "old" === match_text ? "new words" : "old new",
    );
  }
});

test("mixed formatting retains only common marks, leaves neighboring marks unchanged, and reports what it dropped", () => {
  for (const [source, expected, dropped] of [
    ["Before **old** *words* after.", "Before new phrase after.", ["strong", "em"]],
    ["Before **keep old** words after.", "Before **keep** new phrase after.", ["strong"]],
    [
      'Before [old **words**](https://example.com "Title") after.',
      'Before [new phrase](https://example.com "Title") after.',
      ["strong"],
    ],
    ["Before [old](https://example.com) words after.", "Before new phrase after.", ["link"]],
  ]) {
    const { doc, id } = fixture(source);
    const { after, result } = replace(doc, id, {
      match_text: "old words",
      replacement: "new phrase",
    });
    assert.equal(projectPage(after).blocks[0].markdown, expected, source);
    const [edit] = result.edits;
    assert.equal(edit.matched, 1);
    assert.equal(edit.warnings.length, 1, source);
    assert.equal(edit.warnings[0].code, "marks_dropped");
    assert.deepEqual(edit.warnings[0].marks, dropped, source);
  }
});

test("replace_match reports partial marks it dropped, with their ranges in the match", () => {
  // The audit's repro: both code spans sit inside the match, neither covers it.
  const { doc, id } = fixture("The `rotate()` helper is in `worker/keys.mjs`.");
  const match_text = "The rotate() helper is in worker/keys.mjs.";
  const replacement = "The rotateKey() helper is in worker/signing-keys.mjs.";
  const { after, result } = replace(doc, id, { match_text, replacement });
  assert.equal(projectPage(after).blocks[0].markdown, replacement);
  assert.deepEqual(result.edits, [
    {
      op: "replace_match",
      block_id: id,
      matched: 1,
      warnings: [
        {
          code: "marks_dropped",
          marks: ["code"],
          ranges: [
            { mark: "code", start: 4, end: 12 },
            { mark: "code", start: 26, end: 41 },
          ],
          suggested_action:
            "The replacement is plain where these marks covered only part of the match. If it should keep them, apply format_match over the right ranges of the new text.",
        },
      ],
    },
  ]);
  for (const range of result.edits[0].warnings[0].ranges)
    assert.ok(["rotate()", "worker/keys.mjs"].includes(match_text.slice(range.start, range.end)));

  // A mark reaching past the match is clamped to the part it covered.
  const partial = fixture("Before **keep old** words after.");
  const edge = replace(partial.doc, partial.id, { match_text: "old words", replacement: "x" });
  assert.deepEqual(edge.result.edits[0].warnings[0].ranges, [{ mark: "strong", start: 0, end: 3 }]);

  // Marks shared by the whole match are kept, so nothing is reported; nor is
  // anything reported when the match is deleted.
  for (const [source, input] of [
    ["Before `old words` after.", { match_text: "old words", replacement: "new phrase" }],
    ["Before plain words after.", { match_text: "plain words", replacement: "new phrase" }],
    ["Before **old** *words* after.", { match_text: "old words", replacement: "" }],
  ]) {
    const kept = fixture(source);
    const { result: quiet } = replace(kept.doc, kept.id, input);
    assert.equal(quiet.edits[0].warnings, undefined, source);
  }
});

test("mark reconciliation merges with a peer edit to untouched neighboring text", () => {
  const { doc, id } = fixture('Before [old **words**](https://example.com "Title") after.');
  const afterOffset = doc.blocks[id].richText.indexOf("after");
  const cursor = A.getCursor(doc, textPath(id), afterOffset);
  const tool = replace(A.clone(doc), id, {
    match_text: "old words",
    replacement: "new phrase",
  }).after;
  const human = A.change(A.clone(doc), (draft) =>
    A.splice(draft, textPath(id), afterOffset, 0, "still "),
  );
  const merged = A.merge(tool, human);
  assert.equal(
    projectPage(merged).blocks[0].markdown,
    'Before [new phrase](https://example.com "Title") still after.',
  );
  assert.equal(
    A.getCursorPosition(merged, textPath(id), cursor),
    merged.blocks[id].richText.indexOf("after"),
  );
  assert.deepEqual(
    A.getHeads(A.merge(A.clone(human), A.clone(tool))).sort(),
    A.getHeads(merged).sort(),
  );
});
