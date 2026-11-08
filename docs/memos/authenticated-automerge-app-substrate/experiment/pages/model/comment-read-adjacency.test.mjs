import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import * as A from "@automerge/automerge";
import {
  B,
  T,
  S,
  BLOCK,
  DATAFRAME,
  reviewFixture,
  apiSnapshots,
  actualBaseApi,
} from "../test/comment-read-review-fixtures.mjs";
import { adapter, pmDocFromSpans } from "./pm-adapter.mjs";
import { exportMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked, RICH_FORMAT } from "./richtext-format.mjs";
import { nativeReadSpans, readMarkdown } from "./native-read.mjs";
import { commentBodyProjection as baseProjection } from "../test/comment-read-baseline.mjs";
import { commentBodyProjection } from "./comment-read.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { readTool } from "../worker/tool-reads.mjs";
import { readChangesTool } from "../worker/tool-changes.mjs";
import { projectPage } from "./page.mjs";
import { projectReadComments } from "./read-comments.mjs";

const api = { readTool, readChangesTool, projectPage, projectReadComments };
const json = (value) => JSON.parse(JSON.stringify(value));

// Instrument unmodified modules in memory. These diagnostic exports never
// enter the production reader or its PM-free import graph.
async function stages(name, exports) {
  const source = new URL(name, import.meta.url);
  const { outputFiles } = await build({
    stdin: {
      contents: `${readFileSync(source, "utf8")}\nexport { ${exports.join(", ")} };`,
      resolveDir: new URL("./", source).pathname,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "external-stage-imports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path }) => ({
            path: path.startsWith(".") ? new URL(path, source).href : import.meta.resolve(path),
            external: true,
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
}

test("adjacent malformed embed records both projection attempts and exact refusal stage", async (context) => {
  const leaf = B("dataframe", [], DATAFRAME);
  leaf.value.parents = [[]];
  const embed = B("future", [], {}, true);
  embed.value.type = "future";
  const fixture = reviewFixture({ adjacent: [leaf, embed] });
  try {
    const message = fixture.comments.threads.review.messages.adjacent;
    const saved = A.save(fixture.comments),
      heads = A.getHeads(fixture.comments);
    const raw = codeTextUnmarked(A.spans(message, ["richText"]));
    const base = await stages("./richtext-spans.mjs", ["readableSpans"]);
    const candidate = await stages("./comment-read.mjs", [
      "commentNoticeSpans",
      "commentReadSpans",
      "commentNodes",
    ]);
    const result = {
      raw,
      baseEligibility: base.markdownlessNode(message),
      base: [],
      candidate: [],
    };
    for (const all of [false, true]) {
      const input = base.readableSpans(raw, all);
      let pm, markdown;
      try {
        pm = pmDocFromSpans(adapter, input);
        markdown = exportMarkdown(pm);
        result.base.push({ all, input, tree: pm.toJSON(), markdown });
      } catch (error) {
        result.base.push({
          all,
          input,
          stage: pm ? "serialization" : "construction",
          error: error.message,
        });
      }
      const notices = candidate.commentNoticeSpans(raw, all);
      let prepared, nodes;
      try {
        prepared = candidate.commentReadSpans(notices);
        nodes = candidate.commentNodes(nativeReadSpans(prepared).nodes);
        result.candidate.push({ all, notices, prepared, markdown: readMarkdown(nodes) });
      } catch (error) {
        result.candidate.push({
          all,
          notices,
          prepared,
          stage: prepared ? (nodes ? "serialization" : "native construction") : "read preparation",
          error: error.message,
        });
      }
    }
    result.baseProjection = baseProjection(message);
    result.candidateProjection = candidate.commentBodyProjection(message);
    context.diagnostic(JSON.stringify(result));
    assert.equal(result.baseEligibility, "", "a later nonempty unknown cannot enable retry");
    assert.equal(result.base[0].stage, "construction");
    assert.equal(result.base[0].error, "Match cannot be null");
    assert.equal(result.candidate[0].stage, "read preparation");
    for (let i = 0; i < 2; i++) assert.deepEqual(result.candidate[i].notices, result.base[i].input);
    assert.equal(
      result.candidate[1].markdown,
      result.base[1].markdown,
      "forced second attempts agree but are ineligible",
    );
    assert.deepEqual(result.baseProjection, {
      body: "",
      body_format: "plain",
      content_error: "rich_text_unavailable",
    });
    assert.deepEqual(A.save(fixture.comments), saved);
    assert.deepEqual(A.getHeads(fixture.comments), heads);
    assert.deepEqual(result.candidateProjection, result.baseProjection);
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});

test("adjacent leaf inputs preserve first raw unknown eligibility across parent representations", () => {
  for (const type of ["dataframe", "horizontal-rule"]) {
    for (const parents of [
      [],
      [[]],
      [""],
      [S("")],
      [S("blockquote")],
      ["blockquote"],
      [S("blockquote"), "table-cell"],
      [[], "future"],
      ["future", []],
      undefined,
      null,
    ]) {
      for (const mutable of [false, true])
        for (const order of ["none", "before", "after"]) {
          const leaf = B(type, [], type === "dataframe" ? DATAFRAME : {});
          if (parents === undefined) delete leaf.value.parents;
          else leaf.value.parents = parents;
          const embed = B("future", [], {}, true);
          if (mutable) embed.value.type = "future";
          const root = [B("future-root"), T("preserved", { strong: true })];
          for (const suffix of [[embed], [B("paragraph"), T("after", { em: true })]]) {
            const spans = [
              ...(order === "before" ? root : []),
              leaf,
              ...suffix,
              ...(order === "after" ? root : []),
            ];
            let doc = A.from({ format: RICH_FORMAT, richText: "" });
            doc = A.change(doc, (draft) =>
              A.updateSpans(draft, ["richText"], spans, updateSpansConfig),
            );
            try {
              const saved = A.save(doc),
                heads = A.getHeads(doc),
                id = A.getObjectId(doc, "richText");
              assert.deepEqual(
                commentBodyProjection(doc),
                baseProjection(doc),
                JSON.stringify({ type, parents, mutable, order, suffix }),
              );
              assert.deepEqual(A.save(doc), saved);
              assert.deepEqual(A.getHeads(doc), heads);
              assert.equal(A.getObjectId(doc, "richText"), id);
            } finally {
              A.free(doc);
            }
          }
        }
    }
  }
});

test("adjacency API responses preserve retry order, siblings, native anchors and saved bytes", async () => {
  const inputs = {};
  for (const [name, parents] of Object.entries({
    empty: [[]],
    mixed: [S("blockquote"), "table-cell"],
    valid: [],
  })) {
    const leaf = B("dataframe", [], DATAFRAME);
    leaf.value.parents = parents;
    for (const mutable of [false, true]) {
      const embed = B("future", [], {}, true);
      if (mutable) embed.value.type = "future";
      const root = [B("future-root"), T("kept", { strong: true })];
      inputs[`${name}-${mutable}-before`] = [...root, leaf, embed];
      inputs[`${name}-${mutable}-after`] = [leaf, embed, ...root];
      inputs[`${name}-${mutable}-paragraph`] = [leaf, B("paragraph"), T("after", { em: true })];
    }
  }
  const fixture = reviewFixture(inputs);
  try {
    const source = () => ({
      bytes: [A.save(fixture.page), A.save(fixture.comments)],
      heads: [A.getHeads(fixture.page), A.getHeads(fixture.comments)],
      anchor: json(fixture.comments.threads.review.target),
      ids: [
        A.getObjectId(fixture.page.blocks[BLOCK], "richText"),
        A.getObjectId(fixture.comments.threads.review.target),
        ...Object.values(fixture.comments.threads.review.messages).flatMap((message) => [
          A.getObjectId(message),
          A.getObjectId(message, "richText"),
          A.getObjectId(message.author),
        ]),
      ],
    });
    const before = source();
    before.ids.forEach((id) => assert.equal(typeof id, "string"));
    assert.equal(before.anchor.anchor.textObjectId, before.ids[0]);
    const base = await actualBaseApi();
    const expected = await apiSnapshots(base, fixture, 65536);
    assert.deepEqual(json(await apiSnapshots(api, fixture, 65536)), json(expected));
    for (const snapshot of [false, true]) {
      const args = {
        since_heads: A.getHeads(fixture.page),
        comments: "all",
        max_bytes: 65536,
        ...(snapshot ? {} : { since_comment_heads: fixture.since }),
      };
      const options = {
        commentsDoc: fixture.comments,
        issueAuthority: async () => ({
          retry_token: "adjacency",
          retry_key_prefix: "adjacent_",
          retry_until: "2026-11-08T20:20:00-08:00",
        }),
      };
      const expectedDelta = await base.readChangesTool(fixture.page, args, options);
      assert.equal(expectedDelta.status, 200);
      assert.deepEqual(
        json(await readChangesTool(fixture.page, args, options)),
        json(expectedDelta),
      );
    }
    assert.deepEqual(source(), before);
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});

test("missing leaf parents refuse only when adjacent inline content needs raw placement", async (context) => {
  const leaf = B("dataframe", [], DATAFRAME);
  delete leaf.value.parents;
  const fixture = reviewFixture({ adjacent: [leaf, T("text0", { em: true })], standalone: [leaf] });
  try {
    const message = fixture.comments.threads.review.messages.adjacent;
    const base = await stages("./richtext-spans.mjs", ["readableSpans"]);
    const candidate = await stages("./comment-read.mjs", ["commentNoticeSpans"]);
    const raw = A.spans(message, ["richText"]);
    assert.equal(base.markdownlessNode(message), null);
    for (const all of [false, true]) {
      let error;
      try {
        base.readableSpans(raw, all);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof TypeError);
      context.diagnostic(
        JSON.stringify({ all, stage: "raw leaf placement", error: error.message }),
      );
    }
    const expected = {
      body: "text0",
      body_format: "plain",
      content_error: "rich_text_unavailable",
    };
    assert.deepEqual(baseProjection(message), expected);
    assert.deepEqual(
      candidate.commentBodyProjection(fixture.comments.threads.review.messages.standalone),
      baseProjection(fixture.comments.threads.review.messages.standalone),
    );
    assert.deepEqual(candidate.commentBodyProjection(message), expected);
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});
