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
import { textSplices } from "./replace-match.mjs";

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
  assert.deepEqual(result.edits, [{ op: "replace_match", block_id: id, matched: 1 }]);
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

// A comment on `selected_text`, then one replace_match; returns the anchor's
// projection afterwards.
function anchorAfter(markdown, selected_text, input) {
  const { doc, id } = fixture(markdown);
  const { comments } = comment(doc, newCommentsDoc(), {
    action: "add",
    block_id: id,
    selected_text,
    body: "Keep this",
  });
  const { after } = replace(doc, id, input);
  return { after, context: projectComments(after, comments)[0].selectionContext };
}

test("anchors on words the replacement keeps survive, including a no-op replacement", () => {
  const expanded = anchorAfter("The room has oak table legs in it.", "oak table legs", {
    match_text: "oak table legs in it",
    replacement: "oak table legs and chairs in it",
  });
  assert.equal(
    projectPage(expanded.after).blocks[0].markdown,
    "The room has oak table legs and chairs in it.",
  );
  assert.equal(expanded.context.status, "attached");
  assert.equal(expanded.context.text, "oak table legs");

  const unchanged = anchorAfter("The room has oak table legs in it.", "oak table legs", {
    match_text: "oak table legs in it",
    replacement: "oak table legs in it",
  });
  assert.equal(unchanged.context.status, "attached");
  assert.equal(unchanged.context.text, "oak table legs");
  assert.equal(
    projectPage(unchanged.after).blocks[0].markdown,
    "The room has oak table legs in it.",
  );
});

test("an anchor on a changed word detaches; one that starts in it shrinks to the words left", () => {
  const changed = anchorAfter("The room has oak table legs in it.", "table", {
    match_text: "oak table legs",
    replacement: "oak desk legs",
  });
  assert.equal(projectPage(changed.after).blocks[0].markdown, "The room has oak desk legs in it.");
  assert.equal(changed.context.status, "detached");

  const shrunk = anchorAfter("The room has oak table legs in it.", "table legs", {
    match_text: "oak table legs",
    replacement: "oak desk legs",
  });
  assert.equal(shrunk.context.status, "attached");
  assert.equal(shrunk.context.text, " legs");
});

test("a typo fix inside a commented word keeps the anchor on the characters it had", () => {
  const plural = anchorAfter("The room has oak table legs in it.", "table", {
    match_text: "oak table legs",
    replacement: "oak tables legs",
  });
  assert.equal(projectPage(plural.after).blocks[0].markdown, "The room has oak tables legs in it.");
  assert.equal(plural.context.status, "attached");
  assert.equal(plural.context.text, "table");

  const spelling = anchorAfter("The room has oak tabel legs in it.", "oak tabel legs", {
    match_text: "oak tabel legs",
    replacement: "oak table legs",
  });
  assert.equal(spelling.context.status, "attached");
  assert.equal(spelling.context.text, "oak table legs");
});

test("textSplices keeps shared words, never splits a surrogate pair, and spans the changed words", () => {
  const splices = (before, after) => textSplices(before, after).splices;
  assert.deepEqual(textSplices("same", "same"), { splices: [], changed: null });
  assert.deepEqual(textSplices("oak table legs in it", "oak table legs and chairs in it"), {
    splices: [{ at: 15, remove: 0, insert: "and chairs " }],
    changed: { start: 15, end: 26 },
  });
  assert.deepEqual(textSplices("old words", "new phrase"), {
    splices: [
      { at: 0, remove: 3, insert: "new" },
      { at: 4, remove: 5, insert: "phrase" },
    ],
    changed: { start: 0, end: 10 },
  });
  // The splice is narrowed to the letters that differ; the changed span is the word.
  assert.deepEqual(textSplices("Monday", "Tuesday"), {
    splices: [{ at: 0, remove: 3, insert: "Tues" }],
    changed: { start: 0, end: 7 },
  });
  assert.deepEqual(splices("table", "tables"), [{ at: 5, remove: 0, insert: "s" }]);
  assert.deepEqual(textSplices("drop it", ""), {
    splices: [{ at: 0, remove: 7, insert: "" }],
    changed: { start: 0, end: 0 },
  });
  // 😀 and 😁 share a high surrogate; the whole pair is replaced.
  assert.deepEqual(splices("a 😀 b", "a 😁 b"), [{ at: 2, remove: 2, insert: "😁" }]);
  assert.deepEqual(splices("🌊", "🌋"), [{ at: 0, remove: 2, insert: "🌋" }]);
  assert.deepEqual(splices("x🌊", "y🌊"), [{ at: 0, remove: 1, insert: "y" }]);
  for (const [before, after] of [
    ["a 😀 b", "a 😁 b"],
    ["🌊 Keep 🌳 target", "🌊 Keep 🪴 garden"],
    ["x".repeat(5000), "y".repeat(5000)],
    ["w ".repeat(3000), "v ".repeat(3000)],
  ]) {
    let text = before;
    for (const splice of splices(before, after).reverse())
      text = text.slice(0, splice.at) + splice.insert + text.slice(splice.at + splice.remove);
    assert.equal(text, after);
  }
});

test("unchanged words inside the match keep their own marks; inserted text gets the shared ones", () => {
  for (const [source, input, expected] of [
    [
      "Before **keep old** words after.",
      { match_text: "old words", replacement: "old phrase" },
      "Before **keep old** phrase after.",
    ],
    [
      "Before **old words** after.",
      { match_text: "old words", replacement: "new words" },
      "Before **new words** after.",
    ],
    [
      'Before [old words](https://example.com "Title") after.',
      { match_text: "old words", replacement: "old phrase" },
      'Before [old phrase](https://example.com "Title") after.',
    ],
  ]) {
    const { doc, id } = fixture(source);
    const { after } = replace(doc, id, input);
    assert.equal(projectPage(after).blocks[0].markdown, expected, source);
    richDoc(after.blocks[id]).check();
  }
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

test("mixed formatting retains only common marks and leaves neighboring marks unchanged", () => {
  for (const [source, expected] of [
    ["Before **old** *words* after.", "Before new phrase after."],
    ["Before **keep old** words after.", "Before **keep** new phrase after."],
    [
      'Before [old **words**](https://example.com "Title") after.',
      'Before [new phrase](https://example.com "Title") after.',
    ],
    ["Before [old](https://example.com) words after.", "Before new phrase after."],
  ]) {
    const { doc, id } = fixture(source);
    const { after } = replace(doc, id, { match_text: "old words", replacement: "new phrase" });
    assert.equal(projectPage(after).blocks[0].markdown, expected, source);
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
