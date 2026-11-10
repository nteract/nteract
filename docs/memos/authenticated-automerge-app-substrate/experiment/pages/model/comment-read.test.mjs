import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { build } from "esbuild";
import fc from "fast-check";
import * as candidate from "./comment-content.mjs";
import * as reader from "./comment-read.mjs";
import { allInputs } from "../test/address-inputs.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { captureSelectionTarget } from "./comments.mjs";
import { projectPage } from "./page.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { readTool } from "../worker/tool-reads.mjs";
import { readChangesTool } from "../worker/tool-changes.mjs";
import { nativeRead, nativeReadSpans, readFingerprint, readMarkdown } from "./native-read.mjs";

const S = (value) => new A.ImmutableString(value);
const block = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
const text = (value, marks = {}) => ({ type: "text", value, marks });
const ACTOR = "11223344556677889900aabbccddeeff00";
const PAGE = "11111111-1111-4111-8111-111111111111";
const BLOCK = "22222222-2222-4222-8222-222222222222";
const AUTHOR = { principal: "user:reader", displayName: "Reader", driver: "Test client" };
const AT = "2026-11-07T18:00:00-08:00";
const AUTHORITY = { retry_token: "read-fixture", retry_key_prefix: "fixture_", retry_until: AT };

function richMessage(spans) {
  let doc = A.from({ format: RICH_FORMAT, richText: "" });
  doc = A.change(doc, (draft) => A.updateSpans(draft, ["richText"], spans, updateSpansConfig));
  return doc;
}

function compare(message, name, expected) {
  const before = A.save(message);
  const heads = A.getHeads(message);
  const projected = candidate.commentBodyProjection(message);
  if (expected) assert.deepEqual(projected, expected, name);
  assert.equal(candidate.commentMarkdown(message), projected.body, name);
  const loaded = A.load(before);
  try {
    assert.deepEqual(candidate.commentBodyProjection(loaded), projected, `${name}: save/load`);
  } finally {
    A.free(loaded);
  }
  if (projected.content_error === "rich_text_unavailable")
    assert.equal(
      projected.body,
      typeof message.richText === "string"
        ? message.richText.replaceAll("\ufffc", "\n").trim()
        : "",
      name,
    );
  assert.deepEqual(A.getHeads(message), heads, `${name}: heads`);
  assert.deepEqual(A.save(message), before, `${name}: saved bytes`);
  return projected;
}

test("generated comment text and each supported mark have input-derived Markdown expectations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("alpha", "東京", "naïve", "😀"), { minLength: 1, maxLength: 4 }),
      fc.constantFrom("plain", "strong", "em", "strike", "code", "highlight", "link"),
      (words, mark) => {
        const source = words.join(" ");
        const marks =
          mark === "plain"
            ? {}
            : {
                [mark]:
                  mark === "link"
                    ? JSON.stringify({ href: "/docs", title: "Read me" })
                    : mark === "highlight"
                      ? "green"
                      : true,
              };
        const body = {
          plain: source,
          strong: `**${source}**`,
          em: `*${source}*`,
          strike: `~~${source}~~`,
          code: `\`${source}\``,
          highlight: `<mark data-color="green">${source}</mark>`,
          link: `[${source}](/docs "Read me")`,
        }[mark];
        const doc = richMessage([text(source, marks)]);
        try {
          compare(doc, `${mark}/${source}`, { body, body_format: "markdown" });
        } finally {
          A.free(doc);
        }
      },
    ),
    { seed: 0xc012, numRuns: 100 },
  );
});

test("comment reads preserve stored corpus and generated native frames across save/load", () => {
  for (const { name, spans } of allInputs({ seed: 0xc011, count: 80, maxDepth: 2 })) {
    const doc = richMessage(spans);
    try {
      compare(doc, name);
    } finally {
      A.free(doc);
    }
  }
});

const EXTRA = {
  "code-hard-break": [
    block("code-block"),
    text("one"),
    block("hard-break", [], {}, true),
    text("two"),
  ],
  mermaid: [block("code-block", [], { params: S("mermaid") }), text("graph TD\nA-->B")],
  "legacy-heading": [block("heading", [], { level: 9 }), text("title")],
  "unsafe-link": [text("label", { link: JSON.stringify({ href: "javascript:alert(1)" }) })],
  "bad-link-json": [text("original", { link: "not-json" })],
  "image-title": [
    block(
      "image",
      [],
      { src: S("https://example.org/i.png"), alt: S("alt"), title: S('say "hi"') },
      true,
    ),
  ],
  "local-dataframe": [
    block("dataframe", [], {
      src: S(`/api/pages/${PAGE}/assets/${"a".repeat(64)}`),
      media_type: S("application/vnd.apache.parquet"),
      title: S("Rows"),
    }),
  ],
};

test("legacy and corrupt rich comments retain their Markdown or plain fallback", () => {
  for (const [name, spans] of Object.entries(EXTRA)) {
    const doc = richMessage(spans);
    try {
      compare(doc, name);
    } finally {
      A.free(doc);
    }
  }
  for (const type of ["paragraph", "heading", "code-block", "future"]) {
    for (const parents of [[], ["blockquote"], [S("blockquote")]]) {
      const doc = richMessage([
        { type: "block", value: { type, parents, attrs: { level: 2 }, isEmbed: false } },
        text("original"),
      ]);
      try {
        compare(doc, `string marker ${type}/${JSON.stringify(parents)}`);
      } finally {
        A.free(doc);
      }
    }
  }
});

test("legacy stored scalar attributes keep the actual comment Markdown contract", () => {
  const fields = {
    image: ["src", "alt", "title"],
    dataframe: ["src", "media_type", "title"],
    "pages-opaque": ["node_type"],
    heading: ["level"],
    "ordered-list-item": ["order"],
    "task-list-item": ["checked"],
    "code-block": ["params"],
  };
  for (const [type, keys] of Object.entries(fields)) {
    for (const value of [null, false, true, 0, "", 1, {}, [], "custom"]) {
      const doc = richMessage([
        block(type, [], Object.fromEntries(keys.map((key) => [key, value])), type === "image"),
        text("original"),
      ]);
      try {
        compare(doc, `stored ${type} ${JSON.stringify(value)}`);
      } finally {
        A.free(doc);
      }
    }
  }
});

test("malformed container and embed frames never lose source text", () => {
  const types = [
    "paragraph",
    "heading",
    "code-block",
    "blockquote",
    "unordered-list-item",
    "task-list-item",
    "table",
    "table-row",
    "table-cell",
    "future",
  ];
  for (const parent of types) {
    for (const child of [...types, "horizontal-rule", "dataframe"]) {
      for (const embed of [false, true]) {
        const doc = richMessage([
          block(parent),
          text("before"),
          block(child, [parent], {}, embed),
          text("after"),
        ]);
        try {
          const name = `${parent}/${child}/${embed}`;
          const projected = compare(doc, name);
          assert.ok(projected.body.includes("before"), `${name}: before survives`);
          assert.ok(projected.body.includes("after"), `${name}: after survives`);
          assert.ok(
            projected.body.indexOf("before") < projected.body.indexOf("after"),
            `${name}: source order`,
          );
        } finally {
          A.free(doc);
        }
      }
    }
  }
});

test("representative malformed comments have explicit notice or plain-fallback outcomes", () => {
  const cases = [
    {
      name: "unknown block retains following text",
      spans: [block("future"), text("after")],
      expected: { body: "\\[Unsupported node: future\\]\n\nafter", body_format: "markdown" },
    },
    {
      name: "nested paragraph under heading falls back without losing text",
      spans: [
        block("heading", [], { level: 2 }),
        text("before"),
        block("paragraph", ["heading"]),
        text("after"),
      ],
      expected: {
        body: "before\nafter",
        body_format: "plain",
        content_error: "rich_text_unavailable",
      },
    },
    {
      name: "table missing row falls back without losing text",
      spans: [block("table"), text("before"), block("table-cell", ["table"]), text("after")],
      expected: {
        body: "before\nafter",
        body_format: "plain",
        content_error: "rich_text_unavailable",
      },
    },
    {
      name: "known block stored as embed in text falls back",
      spans: [
        block("paragraph"),
        text("before"),
        block("heading", ["paragraph"], { level: 2 }, true),
        text("after"),
      ],
      expected: {
        body: "before\nafter",
        body_format: "plain",
        content_error: "rich_text_unavailable",
      },
    },
    {
      name: "orphan dataframe missing asset metadata falls back",
      spans: [block("dataframe"), text("after")],
      expected: { body: "after", body_format: "plain", content_error: "rich_text_unavailable" },
    },
    {
      name: "mutable marker names remain ordinary text",
      spans: [
        {
          type: "block",
          value: { type: "heading", parents: [], attrs: { level: 2 }, isEmbed: false },
        },
        text("after"),
      ],
      expected: { body: "after", body_format: "markdown" },
    },
  ];
  for (const { name, spans, expected } of cases) {
    const doc = richMessage(spans);
    try {
      compare(doc, name, expected);
    } finally {
      A.free(doc);
    }
  }
});

test("legacy block and embed boundaries retain empty nodes and refusal semantics", () => {
  const types = [
    "paragraph",
    "heading",
    "code-block",
    "blockquote",
    "unordered-list-item",
    "task-list-item",
    "table",
    "table-row",
    "table-cell",
    "future",
    "dataframe",
    "horizontal-rule",
  ];
  for (const parent of [null, ...types]) {
    for (const child of [...types, "hard-break", "image"]) {
      for (const embed of [false, true]) {
        for (const tail of [[], [text("after")]]) {
          const doc = richMessage([
            ...(parent ? [block(parent)] : []),
            block(
              child,
              [],
              child === "image" ? { src: S("https://example.org/image.png") } : {},
              embed,
            ),
            ...tail,
          ]);
          try {
            compare(doc, `boundary ${parent}/${child}/${embed}/${tail.length}`);
          } finally {
            A.free(doc);
          }
        }
      }
    }
  }
});

test("mixed mutable markers and future-node fallback retain actual base comment reads", () => {
  const type = fc.constantFrom(
    "paragraph",
    "heading",
    "code-block",
    "blockquote",
    "unordered-list-item",
    "task-list-item",
    "table",
    "table-row",
    "table-cell",
    "future",
    "dataframe",
    "horizontal-rule",
    "hard-break",
    "image",
  );
  fc.assert(
    fc.property(
      fc.record({
        prefix: fc.option(type, { nil: null }),
        type,
        embed: fc.boolean(),
        parent: fc.option(type, { nil: null }),
        stringType: fc.boolean(),
        stringParent: fc.boolean(),
        tail: fc.boolean(),
      }),
      (input) => {
        const frame = block(
          input.type,
          input.parent ? [input.parent] : [],
          input.type === "image"
            ? { src: S("https://example.org/i.png") }
            : input.type === "dataframe"
              ? EXTRA["local-dataframe"][0].value.attrs
              : {},
          input.embed,
        );
        if (input.stringType) frame.value.type = input.type;
        if (input.stringParent) frame.value.parents = input.parent ? [input.parent] : [];
        const doc = richMessage([
          ...(input.prefix ? [block(input.prefix), text("before")] : []),
          frame,
          ...(input.tail ? [text("after")] : []),
        ]);
        try {
          compare(doc, JSON.stringify(input));
        } finally {
          A.free(doc);
        }
      },
    ),
    { seed: 0xcafe, numRuns: 1000 },
  );
});

test("direct reader is the exported implementation and its full import graph excludes PM", async () => {
  for (const name of [
    "commentBodyProjection",
    "commentMarkdown",
    "commentMessageState",
    "commentThreadState",
    "isStoredFormMessage",
  ])
    assert.equal(candidate[name], reader[name], `${name} is not a separate facade`);
  const result = await build({
    entryPoints: [new URL("./comment-read.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    metafile: true,
    treeShaking: false,
    platform: "browser",
    format: "esm",
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).filter((path) =>
      /prosemirror|pm-adapter|pm-markdown-parser|richtext-spans|markdown-import|comment-content/.test(
        path,
      ),
    ),
    [],
  );
});

test("native span entry preserves the block reader and never edits source frames", () => {
  const doc = richMessage([
    text("intro"),
    block("blockquote"),
    block("future", ["blockquote"]),
    text("source"),
    ...EXTRA["code-hard-break"],
  ]);
  try {
    const saved = A.save(doc),
      spans = A.spans(doc, ["richText"]);
    const input = JSON.stringify(spans);
    const direct = nativeRead(doc),
      fromSpans = nativeReadSpans(spans);
    for (const read of [direct, fromSpans]) {
      assert.equal(readMarkdown(read.nodes), readMarkdown(direct.nodes));
      assert.deepEqual(
        read.nodes.map((node) => readFingerprint(node, read.metadata)),
        direct.nodes.map((node) => readFingerprint(node, direct.metadata)),
      );
      assert.deepEqual(
        read.nodes.map((node) => read.source.get(node)),
        direct.nodes.map((node) => direct.source.get(node)),
      );
    }
    assert.equal(JSON.stringify(spans), input);
    assert.deepEqual(A.save(doc), saved);
  } finally {
    A.free(doc);
  }
});

test("read tolerance never changes writer limits or admits reader-only forms", () => {
  for (const spans of [
    [text("x".repeat(candidate.COMMENT_MAX_LENGTH + 1))],
    EXTRA["local-dataframe"],
    [block("future"), text("source")],
    [block("heading", [], { level: 9 }), text("legacy")],
    [text("label", { link: JSON.stringify({ href: "https://example.org", private: "kept" }) })],
  ]) {
    const doc = richMessage(spans);
    try {
      compare(doc, "readable but inadmissible");
      assert.throws(() => candidate.validateCommentSpans(A.spans(doc, ["richText"])));
    } finally {
      A.free(doc);
    }
  }
  for (const bytes of [candidate.COMMENT_MAX_SOURCE, candidate.COMMENT_MAX_SOURCE + 1]) {
    const doc = richMessage([
      text("long", { link: JSON.stringify({ href: `https://example.org/${"x".repeat(bytes)}` }) }),
    ]);
    try {
      compare(doc, `large Markdown ${bytes}`);
      assert.throws(() => candidate.validateCommentSpans(A.spans(doc, ["richText"])));
    } finally {
      A.free(doc);
    }
  }
});

test("unsupported forms, literal bodies, old states and tombstones retain baseline semantics", () => {
  const messages = [
    {},
    { body: "old text" },
    { format: RICH_FORMAT, body: "old copy", richText: "source" },
    { format: RICH_FORMAT, richText: ["corrupt"] },
    { format: RICH_FORMAT, richText: "  literal **text**\n", bodyFormat: "plain" },
    { format: RICH_FORMAT, richText: "stored", deletedAt: AT },
    ...["open", "resolved", "deleted", ""].flatMap((status) => [
      { status },
      { status: { value: status, at: AT } },
    ]),
  ];
  for (const [index, message] of messages.entries()) {
    const doc = A.from(message);
    try {
      compare(doc, `stored form ${index}`);
    } finally {
      A.free(doc);
    }
  }
});

function apiFixture() {
  let page = A.init({ actor: ACTOR });
  page = A.change(page, { time: 0 }, (draft) => {
    draft.page_id = PAGE;
    draft.title = "Comment read contract";
    draft.blocks = {
      [BLOCK]: {
        id: BLOCK,
        kind: "markdown",
        position: "a0",
        format: RICH_FORMAT,
        markdown: "",
        richText: "Keep this passage.",
        metadata: {},
      },
    };
    draft.schema = { features: ["comments-doc"] };
  });
  const target = captureSelectionTarget(page, BLOCK, "this passage");
  let comments = A.init({ actor: ACTOR });
  comments = A.change(comments, { time: 0 }, (draft) => {
    draft.threads = {};
  });
  const since = A.getHeads(comments);
  comments = A.change(comments, { time: 0 }, (draft) => {
    const message = (richText, extra = {}) => ({
      format: RICH_FORMAT,
      richText,
      author: AUTHOR,
      createdAt: AT,
      deletedAt: null,
      ...extra,
    });
    draft.threads.thread = {
      target,
      author: AUTHOR,
      createdAt: AT,
      status: "open",
      messages: {
        native: message(""),
        plain: message("  literal **text**\n", { bodyFormat: "plain" }),
        old: { body: "not migrated", author: AUTHOR, createdAt: AT },
        stale: message("native copy", { body: "outdated Markdown copy" }),
        bad: message(""),
        code: message(""),
        tombstone: message("deleted source", { deletedAt: AT }),
      },
    };
    A.updateSpans(
      draft,
      ["threads", "thread", "messages", "native", "richText"],
      [
        text("marked", { strong: true, em: true }),
        block("task-list-item", [], { checked: true }),
        text("task"),
      ],
      updateSpansConfig,
    );
    A.updateSpans(
      draft,
      ["threads", "thread", "messages", "bad", "richText"],
      EXTRA["bad-link-json"],
      updateSpansConfig,
    );
    A.updateSpans(
      draft,
      ["threads", "thread", "messages", "code", "richText"],
      EXTRA["code-hard-break"],
      updateSpansConfig,
    );
    draft.threads.resolved = {
      target: { kind: "block", blockId: BLOCK },
      author: AUTHOR,
      createdAt: AT,
      status: "resolved",
      messages: { reply: message("resolved source") },
    };
    draft.threads.deleted = {
      target,
      author: AUTHOR,
      createdAt: AT,
      status: { value: "deleted", at: AT },
      messages: { reply: message("hidden source") },
    };
  });
  return { page, comments, since };
}

test("comment reads report each stored form's outcome and change neither document", async () => {
  const { page, comments, since } = apiFixture();
  try {
    const saved = [A.save(page), A.save(comments)];
    const heads = [A.getHeads(page), A.getHeads(comments)];
    const options = { commentsDoc: comments, issueAuthority: async () => AUTHORITY };
    const deltaArgs = { since_heads: heads[0], since_comment_heads: since };
    projectPage(page, comments);
    const compact = projectReadComments(page, { state: "all" }, comments);
    projectReadComments(page, { state: "all", include_messages: false }, comments);
    projectReadChanges(page, deltaArgs, comments);
    projectReadChanges(page, { since_heads: heads[0] }, comments);
    await readTool(page, "read_page", { page_id: PAGE }, options);
    await readTool(page, "read_page", { comments: "all" }, options);
    const list = await readTool(page, "list_page_comments", { state: "all" }, options);
    await readChangesTool(page, deltaArgs, options);
    // The tool returns the model's projection, and each stored form has one
    // outcome: Markdown, the literal text, or an empty body with its reason.
    const threads = list.body.comments;
    assert.deepEqual(threads, JSON.parse(JSON.stringify(compact)));
    assert.deepEqual(
      threads.map(({ id, state }) => [id, state]),
      [
        ["thread", null],
        ["resolved", null],
        ["deleted", "deleted"],
      ],
    );
    const outcome = ({ body, body_format, content_error }) =>
      JSON.parse(JSON.stringify({ body, body_format, content_error }));
    assert.deepEqual(
      Object.fromEntries(threads[0].messages.map((message) => [message.id, outcome(message)])),
      {
        bad: { body: "[original]()", body_format: "markdown" },
        code: { body: "one\ntwo", body_format: "plain", content_error: "rich_text_unavailable" },
        native: { body: "***marked***\n\n- [x] task", body_format: "markdown" },
        old: { body: "", body_format: "plain", content_error: "stored_form_unsupported" },
        plain: { body: "  literal **text**\n" },
        stale: { body: "", body_format: "plain", content_error: "stored_form_unsupported" },
        tombstone: {},
      },
    );
    assert.equal(threads[0].messages.find(({ id }) => id === "tombstone").deletedAt, AT);
    assert.deepEqual([A.getHeads(page), A.getHeads(comments)], heads);
    assert.deepEqual([A.save(page), A.save(comments)], saved);
  } finally {
    A.free(page);
    A.free(comments);
  }
});
