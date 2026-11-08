import * as A from "@automerge/automerge";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { RICH_FORMAT } from "../model/richtext-format.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { captureSelectionTarget } from "../model/comments.mjs";

export const BASE = "943115c13706ab28b6bd1ddda775e57f3acf1b65";
export const S = (value) => new A.ImmutableString(value);
export const B = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
export const T = (value, marks = {}) => ({ type: "text", value, marks });
export const PAGE = "11111111-1111-4111-8111-111111111111";
export const BLOCK = "22222222-2222-4222-8222-222222222222";
export const ASSET = `/api/pages/${PAGE}/assets/${"a".repeat(64)}`;
export const DATAFRAME = { src: S(ASSET), media_type: S("application/vnd.apache.parquet") };
export const cases = {
  rootDataframeEmbed: [B("dataframe", ["table-cell"], DATAFRAME, true), T("after")],
  serializationRetry: [
    T("before", { strong: true }),
    {
      type: "block",
      value: { type: "future", parents: [S("table-cell"), S("aside")], attrs: {}, isEmbed: false },
    },
    T("after", { em: true }),
  ],
  invalidTableCell: [B("paragraph", ["table", "table-cell"]), T("after")],
  invalidTableAside: [B("paragraph", ["table", "aside", "table-row"]), T("after")],
  unknownGrouping: [
    B("future-root"),
    T("before"),
    ...Array.from({ length: 80 }, (_, i) => [B("paragraph", [`future-${i}`]), T("after")]).flat(),
  ],
};

export function reviewFixture(inputs = cases) {
  const author = { principal: "user:reader", displayName: "Reader", driver: "Review fixture" };
  const createdAt = "2026-11-07T19:40:00-08:00";
  let page = A.init({ actor: "11223344556677889900aabbccddeeff00" });
  page = A.change(page, { time: 0 }, (draft) => {
    draft.page_id = PAGE;
    draft.title = "Comment review fixtures";
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
  let comments = A.init({ actor: "00ffeeddccbbaa998877665544332211" });
  comments = A.change(comments, { time: 0 }, (draft) => {
    draft.threads = {};
  });
  const since = A.getHeads(comments);
  comments = A.change(comments, { time: 0 }, (draft) => {
    const message = (richText, extra = {}) => ({
      format: RICH_FORMAT,
      richText,
      author,
      createdAt,
      deletedAt: null,
      ...extra,
    });
    draft.threads.review = {
      target,
      author,
      createdAt,
      status: "open",
      messages: {
        healthy: message("Healthy sibling"),
        tombstone: message("Deleted source", { deletedAt: createdAt }),
        ...Object.fromEntries(Object.keys(inputs).map((id) => [id, message("")])),
      },
    };
    for (const [id, spans] of Object.entries(inputs))
      A.updateSpans(
        draft,
        ["threads", "review", "messages", id, "richText"],
        spans,
        updateSpansConfig,
      );
    draft.threads.deleted = {
      target,
      author,
      createdAt,
      status: { value: "deleted", at: createdAt },
      messages: { hidden: message("Hidden sibling") },
    };
  });
  return { page, comments, since };
}

export async function apiSnapshots(api, { page, comments, since }, maxBytes = 16384) {
  const options = {
    commentsDoc: comments,
    issueAuthority: async () => ({
      retry_token: "review-fixture",
      retry_key_prefix: "review_",
      retry_until: "2026-11-08T19:40:00-08:00",
    }),
  };
  const deltaArgs = {
    since_heads: A.getHeads(page),
    since_comment_heads: since,
    max_bytes: maxBytes,
  };
  return {
    project: api.projectPage(page, comments),
    compact: api.projectReadComments(page, { state: "all" }, comments),
    read: await api.readTool(page, "read_page", { page_id: PAGE }, options),
    selected: await api.readTool(
      page,
      "read_page",
      { comments: "all", max_bytes: maxBytes },
      options,
    ),
    list: await api.readTool(
      page,
      "list_page_comments",
      { state: "all", max_bytes: maxBytes },
      options,
    ),
    delta: await api.readChangesTool(page, deltaArgs, options),
    snapshot: await api.readChangesTool(
      page,
      { since_heads: deltaArgs.since_heads, max_bytes: maxBytes },
      options,
    ),
  };
}

// Snapshots were recorded using git-show's actual BASE source before edits.
// Replay its frozen read exports without requiring Git history in test runners.
export async function actualBaseApi() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { outputFiles } = await build({
    stdin: {
      contents: `export { readTool } from "./worker/tool-reads.mjs";
      export { readChangesTool } from "./worker/tool-changes.mjs";
      export { projectPage } from "./model/page.mjs";
      export { projectReadComments } from "./model/read-comments.mjs";`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "actual-base-comment-reader",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/comment-read\.mjs$/ }, ({ importer }) =>
            importer.endsWith("/model/comment-content.mjs")
              ? { path: fileURLToPath(new URL("./comment-read-baseline.mjs", import.meta.url)) }
              : undefined,
          );
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
            path: import.meta.resolve(path),
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
