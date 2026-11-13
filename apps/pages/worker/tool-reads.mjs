import * as A from "@automerge/automerge";
import { orderedBlockIds } from "../model/order.mjs";
import { agentBlock, projectReadContent } from "../model/read-content.mjs";
import { projectReadComments } from "../model/read-comments.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { listSources, readSource } from "../model/sources-doc.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { readView, viewSummary } from "../model/view-doc.mjs";
import { validViewId } from "../shared/views.mjs";

export const DEFAULT_READ_BYTES = 128 * 1024;
/** The largest max_bytes a read takes (read_page, list_page_comments,
 * read_page_changes). */
export const MAX_READ_BYTES = 262144;
/** What an over-budget refusal tells the caller to do: raise max_bytes while
 * it can still rise, then `instead`, a sentence fragment starting lowercase. */
export const budgetAdvice = (maxBytes, instead) =>
  maxBytes < MAX_READ_BYTES
    ? `Raise it, up to ${MAX_READ_BYTES}, or ${instead}`
    : `${instead[0].toUpperCase()}${instead.slice(1)}`;
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const selectorKeys = [
  "node_ids",
  "section",
  "section_occurrence",
  "search",
  "context_nodes",
  "include_content",
  "include_presence",
  "comments",
  "outline_offset",
  "outline_limit",
  "max_bytes",
  "revision",
  "sources",
  "source_id",
  "views",
  "view_id",
];
const commentKeys = ["state", "node_id", "thread_ids", "include_messages", "max_bytes", "revision"];
/** Read refusals that reach the caller with their own code. */
export const READ_ERROR_CODES = new Set([
  "invalid_read_selector",
  "read_target_not_found",
  "ambiguous_section",
  "invalid_comment_selector",
  "comment_not_found",
  "read_revision_changed",
  "wrong_address_kind",
  "invalid_source",
  "source_not_found",
  "invalid_view",
  "view_not_found",
]);
function invalid(message) {
  throw Object.assign(new Error(message), { status: 400, code: "invalid_read_selector" });
}
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function validate(operation, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) invalid("Invalid read arguments");
  const keys = operation === "read_page" ? selectorKeys : commentKeys;
  if (Object.keys(args).some((key) => key !== "page_id" && !keys.includes(key)))
    invalid("Unknown read argument");
  const maxBytes = integer(args.max_bytes, DEFAULT_READ_BYTES, 4096, MAX_READ_BYTES, "max_bytes");
  const offset = integer(args.outline_offset, 0, 0, Number.MAX_SAFE_INTEGER, "outline_offset");
  const limit = integer(args.outline_limit, 100, 1, 100, "outline_limit");
  if (args.comments !== undefined && !["none", "summary", "open", "all"].includes(args.comments))
    invalid("comments must be none, summary, open or all");
  if (args.include_presence !== undefined && typeof args.include_presence !== "boolean")
    invalid("include_presence must be a boolean");
  if (args.sources !== undefined && typeof args.sources !== "boolean")
    invalid("sources must be a boolean: true lists the Page's sources");
  if (args.source_id !== undefined && typeof args.source_id !== "string")
    invalid("source_id must be one source's ID");
  if (args.views !== undefined && typeof args.views !== "boolean")
    invalid("views must be a boolean: true lists the Page's views");
  if (args.view_id !== undefined && typeof args.view_id !== "string")
    invalid("view_id must be one view's ID");
  return { maxBytes, offset, limit };
}
/** A read's `revision` against the revision it reads. The handle resolves
 * through the host's table (`revisions.heads`): an unknown handle is
 * `resync_required`, a known one that isn't current `read_revision_changed`. */
async function checkRevision(args, heads, offset, revisions) {
  const expected = args.revision;
  if (expected === undefined && offset > 0)
    invalid("revision from the outline read is required for outline pagination");
  if (expected === undefined) return;
  let named;
  try {
    named = await revisions.heads("page", expected);
  } catch (error) {
    // The refusal names the revision to read instead.
    if (error.code === "resync_required") error.details = { current_heads: heads };
    throw error;
  }
  if (JSON.stringify([...named].sort()) !== JSON.stringify([...heads].sort()))
    throw Object.assign(new Error("Page changed; read a fresh outline before paging through it."), {
      status: 409,
      code: "read_revision_changed",
    });
}
function outlinePage(entries, offset, limit) {
  const selected = entries.slice(offset, offset + limit);
  const next = offset + selected.length;
  return {
    entries: selected,
    total: entries.length,
    offset,
    next_offset: next < entries.length ? next : null,
  };
}

/** The sources a read_page asks for: `{ sources }` listing every source
 * for `sources: true`, `{ source }` with its dataset's summary, producer and
 * history for `source_id`, or both. A Page with no sources document lists
 * none. `datasetSummary(assetId)` is the host's: it resolves to the agent
 * summary (worker/dataset-summary.mjs) or null, and never rejects. */
async function sourcesRead(sourcesDoc, { sources, source_id }, datasetSummary) {
  const source = source_id === undefined ? undefined : readSource(sourcesDoc, source_id);
  return {
    ...(sources === true && { sources: listSources(sourcesDoc) }),
    ...(source && { source: await withSummary(source, datasetSummary) }),
  };
}

/** `source` with `summary` after its media type: the summary of the asset
 * it names now, or null without one. */
async function withSummary(source, datasetSummary) {
  const { producer, history, history_truncated, ...current } = source;
  const summary =
    datasetSummary && source.media_type === PARQUET_MEDIA_TYPE
      ? await datasetSummary(source.asset_id)
      : null;
  // A copy: the read budget may trim its columns, and the host keeps the original.
  return {
    ...current,
    summary: summary && { ...summary },
    producer,
    history,
    history_truncated,
  };
}

/** The views a read_page asks for: `{ views }` listing every view for
 * `views: true`, `{ view }` with its spec for `view_id`, or both. `views` is
 * the host's `{ ids(), doc(view_id) }` (worker/index.mjs viewReads). */
function viewsRead(views, { views: list, view_id }) {
  const view = () => {
    if (!validViewId(view_id))
      throw Object.assign(Error("Invalid view ID"), { status: 400, code: "invalid_view" });
    const found = views?.ids().includes(view_id) ? readView(views.doc(view_id), view_id) : null;
    if (!found)
      throw Object.assign(Error("No view with this ID on this Page"), {
        status: 404,
        code: "view_not_found",
      });
    return found;
  };
  return {
    ...(list === true && {
      views: (views?.ids() ?? []).map((id) => viewSummary(views.doc(id), id)),
    }),
    ...(view_id !== undefined && { view: view() }),
  };
}

/** One captured CRDT revision supplies content, comments and revisions.
 * `revisions` is the host's handle table: `handles([[doc, heads], ...])`
 * names revisions, minting handles when needed, and `heads(doc, handle)`
 * resolves one. The result names the Page revision as `revision`, the comments
 * document's as `comment_revision`, the baseline read_page_changes takes as
 * `since_comment_revision`, and the sources document's, once the Page has
 * one, as `sources_revision`; comment and source writes never move
 * `revision`. `heads` beside the body is the Page revision read, for the
 * host's own use.
 *
 * read_page's `sources` and `source_id` read the Page's sources
 * (`sourcesDoc`), with the summary of `source_id`'s dataset from the host's
 * `datasetSummary`, and `views` and `view_id` its views (`views`, the host's
 * viewReads). Alone, they read them without the Page's content; beside
 * other selectors, such as include_content false, they add them to that
 * read. An outline entry for a view node carries its view's title and media
 * type. */
export async function readTool(
  doc,
  operation,
  args,
  {
    revisions,
    recovery,
    historyIncomplete,
    getPresence,
    commentsDoc,
    sourcesDoc,
    views,
    datasetSummary,
  } = {},
) {
  const heads = A.getHeads(doc);
  const commentHeads = commentsDoc ? A.getHeads(commentsDoc) : undefined;
  const sourceHeads = sourcesDoc ? A.getHeads(sourcesDoc) : undefined;
  // validate() refuses arguments that aren't an object.
  const { sources, source_id, views: listViews, view_id, ...contentArgs } = args ?? {};
  const sourceSelector = { sources, source_id };
  const viewSelector = { views: listViews, view_id };
  const readsSources = sources === true || source_id !== undefined;
  const readsViews = listViews === true || view_id !== undefined;
  const reads = async () => ({
    ...(readsSources && (await sourcesRead(sourcesDoc, sourceSelector, datasetSummary))),
    ...(readsViews && viewsRead(views, viewSelector)),
  });
  const summaries = {
    viewSummary: (id) => (views?.ids().includes(id) ? viewSummary(views.doc(id), id) : undefined),
  };
  let settings = { maxBytes: DEFAULT_READ_BYTES, offset: 0, limit: 100 },
    legacy = false,
    // A read of sources alone has no outline to offer when it is too large.
    sourcesOnly = false,
    content,
    payload,
    status = 200;
  const outline = () => {
    content ??= projectReadContent(doc, { include_content: false }, summaries);
    return outlinePage(content.outline, settings.offset, settings.limit);
  };
  try {
    settings = validate(operation, args);
    await checkRevision(args, heads, settings.offset, revisions);
    if (operation === "list_page_comments") {
      const { page_id: _id, max_bytes: _bytes, revision: _revision, ...filters } = args;
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        comments: projectReadComments(doc, { state: "open", ...filters }, commentsDoc),
      };
    } else if (
      (readsSources || readsViews) &&
      Object.keys(contentArgs).every((key) => ["page_id", "max_bytes", "revision"].includes(key))
    ) {
      sourcesOnly = true;
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        ...(await reads()),
      };
    } else if (Object.keys(args).every((key) => key === "page_id")) {
      // A read with no selector: every block whole and every thread with its
      // messages, without an outline or a budget.
      legacy = true;
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        blocks: orderedBlockIds(doc).map((key) => agentBlock(doc, key)),
        comments: projectReadComments(doc, { state: "all" }, commentsDoc),
      };
    } else {
      content = projectReadContent(doc, contentArgs, summaries);
      const mode = args.comments ?? (args.include_content === false ? "none" : "summary");
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        blocks: content.blocks,
        ...(content.nodes && { nodes: content.nodes }),
        outline: outline(),
        comments_mode: mode,
        comments:
          mode === "none"
            ? []
            : projectReadComments(
                doc,
                {
                  state: mode === "open" ? "open" : "all",
                  include_messages: mode !== "summary",
                },
                commentsDoc,
              ),
        ...(content.selection && { selection: content.selection }),
        ...(args.include_presence && { presence: getPresence(doc) }),
        ...(await reads()),
      };
    }
  } catch (error) {
    if (!READ_ERROR_CODES.has(error.code)) throw error;
    if (error.code === "read_revision_changed") settings.offset = 0;
    status = error.status;
    payload = {
      page_id: doc.page_id,
      error: error.message,
      code: error.code,
      ...(error.code === "ambiguous_section" && error.details),
      ...(error.code === "read_revision_changed" && { outline: outline() }),
    };
  }
  const [revision, ...others] = await revisions.handles([
    ["page", heads],
    ...(commentHeads ? [["comments", commentHeads]] : []),
    ...(sourceHeads ? [["sources", sourceHeads]] : []),
  ]);
  const comment_revision = commentHeads ? others.shift() : undefined;
  const sources_revision = sourceHeads ? others.shift() : undefined;
  const common = {
    revision,
    ...(comment_revision && { comment_revision }),
    ...(sources_revision && { sources_revision }),
    // The Page's schema stamp; empty when it uses only the baseline.
    ...(operation === "read_page" && { schema_features: documentFeatures(doc) }),
    ...(recovery && { recovery }),
    ...(historyIncomplete && { history_incomplete: historyIncomplete }),
  };
  let body = { ...payload, ...common };
  if (legacy) return { status, body, heads };
  // Reserve room for the public URL added by the MCP transport.
  const fits = (value) => bytes(value) + 512 <= settings.maxBytes;
  // Requested content has priority over the optional outline page. Shorten
  // only that explicitly paginated metadata before rejecting a fitting passage.
  if (
    !fits(body) &&
    body.outline &&
    fits({
      ...body,
      outline: { ...body.outline, entries: [], next_offset: body.outline.offset },
    })
  ) {
    while (!fits(body) && body.outline.entries.length > 1) {
      body.outline.entries.pop();
      body.outline.next_offset = body.outline.offset + body.outline.entries.length;
    }
  }
  // A source's dataset summary is advisory: it gives up columns, from the
  // end, before the read is refused.
  const summary = body.source?.summary;
  if (!fits(body) && summary?.columns.length) {
    const columns = summary.columns;
    let [low, high] = [0, columns.length];
    while (low < high) {
      const keep = Math.ceil((low + high) / 2);
      summary.columns = columns.slice(0, keep);
      if (fits(body)) low = keep;
      else high = keep - 1;
    }
    summary.columns = columns.slice(0, low);
    summary.columns_truncated = true;
  }
  if (!fits(body) && sourcesOnly) {
    status = 413;
    body = {
      page_id: doc.page_id,
      error: `Sources exceed max_bytes (${settings.maxBytes}). ${budgetAdvice(settings.maxBytes, "read one source with source_id rather than listing them with sources:true.")}`,
      code: "read_budget_exceeded",
      max_bytes: settings.maxBytes,
      ...common,
    };
    if (!fits(body))
      body = {
        error: "Revision metadata exceeds max_bytes; retry with a larger budget.",
        code: "read_metadata_budget_exceeded",
        max_bytes: settings.maxBytes,
      };
  } else if (!fits(body)) {
    status = 413;
    body = {
      page_id: doc.page_id,
      error:
        "Read exceeds max_bytes. Use the outline to select a section or node_ids; reduce outline_limit, request comments:none or list_page_comments with thread_ids/include_messages:false.",
      code: "read_budget_exceeded",
      max_bytes: settings.maxBytes,
      ...common,
      outline: outline(),
    };
    // The outline is explicitly paginated; selected document/comment content is never truncated.
    while (!fits(body) && body.outline.entries.length) {
      body.outline.entries.pop();
      body.outline.next_offset = body.outline.offset + body.outline.entries.length;
    }
    if (!body.outline.entries.length && body.outline.total > body.outline.offset)
      body.hint =
        "An outline entry exceeds this budget. Increase max_bytes or select known blocks or nodes with node_ids.";
    if (!fits(body))
      body = {
        error: "Revision metadata exceeds max_bytes; retry with a larger budget.",
        code: "read_metadata_budget_exceeded",
        max_bytes: settings.maxBytes,
      };
  }
  return { status, body, heads };
}
