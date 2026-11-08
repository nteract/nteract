import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import fc from "fast-check";
import { commentBodyProjection } from "./comment-read.mjs";
import { commentBodyProjection as baseProjection } from "../test/comment-read-baseline.mjs";
import {
  BASE,
  BLOCK,
  ASSET,
  DATAFRAME,
  S,
  B,
  T,
  reviewFixture,
  apiSnapshots,
  actualBaseApi,
} from "../test/comment-read-review-fixtures.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { projectPage } from "./page.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { readTool } from "../worker/tool-reads.mjs";
import { readChangesTool } from "../worker/tool-changes.mjs";

const api = { projectPage, projectReadComments, readTool, readChangesTool };
const json = (value) => JSON.parse(JSON.stringify(value));
const fullDelta = (api, fixture, snapshot = false) =>
  api.readChangesTool(
    fixture.page,
    {
      since_heads: A.getHeads(fixture.page),
      ...(snapshot ? {} : { since_comment_heads: fixture.since }),
      comments: "all",
      max_bytes: 65536,
    },
    {
      commentsDoc: fixture.comments,
      issueAuthority: async () => ({
        retry_token: "parent-fixture",
        retry_key_prefix: "parent_",
        retry_until: "2026-11-08T20:00:00-08:00",
      }),
    },
  );
const dataframe = (parents, mutableType = false, embed = false, attrs = DATAFRAME) => {
  const frame = B("dataframe", [], attrs, embed);
  if (parents === undefined) delete frame.value.parents;
  else frame.value.parents = parents;
  if (mutableType) frame.value.type = "dataframe";
  return frame;
};

function unchanged(fixture) {
  const { page, comments } = fixture,
    thread = comments.threads.review;
  const ids = [
    A.getObjectId(page.blocks[BLOCK]),
    A.getObjectId(thread),
    A.getObjectId(thread.target),
  ];
  const messages = Object.values(thread.messages).map((message) => {
    ids.push(
      A.getObjectId(message),
      A.getObjectId(message, "richText"),
      A.getObjectId(message.author),
    );
    return A.spans(message, ["richText"]);
  });
  for (const id of ids) assert.equal(typeof id, "string");
  assert.equal(thread.target.anchor.textObjectId, A.getObjectId(page.blocks[BLOCK], "richText"));
  return {
    bytes: [A.save(page), A.save(comments)],
    heads: [A.getHeads(page), A.getHeads(comments)],
    ids,
    messages,
    target: json(thread.target),
  };
}

function compare(spans) {
  let doc = A.from({ format: RICH_FORMAT, richText: "" });
  doc = A.change(doc, (draft) => A.updateSpans(draft, ["richText"], spans, updateSpansConfig));
  try {
    const saved = A.save(doc),
      heads = A.getHeads(doc),
      id = A.getObjectId(doc, "richText"),
      cursor = A.getCursor(doc, ["richText"], 0);
    const expected = baseProjection(doc);
    assert.deepEqual(commentBodyProjection(doc), expected, JSON.stringify(spans));
    assert.deepEqual(A.save(doc), saved);
    assert.deepEqual(A.getHeads(doc), heads);
    assert.equal(A.getObjectId(doc, "richText"), id);
    assert.equal(A.getCursor(doc, ["richText"], 0), cursor);
    return expected;
  } finally {
    A.free(doc);
  }
}

for (const [name, parents] of Object.entries({
  mutable: ["table-cell"],
  mixed: [S("blockquote"), "table-cell"],
})) {
  for (const mutableType of [false, true]) {
    test(`P2 ${name} parent hints stay dropped for ${mutableType ? "mutable" : "immutable"} dataframe type`, () => {
      for (const tail of [[], [B("paragraph"), T("after")]]) {
        const expected = compare([dataframe(parents, mutableType), ...tail]);
        assert.equal(
          expected.body,
          mutableType
            ? tail.length
              ? "after"
              : ""
            : `[Dataframe](${ASSET})${tail.length ? "\n\nafter" : ""}`,
        );
        assert.equal(expected.body_format, "markdown");
      }
    });
  }
}

test("P2 parent representation preserves early raw code notices and bounded malformed refusals", () => {
  const forms = [
    undefined,
    null,
    [],
    [S("table-cell")],
    ["table-cell"],
    [S("blockquote"), "table-cell"],
    [S("code-block")],
    ["code-block"],
    [S("blockquote"), "code-block"],
    [S("blockquote")],
    ["blockquote"],
    [S("blockquote"), "future"],
    [null],
    [false],
    [{}],
    [[]],
    "table-cell",
    "code-block",
    S("table-cell"),
    0,
    false,
    {},
    "",
  ];
  for (const parents of forms)
    for (const mutable of [false, true])
      for (const embed of [false, true]) {
        for (const prefix of [[], [B("code-block"), T("before")], [B("blockquote"), T("before")]]) {
          for (const tail of [[], [B("paragraph"), T("after", { strong: true })]])
            compare([...prefix, dataframe(parents, mutable, embed), ...tail]);
        }
      }
});

function parentFrames(multi) {
  const name = fc.constantFrom(
    "dataframe",
    "paragraph",
    "blockquote",
    "code-block",
    "table",
    "table-row",
    "table-cell",
    "future",
  );
  const parent = fc.oneof(
    name,
    name.map(S),
    fc.constantFrom(null, false, 0),
    fc.constant({}),
    fc.constant([]),
  );
  const parents = fc.oneof(
    fc.array(parent, { maxLength: 3 }),
    fc.constantFrom(undefined, null, false, 0, "table-cell", "code-block", ""),
  );
  return fc.record({
    type: name,
    parents,
    mutable: fc.boolean(),
    embed: fc.boolean(),
    text: fc.boolean(),
    ...(multi ? {} : { code: fc.boolean() }),
  });
}

test("P2 generated parent values vary stored representation as well as marker type", () => {
  fc.assert(
    fc.property(parentFrames(false), (input) => {
      const block = B(input.type, [], input.type === "dataframe" ? DATAFRAME : {}, input.embed);
      if (input.parents === undefined) delete block.value.parents;
      else block.value.parents = input.parents;
      if (input.mutable) block.value.type = input.type;
      compare([
        ...(input.code ? [B("code-block"), T("before")] : []),
        block,
        ...(input.text ? [B("paragraph"), T("after", { strong: true })] : []),
      ]);
    }),
    { seed: 11082026, numRuns: 2400 },
  );
});

test("multi-frame parent representation differential preserves the base contract", () => {
  fc.assert(
    fc.property(fc.array(parentFrames(true), { minLength: 1, maxLength: 4 }), (frames) => {
      compare(
        frames.flatMap((input, i) => {
          const block = B(input.type, [], input.type === "dataframe" ? DATAFRAME : {}, input.embed);
          if (input.parents === undefined) delete block.value.parents;
          else block.value.parents = input.parents;
          if (input.mutable) block.value.type = input.type;
          return [
            block,
            ...(input.text ? [T(`text${i}`, i % 2 ? { strong: true } : { em: true })] : []),
          ];
        }),
      );
    }),
    { seed: 11082026, numRuns: 2400 },
  );
});

test("adjacent mutable unknown embed after a legacy leaf retains base refusal", async (context) => {
  const frame = B("future", [], {}, true);
  frame.value.type = "future";
  const fixture = reviewFixture({ adjacent: [dataframe([[]]), frame] });
  try {
    const before = unchanged(fixture),
      baseApi = await actualBaseApi();
    const expected = await apiSnapshots(baseApi, fixture);
    const actual = await apiSnapshots(api, fixture);
    expected.deltaAll = await fullDelta(baseApi, fixture);
    actual.deltaAll = await fullDelta(api, fixture);
    expected.snapshotAll = await fullDelta(baseApi, fixture, true);
    actual.snapshotAll = await fullDelta(api, fixture, true);
    const projected = (node) => {
      if (!node || typeof node !== "object") return [];
      if (node.id === "adjacent") return [node];
      return Object.values(node).flatMap(projected);
    };
    for (const key of ["read", "selected", "list", "delta", "snapshot"]) {
      assert.equal(expected[key].status, 200);
      assert.equal(actual[key].status, 200);
    }
    context.diagnostic(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(expected).map((key) => [
            key,
            {
              base: projected(expected[key]),
              candidate: projected(actual[key]),
            },
          ]),
        ),
      ),
    );
    for (const key of ["deltaAll", "snapshotAll"]) {
      assert.equal(expected[key].status, 200);
      assert.equal(actual[key].status, 200);
    }
    const expectedBody = {
      body: "",
      body_format: "plain",
      content_error: "rich_text_unavailable",
    };
    assert.deepEqual(
      baseProjection(fixture.comments.threads.review.messages.adjacent),
      expectedBody,
    );
    assert.deepEqual(unchanged(fixture), before);
    assert.deepEqual(json(actual), json(expected));
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});

test("P2 actual-base API snapshots retain links, titles, private attrs and native identities", async () => {
  const inputs = {};
  for (const [name, parents] of Object.entries({
    mutable: ["table-cell"],
    mixed: [S("blockquote"), "table-cell"],
  })) {
    for (const mutable of [false, true])
      for (const tail of [false, true])
        inputs[`${name}-${mutable}-${tail}`] = [
          dataframe(parents, mutable),
          ...(tail ? [B("paragraph"), T("after")] : []),
        ];
  }
  const attrs = {
    ...DATAFRAME,
    title: S("Stored dataset title"),
    private_fixture: S("retained-not-published"),
    private_map: { version: 7 },
  };
  inputs.titled = [dataframe(["table-cell"], false, false, attrs)];
  inputs.titledAfter = [
    dataframe([S("blockquote"), "table-cell"], false, false, attrs),
    B("paragraph"),
    T("after"),
  ];
  const fixture = reviewFixture(inputs);
  try {
    const before = unchanged(fixture);
    const baseApi = await actualBaseApi();
    const expected = { base: BASE, api: await apiSnapshots(baseApi, fixture, 65536) };
    const path = new URL("./comment-read-parents.golden.json", import.meta.url);
    // Recorded from git-show's actual BASE reader before the guard change.
    assert.deepEqual(json(expected), JSON.parse(readFileSync(path, "utf8")));
    for (const key of ["read", "selected", "list", "delta", "snapshot"])
      assert.equal(expected.api[key].status, 200);
    const message = fixture.comments.threads.review.messages.titled;
    const body = baseProjection(message).body;
    assert.ok(body.includes(ASSET));
    assert.ok(body.includes("Stored dataset title"));
    assert.ok(!body.includes("retained-not-published"));
    assert.deepEqual(
      json({ base: BASE, api: await apiSnapshots(api, fixture, 65536) }),
      json(expected),
    );
    for (const snapshot of [false, true]) {
      const expectedDelta = await fullDelta(baseApi, fixture, snapshot);
      assert.equal(expectedDelta.status, 200);
      assert.deepEqual(json(await fullDelta(api, fixture, snapshot)), json(expectedDelta));
    }
    assert.deepEqual(unchanged(fixture), before);
  } finally {
    A.free(fixture.page);
    A.free(fixture.comments);
  }
});
