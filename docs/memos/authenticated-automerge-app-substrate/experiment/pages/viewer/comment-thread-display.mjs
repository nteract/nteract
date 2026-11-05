// Display-only readings of a comment thread for the comments UI: a title, who
// wrote each message, when, and where the thread points in the Page. Nothing
// here writes to a document; stored Markdown stays exactly as written.
import * as A from "@automerge/automerge/slim";
import { isRich } from "../model/richtext-format.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { presenceColor } from "./presence-color.mjs";

export const TITLE_MAX = 100;

const ellipsis = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);

/** Markdown reduced to readable text for a title or preview. */
export function plainText(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?mark[^>]*>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!$<>|~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A thread's title from its first message. Agent updates usually open with a
 * bold lead-in ("**CI handoff:** …"); that lead-in is the title. Otherwise the
 * title is the first sentence, up to TITLE_MAX characters. `lead` says the
 * title came from a lead-in.
 */
export function threadTitle(markdown) {
  const source = String(markdown ?? "").trimStart();
  const lead = /^(\*\*|__)(?!\s)([^\n]+?)(?<!\s)\1/.exec(source);
  if (lead) {
    const title = plainText(lead[2]).replace(/[\s:.,;—–-]+$/u, "");
    if (title) return { title: ellipsis(title, TITLE_MAX), lead: true };
  }
  const text = plainText(source);
  if (!text) return { title: "", lead: false };
  const sentence = /^(.+?[.!?])(?=\s|$)/u.exec(text)?.[1] ?? text;
  return { title: ellipsis(sentence.replace(/\.$/, ""), TITLE_MAX), lead: false };
}

/** Whether a message body is long enough to clamp behind Show more. */
export function isLongBody(markdown, { characters = 320, lines = 5 } = {}) {
  const source = String(markdown ?? "");
  return source.length > characters || source.split("\n").filter(Boolean).length > lines;
}

const firstName = (name) => name.split(/\s+/)[0] || name;

export function initials(name) {
  const words = String(name ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

/**
 * Who wrote a message. A person writes from the Browser; any other driver is
 * an agent acting for the principal it signed in as. The color matches that
 * participant's live caret.
 */
export function attribution(author) {
  const person = author?.displayName?.trim() || "Collaborator";
  const driver = author?.driver?.trim() || "";
  const agent = Boolean(driver) && driver.toLowerCase() !== "browser";
  const name = agent ? driver : person;
  const { background, foreground } = presenceColor(author?.principal, driver);
  return {
    agent,
    name,
    person,
    onBehalfOf: agent ? firstName(person) : null,
    label: agent ? `${driver} on behalf of ${person}` : person,
    initials: initials(name),
    personInitials: initials(person),
    color: background,
    foreground,
    key: `${author?.principal ?? ""}/${driver.toLowerCase()}/${agent ? "" : person}`,
  };
}

/** "now", "12m", "3h", "4d", then a short date. */
export function relativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, (now - time) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Messages grouped into runs by one author within `windowMs`, so a run shows
 * one avatar. Each run keeps its messages in order.
 */
export function messageRuns(messages, windowMs = 5 * 60 * 1000) {
  const runs = [];
  for (const message of messages) {
    const who = attribution(message.author).key;
    const last = runs.at(-1);
    const previous = last?.messages.at(-1);
    const close =
      previous && Date.parse(message.createdAt) - Date.parse(previous.createdAt) <= windowMs;
    if (last && last.key === who && close) last.messages.push(message);
    else runs.push({ key: who, author: message.author, messages: [message] });
  }
  return runs;
}

const BLOCK_KINDS = {
  heading: "Section",
  paragraph: "Paragraph",
  "code-block": "Code",
  blockquote: "Quote",
  image: "Image",
  dataframe: "Dataframe",
};

function kindOf(type, parents) {
  const all = [...parents, type];
  if (all.some((t) => t === "table" || t.startsWith("table"))) return "Table";
  if (all.includes("task-list") || all.includes("task-item") || all.includes("task_list"))
    return "Checklist";
  if (all.some((t) => /list|list-item|list_item/.test(t))) return "List";
  return BLOCK_KINDS[parents[0] ?? type] ?? BLOCK_KINDS[type] ?? "Block";
}

// One pass over the Page in document order: each block's heading changes by
// text offset and its first node's kind. Cached per document version.
const outlines = new WeakMap();
function outline(doc) {
  let cached = outlines.get(doc);
  if (cached) return cached;
  const blocks = new Map();
  const path = [];
  const order = orderedBlockIds(doc);
  order.forEach((blockId, index) => {
    const block = doc.blocks[blockId];
    const entry = { index, before: [...path], changes: [], kind: "Block" };
    if (isRich(block)) {
      let offset = 0,
        first = true,
        heading = null;
      for (const span of A.spans(block, ["richText"])) {
        if (span.type === "block") {
          const type = String(span.value?.type ?? "");
          const parents = (span.value?.parents ?? []).map(String);
          if (first) entry.kind = kindOf(type, parents);
          first = false;
          heading = type === "heading" ? { level: Number(span.value?.attrs?.level) || 1 } : null;
          if (heading) heading.offset = offset;
          offset += 1;
          continue;
        }
        if (span.type === "text") {
          if (first) entry.kind = "Paragraph";
          first = false;
          const text = String(span.value ?? "");
          if (heading) {
            heading.text = (heading.text ?? "") + text;
            const level = heading.level;
            while (path.length && path.at(-1).level >= level) path.pop();
            if (path.at(-1) !== heading) path.push(heading);
            entry.changes.push({ offset: heading.offset, path: [...path] });
          }
          offset += text.length;
        }
      }
    } else {
      const source = String(block?.markdown ?? "");
      let offset = 0;
      for (const line of source.split("\n")) {
        const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
        if (offset === 0)
          entry.kind = match
            ? "Section"
            : /^\s*[-*+]\s+\[[ xX]\]/.test(line)
              ? "Checklist"
              : /^\s*([-*+]|\d+[.)])\s+/.test(line)
                ? "List"
                : /^\s*\|/.test(line)
                  ? "Table"
                  : /^\s*```/.test(line)
                    ? "Code"
                    : "Paragraph";
        if (match) {
          const level = match[1].length;
          while (path.length && path.at(-1).level >= level) path.pop();
          path.push({ level, text: plainText(match[2]) });
          entry.changes.push({ offset, path: [...path] });
        }
        offset += line.length + 1;
      }
    }
    blocks.set(blockId, entry);
  });
  cached = { blocks, length: order.length };
  outlines.set(doc, cached);
  return cached;
}

const texts = (path) => path.map((heading) => heading.text?.trim()).filter(Boolean);

/**
 * Where a thread points: `order` sorts threads in document order (missing
 * blocks last), `headings` is the heading path at the anchor, and `anchor`
 * is how to show it:
 * - `{ kind: "selection", text }` for an attached passage,
 * - `{ kind: "block", label }` for a whole-block comment ("Table · Parallel
 *   preparation"),
 * - `{ kind: "detached", blockSurvives }` when the passage is gone.
 */
export function threadLocation(doc, thread) {
  const target = thread?.target ?? {};
  const blockId = target.kind === "selection" ? target.anchor?.blockId : target.blockId;
  const blocks = doc?.blocks ?? {};
  const blockSurvives = Boolean(blockId) && Object.hasOwn(blocks, blockId);
  const map = doc?.blocks ? outline(doc) : { blocks: new Map(), length: 0 };
  const entry = blockSurvives ? map.blocks.get(blockId) : undefined;
  const context = thread?.selectionContext;
  const offset = context?.status === "attached" ? (context.start?.offsetUtf16 ?? 0) : 0;
  let path = entry?.before ?? [];
  for (const change of entry?.changes ?? []) if (change.offset <= offset) path = change.path;
  const headings = texts(path);
  let anchor;
  if (context?.status === "attached" && context.text)
    anchor = { kind: "selection", text: context.text };
  else if (target.kind === "block" && blockSurvives) {
    const within = texts(entry?.changes[0]?.path ?? entry?.before ?? []);
    const near = (entry?.kind === "Section" ? within : headings).at(-1);
    anchor = { kind: "block", label: near ? `${entry.kind} · ${near}` : entry.kind };
  } else anchor = { kind: "detached", blockSurvives };
  return {
    blockId,
    blockSurvives,
    order: [entry ? entry.index : map.length + 1, offset],
    headings,
    anchor,
  };
}

/** Compare two locations in document order. */
export const byDocumentOrder = (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1];
