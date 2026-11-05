// Markdown to a native tree: literal imports, agent writes that refuse what
// Pages can't represent, inline replacement Markdown, and the preservation
// check behind both.
import { adapter, pmNodeToSpans } from "./pm-adapter.mjs";
import { imageAlt, tokenizer } from "./markdown-tokenizer.mjs";
import {
  firstUnsupported,
  literalize,
  locate,
  normalizeSource,
  scanMarkdown,
  unsupportedMarkdownError,
} from "./markdown-scan.mjs";
import { literalDoc, parseTokens } from "./pm-markdown-parser.mjs";

/**
 * Markdown as native rich text. Math and HTML Pages can't represent stay as
 * literal text, so this never fails on content and never writes a preserved
 * block. Content whose `kind` is not Markdown is all literal text. Use
 * `parseAgentMarkdown` for agent writes, which refuses such source instead.
 */
export function parseMarkdown(source, { kind = "markdown" } = {}) {
  if (kind !== "markdown") return literalDoc(source);
  const text = normalizeSource(source);
  let env = {};
  let tokens = tokenizer.parse(text, env);
  const scan = scanMarkdown(text, tokens);
  if (scan.found.length) tokens = tokenizer.parse(literalize(text, scan), (env = {}));
  // Markdown that would parse to less than it says stays literal, all of it.
  if (env.pagesLossy?.length) return literalDoc(source);
  const doc = parseTokens(tokens);
  return lostContent(tokens, doc) ? literalDoc(source) : doc;
}

/** What the native parse of `source` would lose, before parseMarkdown
 * falls back to literal text: `lostContent` of that parse, or null. For
 * tests and diagnostics. */
export function nativeImportLoss(source) {
  const text = normalizeSource(source);
  let env = {};
  let tokens = tokenizer.parse(text, env);
  const scan = scanMarkdown(text, tokens);
  if (scan.found.length) tokens = tokenizer.parse(literalize(text, scan), (env = {}));
  if (env.pagesLossy?.length) return { kind: "lossy-rule" };
  return lostContent(tokens, parseTokens(tokens));
}

/**
 * The general preservation check, behind the specific lossy rules: what the
 * parsed Markdown carried that the native spans don't. Every link must hold
 * visible text of its own, every link href must be in the spans, every image
 * occurrence (src and alt) must have its own marker, and all visible text
 * must match with whitespace removed. Returns `{ kind, value }` for the first loss, or null.
 *
 * The specific rules name a construct for the error; this catches whatever
 * they miss, such as a link whose only content is a line break.
 */
export function lostContent(tokens, doc) {
  const carried = { text: [], links: new Set(), images: [], bareLink: null };
  // Each link must hold visible text of its own: links are marks on text, so
  // one with only a line break or an image has nowhere to keep its href,
  // whatever other links share it.
  const walk = (list) => {
    let open = null;
    for (const token of list) {
      if (token.type === "inline") walk(token.children ?? []);
      else if (["text", "code_inline", "fence", "code_block"].includes(token.type)) {
        carried.text.push(token.content);
        // Entity newlines become unmarked Wordgard LineBreak leaves.
        if (open && /[^\n]/.test(token.content)) open.text = true;
      } else if (token.type === "link_open") {
        open = { href: token.attrGet("href"), text: false };
        carried.links.add(open.href);
      } else if (token.type === "link_close" && open) {
        if (!open.text) carried.bareLink ??= open.href;
        open = null;
      } else if (token.type === "image")
        carried.images.push(JSON.stringify([token.attrGet("src"), imageAlt(token.children) ?? ""]));
    }
  };
  walk(tokens);
  if (carried.bareLink !== null) return { kind: "link", value: carried.bareLink };
  const produced = { text: [], links: new Set(), images: [] };
  for (const span of pmNodeToSpans(adapter, doc)) {
    if (span.type === "text") {
      produced.text.push(span.value);
      const link = span.marks?.link;
      if (link) produced.links.add(JSON.parse(String(link)).href);
    } else if (String(span.value.type) === "image") {
      const attrs = span.value.attrs ?? {};
      produced.images.push(JSON.stringify([String(attrs.src), String(attrs.alt ?? "")]));
    }
  }
  const squash = (parts) => parts.join("").replace(/\s+/g, "");
  if (squash(carried.text) !== squash(produced.text)) return { kind: "text" };
  for (const href of carried.links)
    if (!produced.links.has(href)) return { kind: "link", value: href };
  // Images are embeds, one marker each: compare every occurrence.
  const remaining = new Map();
  for (const image of produced.images) remaining.set(image, (remaining.get(image) ?? 0) + 1);
  for (const image of carried.images) {
    const left = remaining.get(image) ?? 0;
    if (!left) return { kind: "image", value: JSON.parse(image)[0] };
    remaining.set(image, left - 1);
  }
  return null;
}

/** Markdown an agent wrote, as native rich text. Throws a 400
 * `unsupported_markdown` refusal naming the first construct Pages can't
 * represent, so the agent can rewrite and retry. */
export function parseAgentMarkdown(source) {
  const text = normalizeSource(source);
  const env = {};
  const tokens = tokenizer.parse(text, env);
  const found = firstUnsupported(text, tokens, env);
  if (found) throw unsupportedMarkdownError(found);
  const doc = parseTokens(tokens);
  const lost = lostContent(tokens, doc);
  if (lost) {
    // Point at the lost destination when there is one; otherwise the start.
    const at = lost.value ? Math.max(0, text.indexOf(lost.value)) : 0;
    throw unsupportedMarkdownError(
      locate(text, { construct: "unrepresentable", start: at, end: at + 40 }),
    );
  }
  return doc;
}

const inlineOnly = () =>
  Object.assign(
    Error(
      'replacement_markdown must be inline Markdown on one line: text, **bold**, *italic*, ~~strike~~, `code`, [links](url) and <mark data-color="…">highlights</mark>. Escape a leading #, >, -, *, +, 1. or ``` with a backslash.',
    ),
    { status: 400, code: "invalid_edit_selector" },
  );
/** One line of inline Markdown an agent wrote, as text runs with their stored
 * mark values: `[{ text, marks }]`. Blocks, images and line breaks are
 * refused. Markdown trims a paragraph's outer whitespace, so leading and
 * trailing spaces and tabs are kept as plain text outside the parse. */
export function parseInlineMarkdown(source) {
  if (/[\r\n]/.test(source)) throw inlineOnly();
  const lead = /^[ \t]*/.exec(source)[0];
  const trail = /[ \t]*$/.exec(source.slice(lead.length))[0];
  const middle = source.slice(lead.length, source.length - trail.length);
  const runs = lead ? [{ text: lead, marks: {} }] : [];
  if (middle) {
    const tree = parseAgentMarkdown(middle);
    if (tree.childCount !== 1 || tree.firstChild.type.name !== "paragraph") throw inlineOnly();
    for (const span of pmNodeToSpans(adapter, tree)) {
      if (span.type !== "text") throw inlineOnly();
      runs.push({ text: span.value, marks: { ...span.marks } });
    }
  }
  if (trail) runs.push({ text: trail, marks: {} });
  return runs;
}
