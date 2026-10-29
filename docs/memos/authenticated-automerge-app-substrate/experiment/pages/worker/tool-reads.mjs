import * as A from "@automerge/automerge";
import { projectPage } from "../model/page.mjs";
import { projectReadContent } from "../model/read-content.mjs";
import { projectReadComments } from "../model/read-comments.mjs";

export const DEFAULT_READ_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const selectorKeys = [
  "block_ids",
  "section",
  "section_occurrence",
  "search",
  "context_nodes",
  "node_range",
  "include_content",
  "include_presence",
  "comments",
  "outline_offset",
  "outline_limit",
  "max_bytes",
  "expected_heads",
];
const commentKeys = [
  "state",
  "block_id",
  "thread_ids",
  "include_messages",
  "max_bytes",
  "expected_heads",
];
const readErrors = new Set([
  "invalid_read_selector",
  "read_target_not_found",
  "ambiguous_section",
  "invalid_comment_selector",
  "comment_not_found",
  "read_revision_changed",
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
  const maxBytes = integer(args.max_bytes, DEFAULT_READ_BYTES, 4096, 262144, "max_bytes");
  const offset = integer(args.outline_offset, 0, 0, Number.MAX_SAFE_INTEGER, "outline_offset");
  const limit = integer(args.outline_limit, 100, 1, 100, "outline_limit");
  if (args.comments !== undefined && !["none", "summary", "open", "all"].includes(args.comments))
    invalid("comments must be none, summary, open or all");
  if (args.include_presence !== undefined && typeof args.include_presence !== "boolean")
    invalid("include_presence must be a boolean");
  return { maxBytes, offset, limit };
}
function checkRevision(args, heads, offset) {
  const expected = args.expected_heads;
  if (expected === undefined && (args.node_range !== undefined || offset > 0))
    invalid(
      "expected_heads from the outline read are required for node_range and outline pagination",
    );
  if (expected !== undefined) {
    if (
      !Array.isArray(expected) ||
      expected.length > 1024 ||
      expected.some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head)) ||
      new Set(expected).size !== expected.length
    )
      invalid("Invalid expected_heads");
    if (JSON.stringify([...expected].sort()) !== JSON.stringify([...heads].sort()))
      throw Object.assign(
        new Error("Page changed; read a fresh outline before using its node addresses."),
        { status: 409, code: "read_revision_changed" },
      );
  }
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

/** One captured CRDT revision supplies content, comments and heads across token issuance. */
export async function readTool(
  doc,
  operation,
  args,
  { issueAuthority, recovery, historyIncomplete, getPresence } = {},
) {
  const heads = A.getHeads(doc);
  let settings = { maxBytes: DEFAULT_READ_BYTES, offset: 0, limit: 100 },
    legacy = false,
    content,
    payload,
    status = 200;
  const outline = () => {
    content ??= projectReadContent(doc, { include_content: false });
    return outlinePage(content.outline, settings.offset, settings.limit);
  };
  try {
    settings = validate(operation, args);
    checkRevision(args, heads, settings.offset);
    if (operation === "list_page_comments") {
      const { page_id: _id, max_bytes: _bytes, expected_heads: _heads, ...filters } = args;
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        comments: projectReadComments(doc, { state: "open", ...filters }),
      };
    } else if (Object.keys(args).every((key) => key === "page_id")) {
      // Keep the existing default contract for clients with cached tool schemas.
      legacy = true;
      payload = projectPage(doc);
    } else {
      content = projectReadContent(doc, args);
      const mode = args.comments ?? (args.include_content === false ? "none" : "summary");
      payload = {
        page_id: doc.page_id,
        title: doc.title,
        blocks: content.blocks,
        outline: outline(),
        comments_mode: mode,
        comments:
          mode === "none"
            ? []
            : projectReadComments(doc, {
                state: mode === "open" ? "open" : "all",
                include_messages: mode !== "summary",
              }),
        ...(content.selection && { selection: content.selection }),
        ...(args.include_presence && { presence: getPresence(doc) }),
      };
    }
  } catch (error) {
    if (!readErrors.has(error.code)) throw error;
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
  const authority = await issueAuthority();
  const common = {
    heads,
    ...authority,
    ...(recovery && { recovery }),
    ...(historyIncomplete && { history_incomplete: historyIncomplete }),
  };
  let body = { ...payload, ...common };
  if (legacy) return { status, body };
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
  if (!fits(body)) {
    status = 413;
    body = {
      page_id: doc.page_id,
      error:
        "Read exceeds max_bytes. Use the outline to select a section or node_range; reduce outline_limit, request comments:none or list_page_comments with thread_ids/include_messages:false.",
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
        "An outline entry exceeds this budget. Increase max_bytes or select a known block/node range.";
    if (!fits(body))
      body = {
        error: "Revision metadata exceeds max_bytes; retry with a larger budget.",
        code: "read_metadata_budget_exceeded",
        max_bytes: settings.maxBytes,
      };
  }
  return { status, body };
}
