import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { projectComments } from "../model/comments.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import {
  attribution,
  byDocumentOrder,
  initials,
  isLongBody,
  messageRuns,
  plainText,
  relativeTime,
  threadLocation,
  threadTitle,
} from "./comment-thread-display.mjs";

test("a bold lead-in becomes the title; otherwise the first sentence does", () => {
  assert.deepEqual(threadTitle("**CI handoff:** #4821 is pushed at `458706f86`."), {
    title: "CI handoff",
    lead: true,
  });
  assert.deepEqual(
    threadTitle("**Resumed at Kyle's request, 02:40 UTC.** Two implementation agents"),
    { title: "Resumed at Kyle's request, 02:40 UTC", lead: true },
  );
  assert.deepEqual(
    threadTitle(
      "Should this be a hard gate in the workflow instead of a checklist item? Easy to miss.",
    ),
    {
      title: "Should this be a hard gate in the workflow instead of a checklist item?",
      lead: false,
    },
  );
  assert.deepEqual(threadTitle("Read-only Wrangler login is fine for now. Don't request"), {
    title: "Read-only Wrangler login is fine for now",
    lead: false,
  });
  assert.equal(threadTitle("x".repeat(300)).title.length, 100);
  assert.ok(threadTitle("x".repeat(300)).title.endsWith("…"));
  assert.deepEqual(threadTitle(""), { title: "", lead: false });
  assert.equal(threadTitle("**  **not a lead").lead, false, "an empty lead-in is ordinary text");
  assert.equal(
    threadTitle("- [ ] Check [the docs](https://x.test) *now*").title,
    "Check the docs now",
  );
});

test("plain text drops Markdown syntax but keeps words", () => {
  assert.equal(
    plainText("## Hi\n> **bold** and `code` and <mark>lit</mark>"),
    "Hi bold and code and lit",
  );
  assert.equal(plainText("a\\*b"), "a*b");
});

test("long bodies clamp by length or by line count", () => {
  assert.equal(isLongBody("short"), false);
  assert.equal(isLongBody("x".repeat(321)), true);
  assert.equal(isLongBody("1\n2\n3\n4\n5\n6"), true);
});

test("people and agents read differently, with the full form kept for tooltips", () => {
  const person = attribution({ principal: "a:1", displayName: "Ada Lovelace", driver: "Browser" });
  assert.equal(person.agent, false);
  assert.equal(person.name, "Ada Lovelace");
  assert.equal(person.label, "Ada Lovelace");
  assert.equal(person.initials, "AL");
  assert.match(person.color, /^#/);
  const agent = attribution({ principal: "a:2", displayName: "Kyle Kelley", driver: "Kilo" });
  assert.deepEqual(
    [agent.agent, agent.name, agent.onBehalfOf, agent.label, agent.personInitials],
    [true, "Kilo", "Kyle", "Kilo on behalf of Kyle Kelley", "KK"],
  );
  assert.equal(attribution(undefined).name, "Collaborator");
  assert.equal(initials("claude-code"), "CC");
  assert.equal(initials(""), "?");
});

test("relative times step from minutes to days to dates", () => {
  const now = Date.parse("2026-11-05T05:55:00Z");
  assert.equal(relativeTime("2026-11-05T05:54:30Z", now), "now");
  assert.equal(relativeTime("2026-11-05T05:43:00Z", now), "12m");
  assert.equal(relativeTime("2026-11-05T02:40:00Z", now), "3h");
  assert.equal(relativeTime("2026-11-02T05:55:00Z", now), "3d");
  assert.notEqual(relativeTime("2026-10-01T05:55:00Z", now), "");
  assert.equal(relativeTime("not a time", now), "");
});

test("consecutive messages from one author within five minutes share a run", () => {
  const kyle = { principal: "k", displayName: "Kyle Kelley", driver: "Browser" };
  const kilo = { principal: "k", displayName: "Kyle Kelley", driver: "Kilo" };
  const runs = messageRuns([
    { id: 1, author: kyle, createdAt: "2026-11-05T05:41:00Z" },
    { id: 2, author: kyle, createdAt: "2026-11-05T05:44:00Z" },
    { id: 3, author: kilo, createdAt: "2026-11-05T05:45:00Z" },
    { id: 4, author: kyle, createdAt: "2026-11-05T05:46:00Z" },
    { id: 5, author: kyle, createdAt: "2026-11-05T06:00:00Z" },
  ]);
  assert.deepEqual(
    runs.map((run) => run.messages.map((m) => m.id)),
    [[1, 2], [3], [4], [5]],
  );
});

function fixture() {
  let doc = A.from(createPageData({ pageId: "page_display", title: "Focus" }));
  doc = A.change(doc, (d) =>
    initializePage(
      d,
      [
        "Intro before any heading.",
        "",
        "## Tonight: execute in stages",
        "",
        "**Execution update:** Kyle authorized live infrastructure.",
        "",
        "### Parallel preparation",
        "",
        "| Lane | Gate |",
        "| --- | --- |",
        "| Infrastructure | Both SSM records report ConnectionLost |",
        "",
        "## Next: administration and design",
        "",
        "- [ ] Inventory lab1/node2 SSM registration",
        "- [ ] Decide the Cloudflare deployment design",
      ].join("\n"),
    ),
  );
  const id = orderedBlockIds(doc)[0];
  const identity = { principal: "account:k", displayName: "Kyle Kelley", driver: "Kilo" };
  let comments = newCommentsDoc();
  const add = (input) => {
    comments = comment(doc, comments, { action: "add", block_id: id, ...input }, identity).comments;
  };
  add({ body: "Decide soon", selected_text: "Decide the Cloudflare deployment design" });
  add({ body: "Intro note", selected_text: "Intro before" });
  add({ body: "SSM?", selected_text: "ConnectionLost" });
  add({ body: "**Execution:** noted", selected_text: "Execution update" });
  add({ body: "Whole block" });
  return { doc, id, threads: projectComments(doc, comments) };
}

test("threads locate by heading path and sort in document order", () => {
  const { doc, threads } = fixture();
  const located = threads
    .filter((t) => t.target.kind === "selection")
    .map((thread) => ({ thread, ...threadLocation(doc, thread) }))
    .sort(byDocumentOrder);
  assert.deepEqual(
    located.map((l) => [l.anchor.text, l.headings]),
    [
      ["Intro before", []],
      ["Execution update", ["Tonight: execute in stages"]],
      ["ConnectionLost", ["Tonight: execute in stages", "Parallel preparation"]],
      ["Decide the Cloudflare deployment design", ["Next: administration and design"]],
    ],
  );
});

test("a block comment names the block; a removed block reads as detached", () => {
  const { doc, threads } = fixture();
  const block = threads.find((t) => t.target.kind === "block");
  const location = threadLocation(doc, block);
  assert.equal(location.anchor.kind, "block");
  assert.equal(location.anchor.label, "Paragraph");
  const gone = threadLocation(doc, { ...block, target: { kind: "block", blockId: "missing" } });
  assert.deepEqual(gone.anchor, { kind: "detached", blockSurvives: false });
  assert.ok(gone.order[0] > location.order[0], "missing blocks sort last");
  const detached = threadLocation(doc, {
    target: { kind: "selection", anchor: { blockId: block.target.blockId } },
    selectionContext: { status: "detached" },
  });
  assert.deepEqual(detached.anchor, { kind: "detached", blockSurvives: true });
});

test("threadPreview continues after a lead-in or first sentence", async () => {
  const { threadPreview } = await import("./comment-thread-display.mjs");
  assert.equal(threadPreview("**CI handoff:** #4821 is pushed."), "#4821 is pushed.");
  assert.equal(
    threadPreview("Is March realistic? The queue has 40 items."),
    "The queue has 40 items.",
  );
  assert.equal(threadPreview("One sentence only"), "");
});

test("passageExcerpt keeps the paragraph around a passage and clips at words", async () => {
  const { passageExcerpt } = await import("./comment-thread-display.mjs");
  const text = "Heading\ufffcThe plan moves the launch to March and keeps the beta open.\ufffcNext";
  const from = text.indexOf("launch"),
    to = from + "launch to March".length;
  const rich = { format: "automerge-rich-text-v1" };
  const doc = { blocks: { b: { ...rich, richText: text } } };
  const thread = {
    target: { kind: "selection" },
    selectionContext: {
      status: "attached",
      text: "launch to March",
      start: { blockId: "b", offsetUtf16: from },
      end: { blockId: "b", offsetUtf16: to },
    },
  };
  assert.deepEqual(passageExcerpt(doc, thread), {
    before: "The plan moves the ",
    passage: "launch to March",
    after: " and keeps the beta open.",
  });
  const clipped = passageExcerpt(doc, thread, { before: 8, after: 10 });
  assert.equal(clipped.before, "…the ");
  assert.equal(clipped.after, " and…");
  assert.equal(
    passageExcerpt(doc, {
      target: { kind: "selection" },
      selectionContext: { status: "detached" },
    }),
    null,
  );
  assert.deepEqual(
    passageExcerpt(
      { blocks: { t: { ...rich, richText: "a\ufffcb" } } },
      { target: { kind: "block", blockId: "t" } },
    ).passage,
    "a b",
  );
  // A block without rich text is in a form this build doesn't read.
  assert.equal(
    passageExcerpt(
      { blocks: { t: { markdown: "| a | b |" } } },
      { target: { kind: "block", blockId: "t" } },
    ),
    null,
  );
});

test("replyAuthors lists distinct repliers, newest first", async () => {
  const { replyAuthors } = await import("./comment-thread-display.mjs");
  const a = { principal: "a", displayName: "Ada", driver: "Browser" };
  const k = { principal: "k", displayName: "Kyle", driver: "Kilo" };
  const msgs = [{ author: a }, { author: k }, { author: a }, { author: k }];
  assert.deepEqual(
    replyAuthors(msgs).map((x) => x.displayName),
    ["Kyle", "Ada"],
  );
});
