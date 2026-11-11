import MarkdownIt from "markdown-it";
import { Leaf } from "wordgard/doc";
import {
  CodeBlock,
  LineBreak,
  PagesUnknownBlock,
  PagesUnknownEmbed,
  codeHolds,
  decode,
  fromMarks,
} from "./wordgard-doc.mjs";
import { treeMarkdown } from "./markdown-serializer.mjs";
import { codeTextUnmarked, markerParents } from "./richtext-format.mjs";
import { isKnownBlock, markerType } from "./node-registry.mjs";
import { unknownNodeNotice } from "./richtext-notices.mjs";

const markdown = new MarkdownIt({ html: false });
// Titles, names and passages are user input. `\s+` consumes a whole run per
// match, and the other patterns match one character, so each pass is linear.
const singleLine = (text) => text.replace(/\s+/g, " ").trim();
const headingText = (title) =>
  title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/[\\`*_[\]{}()#+.!|>-]/g, "\\$&");

/** Export a current projectPage/session.snapshot projection, never raw import provenance. */
export function pageMarkdown(page) {
  if (!page) throw Error("No Page to copy");
  const title = singleLine(page.title) || "Untitled";
  const body = page.blocks.map((block) => block.markdown).join("\n\n");
  const [heading, inline] = markdown.parse(body, {});
  const leadingTitle = inline?.children
    ?.map((token) =>
      ["text", "code_inline", "image"].includes(token.type)
        ? token.content
        : ["softbreak", "hardbreak"].includes(token.type)
          ? " "
          : "",
    )
    .join("");
  // Keep an existing matching H1 as-is; do not remove headings or rewrite body content.
  const hasTitle =
    heading?.type === "heading_open" &&
    heading.tag === "h1" &&
    singleLine(leadingTitle ?? "") === title;
  const result = hasTitle ? body : `# ${headingText(title)}${body ? `\n\n${body}` : ""}`;
  return result.endsWith("\n") ? result : `${result}\n`;
}

const quoted = (text) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

/** A Markdown section listing comment messages in `page` that `saved` lacks
 * (new messages, or bodies edited since). Both arguments are projectPage
 * projections; `saved` is the host-acknowledged state, or null when unknown,
 * in which case every comment is listed. Returns "" when nothing is unsent. */
export function unsentCommentsMarkdown(page, saved) {
  const savedThreads = new Map((saved?.comments ?? []).map((thread) => [thread.id, thread]));
  const sections = [];
  for (const thread of page.comments ?? []) {
    const before = savedThreads.get(thread.id);
    const lines = [];
    thread.messages.forEach((message, index) => {
      if (message.deletedAt) return;
      const old = before?.messages.find((candidate) => candidate.id === message.id);
      if (old && !old.deletedAt && old.body === message.body) return;
      const kind = old ? "edited" : index === 0 ? "comment" : "reply";
      const who = singleLine(message.author?.displayName ?? "") || "Collaborator";
      lines.push(`**${who}** · ${kind} · ${message.createdAt}\n\n${quoted(message.body ?? "")}`);
    });
    if (!lines.length) continue;
    const { target, selectionContext } = thread;
    const passage =
      selectionContext?.status === "attached"
        ? selectionContext.text
        : page.blocks.find((block) => block.id === target?.blockId)?.markdown;
    const anchor = singleLine(passage ?? "").slice(0, 120);
    sections.push(
      [`### ${anchor ? `On “${anchor}”` : "On this Page"}`, `Thread ${thread.id}`, ...lines].join(
        "\n\n",
      ),
    );
  }
  if (!sections.length) return "";
  const note = saved
    ? "These comments and replies never reached the server. Add them again after you reopen the Page."
    : "These comments and replies may not have reached the server. Check the Page and add any that are missing.";
  return `\n---\n\n## Unsent comments\n\n${note}\n\n${sections.join("\n\n")}\n`;
}

/** Read-only archive projection. Unknown ancestors need their own notices;
 * the editor decoder intentionally omits their wrappers. Native positions
 * here address only these temporary spans, never the stored document. */
function draftTree(spans) {
  const readable = [];
  let parents = [],
    code = false,
    unsupported = false;
  for (const span of spans) {
    if (span?.type !== "block") {
      if (span?.type !== "text" || typeof span.value !== "string")
        throw Error("Invalid draft text");
      readable.push(span);
      continue;
    }
    const value = span.value;
    if (
      !value ||
      typeof value.type !== "string" ||
      (value.parents != null && !Array.isArray(value.parents))
    )
      throw Error("Invalid draft marker");
    const next = markerParents(value);
    unsupported ||= !isKnownBlock(value.type) || next.some((parent) => !isKnownBlock(parent));
    let common = 0;
    while (common < parents.length && parents[common] === next[common]) common++;
    for (let i = common; i < next.length; i++)
      if (!isKnownBlock(next[i]))
        readable.push({
          type: "block",
          value: {
            type: next[i],
            parents: next.slice(0, i).filter(isKnownBlock),
            attrs: {},
            isEmbed: false,
          },
        });
    parents = value.isEmbed ? next : [...next, value.type];
    if (!value.isEmbed) code = markerType(value) === "code-block";
    // An unknown embed stored in a code block reads as a notice there; one a
    // code block can't hold opens a paragraph after it (decode).
    if (
      code &&
      value.isEmbed &&
      !["hard-break", "image"].includes(markerType(value)) &&
      codeHolds(markerType(value), next)
    ) {
      unsupported = true;
      readable.push({ type: "text", value: unknownNodeNotice(value.type), marks: {} });
    } else readable.push({ ...span, value: { ...value, parents: next.filter(isKnownBlock) } });
  }
  const clean = codeTextUnmarked(readable);
  const decoded = decode(clean);
  // A newline stored as text is not a native hard-break marker. Preserve
  // its text and marks, including trailing newlines, for old archive spans.
  const newlines = new Map();
  let native = 0;
  for (const span of clean) {
    if (span.type === "text") {
      for (let i = span.value.indexOf("\n"); i !== -1; i = span.value.indexOf("\n", i + 1))
        newlines.set(native + i, span.marks);
      native += span.value.length;
    } else native++;
  }
  let position = 0;
  const visit = (node, inCode = false) => {
    const at = position;
    if (node.isPlot) {
      position++;
      const content = node.content.map((child) => visit(child, node.type === CodeBlock.type));
      position++;
      return node.tag.create(content);
    }
    position += node.length;
    unsupported ||= node.type === PagesUnknownBlock || node.type === PagesUnknownEmbed;
    const offset = decoded.map.wgToAm[at];
    return !inCode && node.type === LineBreak.type && newlines.has(offset)
      ? Leaf.text("\n", fromMarks(newlines.get(offset)))
      : node;
  };
  const tree = { content: decoded.doc.content.map((node) => visit(node)) };
  return { tree, lossy: decoded.lossy || decoded.newer || unsupported };
}

function draftSource(spans) {
  const source = JSON.stringify(spans, null, 2);
  let length = 3;
  for (const [run] of source.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  const fence = "`".repeat(length);
  return `[Unsupported node: archive-spans]\n\n${fence}json\n${source}\n${fence}`;
}

/** A draft's Markdown, or an explicit source fallback when its structure
 * cannot be decoded. The fallback keeps every span and asset reference in
 * order as inert JSON, rather than substituting a possibly stale body. */
function draftMarkdown(draft) {
  if (Array.isArray(draft?.spans))
    try {
      // Draft records hold the editor's spans as JSON. The native decoder
      // reads their string markers directly, without changing the archive.
      const { tree, lossy } = draftTree(draft.spans);
      const body = treeMarkdown(tree);
      return lossy ? `${body}\n\n${draftSource(draft.spans)}` : body;
    } catch {
      return [draft.body, draftSource(draft.spans)]
        .filter((part) => typeof part === "string" && part.length)
        .join("\n\n");
    }
  return draft?.body;
}

/** A Markdown section for comment drafts the person typed but never sent:
 * `{ kind: "comment" | "reply", body, quote?, thread_id? }`, as recovery
 * records keep them, with `spans` when the editor wrote them. Returns "" when
 * there are none. */
export function commentDraftsMarkdown(drafts) {
  const sections = (drafts ?? [])
    .map((draft) => ({ ...draft, body: draftMarkdown(draft) }))
    .filter((draft) => typeof draft?.body === "string" && draft.body.trim())
    .map((draft) => {
      const anchor = singleLine(draft.quote ?? "").slice(0, 120);
      const heading = anchor ? `### On “${anchor}”` : "### On this Page";
      const kind = draft.kind === "reply" ? `Reply to thread ${draft.thread_id}` : "New comment";
      return [heading, kind, quoted(draft.body)].join("\n\n");
    });
  if (!sections.length) return "";
  return `\n---\n\n## Unsent comment drafts\n\nThese drafts were never sent. Add them again if you still need them.\n\n${sections.join("\n\n")}\n`;
}
