import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import fc from "fast-check";
import { build } from "esbuild";
import { commentBodyProjection } from "./comment-read.mjs";
import * as baseline from "../test/comment-read-baseline.mjs";
import { readTool } from "../worker/tool-reads.mjs";
import { readChangesTool } from "../worker/tool-changes.mjs";
import { projectPage } from "./page.mjs";
import { projectReadComments } from "./read-comments.mjs";
import {
  BASE,
  BLOCK,
  ASSET,
  DATAFRAME,
  B,
  T,
  cases,
  reviewFixture,
  apiSnapshots,
  actualBaseApi,
} from "../test/comment-read-review-fixtures.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";
import { updateSpansConfig } from "./marks.mjs";

const api = { readTool, readChangesTool, projectPage, projectReadComments };
const json = (value) => JSON.parse(JSON.stringify(value));
function compareSpans(spans) {
  let doc = A.from({ format: RICH_FORMAT, richText: "" });
  doc = A.change(doc, (draft) => A.updateSpans(draft, ["richText"], spans, updateSpansConfig));
  try {
    const saved = A.save(doc),
      heads = A.getHeads(doc),
      cursor = A.getCursor(doc, ["richText"], 0);
    assert.deepEqual(
      commentBodyProjection(doc),
      baseline.commentBodyProjection(doc),
      JSON.stringify(spans),
    );
    assert.deepEqual(A.save(doc), saved);
    assert.deepEqual(A.getHeads(doc), heads);
    assert.equal(A.getCursor(doc, ["richText"], 0), cursor);
  } finally {
    A.free(doc);
  }
}
function identities({ page, comments }) {
  const thread = comments.threads.review;
  const paths = Object.keys(thread.messages).map((id) => [
    "threads",
    "review",
    "messages",
    id,
    "richText",
  ]);
  const result = {
    page: A.getObjectId(page),
    block: A.getObjectId(page.blocks[BLOCK]),
    pageText: A.getObjectId(page.blocks[BLOCK], "richText"),
    thread: A.getObjectId(thread),
    target: A.getObjectId(thread.target),
    anchor: json(thread.target),
    messages: Object.values(thread.messages).map((message) => [
      A.getObjectId(message),
      A.getObjectId(message, "richText"),
      A.getObjectId(message.author),
    ]),
    cursors: paths.map((path) => A.getCursor(comments, path, 0)),
    frames: paths.map((path) => A.spans(comments, path)),
  };
  for (const id of [
    result.page,
    result.block,
    result.pageText,
    result.thread,
    result.target,
    ...result.messages.flat(),
  ])
    assert.equal(typeof id, "string", "native object identities must exist");
  assert.equal(result.anchor.kind, "selection");
  assert.equal(result.anchor.anchor.textObjectId, result.pageText);
  assert.equal(result.anchor.head.textObjectId, result.pageText);
  return result;
}

for (const [name, input] of Object.entries(cases)) {
  test(`P2 ${name} matches the actual-base body`, () => {
    const fixture = reviewFixture({ [name]: input });
    try {
      const message = fixture.comments.threads.review.messages[name];
      const expected = baseline.commentBodyProjection(message);
      if (name === "rootDataframeEmbed")
        assert.equal(expected.body, `[Dataframe](${ASSET})\n\nafter`);
      if (name === "serializationRetry")
        assert.equal(expected.body, "**before**\\[Unsupported node: future\\]*after*");
      if (name.startsWith("invalid"))
        assert.deepEqual(expected, {
          body: "after",
          body_format: "plain",
          content_error: "rich_text_unavailable",
        });
      if (name === "unknownGrouping") assert.equal(expected.body.length, 601);
      const before = A.save(fixture.comments),
        heads = A.getHeads(fixture.comments);
      assert.deepEqual(commentBodyProjection(message), expected);
      assert.deepEqual(A.save(fixture.comments), before);
      assert.deepEqual(A.getHeads(fixture.comments), heads);
    } finally {
      A.free(fixture.page);
      A.free(fixture.comments);
    }
  });
}

test("P2 parent chains retain accepted incomplete forms and refuse impossible transitions", () => {
  const types = [
    "paragraph",
    "heading",
    "code-block",
    "blockquote",
    "aside",
    "unordered-list-item",
    "ordered-list-item",
    "task-list-item",
    "table",
    "table-row",
    "table-cell",
    "table-header",
    "image",
    "horizontal-rule",
    "future",
  ];
  for (const parent of types)
    for (const child of types) compareSpans([B("paragraph", [parent, child]), T("after")]);
  for (const spans of [
    [B("table"), T("table text")],
    [B("table"), B("table-row", ["table"]), T("row text")],
    [B("table"), B("table-cell", ["table", "table-row"]), T("cell text")],
    [B("table"), B("table-cell", ["table", "table-row"])],
    [B("table-cell", [], {}, true), T("implicit wrappers")],
    [B("paragraph", ["table", "table-row", "table-cell"]), T("not inline")],
  ])
    compareSpans(spans);
});

test("P2 dataframe embeds use active context without admitting malformed stored parents", () => {
  for (const prefix of [
    [],
    [B("blockquote")],
    [B("table")],
    [B("table-cell", ["table", "table-row"])],
    [B("code-block")],
    [B("future-root")],
    [T("before", { strong: true })],
  ]) {
    for (const parents of [
      [],
      ["table-cell"],
      ["table", "table-row", "table-cell"],
      ["code-block"],
      ["future"],
      ["table-cell", "aside"],
    ]) {
      for (const attrs of [DATAFRAME, {}])
        for (const embed of [true, false])
          compareSpans([
            ...prefix,
            B("dataframe", parents, attrs, embed),
            T("after", { em: true }),
          ]);
    }
  }
});

test("P2 generic unknown grouping preserves first notices across nested and empty wrappers", () => {
  for (const spans of [
    [B("future-root"), B("future-other")],
    [B("future-root"), B("paragraph", ["future-other"]), T("after")],
    [
      B("paragraph", ["alpha"]),
      T("one"),
      B("paragraph", ["beta"]),
      T("two"),
      B("paragraph", ["alpha"]),
      T("three"),
    ],
    [
      B("future-root"),
      T("before"),
      B("blockquote", ["future-other"]),
      T("quoted"),
      B("paragraph", ["future-last"]),
      T("after"),
    ],
    [
      B("future-root"),
      T("before"),
      B("future-child", ["future-parent"]),
      T("nested"),
      B("paragraph", ["future-a", "future-b"]),
      T("after"),
    ],
    [
      B("blockquote"),
      B("future-root", ["blockquote"]),
      B("paragraph", ["blockquote", "future-new"]),
      T("nested"),
      B("paragraph"),
      T("root"),
    ],
    [B("future-root"), B("future-child", ["future-a"]), B("paragraph", ["future-b", "future-c"])],
  ])
    compareSpans(spans);
});

test("P2 unknown-inline code fallback applies to earlier and later unknown groups", async () => {
  const baseApi = await actualBaseApi();
  const inputs = {};
  for (const parents of [[], ["table-cell"], ["code-block"]]) {
    const root = [B("future-root"), T("first", { strong: true })];
    const code = [B("code-block"), T("before"), B("future-widget", parents, {}, true), T("after")];
    inputs[`rootFirst${parents}`] = [...root, ...code];
    inputs[`rootLast${parents}`] = [...code, ...root];
    inputs[`bothSides${parents}`] = [...root, ...code, B("future-last"), T("last", { em: true })];
  }
  const fixture = reviewFixture(inputs);
  try {
    const saved = [A.save(fixture.page), A.save(fixture.comments)],
      ids = identities(fixture);
    for (const message of Object.values(fixture.comments.threads.review.messages))
      assert.deepEqual(commentBodyProjection(message), baseline.commentBodyProjection(message));
    assert.deepEqual(
      json(await apiSnapshots(api, fixture)),
      json(await apiSnapshots(baseApi, fixture)),
    );
    assert.deepEqual([A.save(fixture.page), A.save(fixture.comments)], saved);
    assert.deepEqual(identities(fixture), ids);
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});

test("P2 generated accepted unknown stacks retain source labels, marks and empty containers", () => {
  const wrapper = fc.constantFrom("future-a", "future-b", "blockquote", "unordered-list-item");
  const entry = fc.record({
    parents: fc.array(wrapper, { maxLength: 3 }),
    explicit: fc.boolean(),
    empty: fc.boolean(),
  });
  fc.assert(
    fc.property(fc.array(entry, { minLength: 2, maxLength: 12 }), (entries) => {
      compareSpans(
        entries.flatMap((entry, i) => [
          B(entry.explicit ? `future-${i % 3}` : "paragraph", entry.parents),
          ...(entry.empty ? [] : [T(`entry${i}`, i % 2 ? { em: true } : { strong: true })]),
        ]),
      );
    }),
    { seed: 0xc055, numRuns: 600 },
  );
});

test("P2 compatibility retry covers serialization exactly once and never retries unrelated faults", async () => {
  const source = new URL("./comment-read.mjs", import.meta.url).pathname;
  let mode = "once",
    attempts = 0;
  const read = async () => {
    const native = await import("./native-read.mjs");
    const shim = `export * from ${JSON.stringify(import.meta.resolve("./native-read.mjs"))};
      import { readMarkdown as real } from ${JSON.stringify(import.meta.resolve("./native-read.mjs"))};
      export const readMarkdown = (nodes) => globalThis[${JSON.stringify(key)}](real, nodes);`;
    const result = await build({
      entryPoints: [source],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "serializer-fault-boundary",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
              if (!importer) return;
              if (path === "./native-read.mjs")
                return { path: "fault-serializer", namespace: "test" };
              return {
                path: path.startsWith("file:")
                  ? path
                  : path.startsWith(".")
                    ? new URL(path, `file://${importer}`).href
                    : import.meta.resolve(path),
                external: true,
              };
            });
            builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: shim,
              loader: "js",
            }));
          },
        },
      ],
    });
    assert.equal(typeof native.readMarkdown, "function");
    return import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    );
  };
  const key = `commentReadFault${Date.now()}`;
  globalThis[key] = (real, nodes) => {
    attempts++;
    if (mode === "unrelated") throw Error("unrelated serializer fault");
    if (mode === "always" || attempts === 1)
      throw Error("Token type `future` not supported by Markdown renderer");
    return real(nodes);
  };
  const fixture = reviewFixture({ unknown: [B("future"), T("kept", { strong: true })] });
  try {
    const { commentBodyProjection: project } = await read();
    const message = fixture.comments.threads.review.messages.unknown;
    assert.deepEqual(project(message), {
      body: "\\[Unsupported node: future\\]**kept**",
      body_format: "markdown",
    });
    assert.equal(attempts, 2);
    for (mode of ["always", "unrelated"]) {
      attempts = 0;
      assert.deepEqual(project(message), {
        body: "kept",
        body_format: "plain",
        content_error: "rich_text_unavailable",
      });
      assert.equal(attempts, mode === "always" ? 2 : 1);
    }
  } finally {
    delete globalThis[key];
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});

test("P2 generated multi-parent chains, initial embeds and unknown stacks match actual base", () => {
  const type = fc.constantFrom(
    "paragraph",
    "blockquote",
    "aside",
    "code-block",
    "table",
    "table-row",
    "table-cell",
    "table-header",
    "unordered-list-item",
    "future-a",
    "future-b",
    "image",
    "dataframe",
  );
  const frame = fc.record({
    type,
    parents: fc.array(type, { maxLength: 3 }),
    embed: fc.boolean(),
    mutable: fc.boolean(),
    text: fc.boolean(),
  });
  fc.assert(
    fc.property(fc.array(frame, { minLength: 1, maxLength: 4 }), (frames) => {
      compareSpans(
        frames.flatMap((frame, i) => {
          const value = B(
            frame.type,
            frame.parents,
            frame.type === "dataframe"
              ? DATAFRAME
              : frame.type === "image"
                ? { src: "https://example.org/image.png" }
                : {},
            frame.embed,
          );
          if (frame.mutable) value.value.type = frame.type;
          return [
            value,
            ...(frame.text ? [T(`text${i}`, i % 2 ? { strong: true } : { em: true })] : []),
          ];
        }),
      );
    }),
    { seed: 0xc044, numRuns: 2000 },
  );
});

test("P2 actual-base full, compact, delta and budget snapshots preserve native source identities", async () => {
  const fixture = reviewFixture(),
    budget = reviewFixture({ unknownGrouping: cases.unknownGrouping });
  try {
    const before = [fixture, budget].map((f) => ({
      saved: [A.save(f.page), A.save(f.comments)],
      heads: [A.getHeads(f.page), A.getHeads(f.comments)],
      ids: identities(f),
    }));
    const baseApi = await actualBaseApi();
    const expected = {
      base: BASE,
      full: await apiSnapshots(baseApi, fixture),
      budget: await apiSnapshots(baseApi, budget, 4096),
    };
    assert.equal(expected.budget.list.status, 200);
    const path = new URL("./comment-read-review.golden.json", import.meta.url);
    // Recorded from the actual base before product edits; no candidate rewrite mode.
    assert.deepEqual(json(expected), JSON.parse(readFileSync(path, "utf8")));
    const actual = {
      base: BASE,
      full: await apiSnapshots(api, fixture),
      budget: await apiSnapshots(api, budget, 4096),
    };
    assert.deepEqual(json(actual), json(expected));
    for (const [index, f] of [fixture, budget].entries()) {
      assert.deepEqual([A.save(f.page), A.save(f.comments)], before[index].saved);
      assert.deepEqual([A.getHeads(f.page), A.getHeads(f.comments)], before[index].heads);
      assert.deepEqual(identities(f), before[index].ids);
    }
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
    A.free(budget.page);
    A.free(budget.comments);
  }
});
