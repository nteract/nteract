// Shared token scanning and preservation checks, independent of tree representation.
import { imageAlt, tokenizer } from "./markdown-tokenizer.mjs";
import {
  normalizeSource,
  firstUnsupported,
  unsupportedMarkdownError,
  locate,
} from "./markdown-scan.mjs";

export function agentTokens(source) {
  const text = normalizeSource(source),
    env = {};
  const tokens = tokenizer.parse(text, env);
  const found = firstUnsupported(text, tokens, env);
  if (found) throw unsupportedMarkdownError(found);
  return { text, tokens };
}
export function refuseLoss(text, lost) {
  const at = lost.value ? Math.max(0, text.indexOf(lost.value)) : 0;
  throw unsupportedMarkdownError(
    locate(text, { construct: "unrepresentable", start: at, end: at + 40 }),
  );
}
/** Compare native text, link destinations and each image occurrence with the
 * tokens. A link with no visible text cannot carry its destination. */
export function lostSpansContent(tokens, spans) {
  const carried = { text: [], links: new Set(), images: [], bareLink: null };
  const walk = (list) => {
    let open = null;
    for (const token of list) {
      if (token.type === "inline") walk(token.children ?? []);
      else if (["text", "code_inline", "fence", "code_block"].includes(token.type)) {
        carried.text.push(token.content);
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
  for (const span of spans) {
    if (span.type === "text") {
      produced.text.push(span.value);
      if (span.marks?.link) produced.links.add(JSON.parse(String(span.marks.link)).href);
    } else if (String(span.value.type) === "image") {
      const attrs = span.value.attrs ?? {};
      produced.images.push(JSON.stringify([String(attrs.src), String(attrs.alt ?? "")]));
    }
  }
  const squash = (parts) => parts.join("").replace(/\s+/g, "");
  if (squash(carried.text) !== squash(produced.text)) return { kind: "text" };
  for (const href of carried.links)
    if (!produced.links.has(href)) return { kind: "link", value: href };
  const remaining = new Map();
  for (const image of produced.images) remaining.set(image, (remaining.get(image) ?? 0) + 1);
  for (const image of carried.images) {
    const left = remaining.get(image) ?? 0;
    if (!left) return { kind: "image", value: JSON.parse(image)[0] };
    remaining.set(image, left - 1);
  }
  return null;
}
