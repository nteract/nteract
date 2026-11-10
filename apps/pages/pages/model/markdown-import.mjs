// Markdown to a native tree: literal imports, agent writes that refuse what
// Pages can't represent, inline replacement Markdown, and the preservation
// check behind both.
import { encode } from "./wordgard-doc.mjs";
import { tokenizer } from "./markdown-tokenizer.mjs";
import { literalize, normalizeSource, scanMarkdown } from "./markdown-scan.mjs";
import { literalDoc, parseTokens } from "./markdown-native.mjs";
import { agentTokens, lostSpansContent, refuseLoss } from "./markdown-import-policy.mjs";
export { parseInlineMarkdown } from "./markdown-inline.mjs";

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
  return lostSpansContent(tokens, encode(doc));
}

/** Markdown an agent wrote, as native rich text. Throws a 400
 * `unsupported_markdown` refusal naming the first construct Pages can't
 * represent, so the agent can rewrite and retry. */
export function parseAgentMarkdown(source) {
  const { text, tokens } = agentTokens(source);
  const doc = parseTokens(tokens);
  const lost = lostContent(tokens, doc);
  if (lost) refuseLoss(text, lost);
  return doc;
}
