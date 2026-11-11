// HTML from other apps before Wordgard parses a paste or drop. Wordgard reads
// bold from <strong> and font-weight styles, and italic from <em> and
// font-style styles, but not from <b> or <i>, which Word, Outlook and many
// web pages write. Each <b> and <i> becomes <strong> or <em> unless its own
// style turns the weight or slant back off: Google Docs wraps a whole copy in
// <b style="font-weight:normal">, and that wrapper must not bold the paste.
const RENAMES = [
  ["b", "strong", "font-weight", (value) => /^(normal|lighter|[1-4]\d{2})$/.test(value)],
  ["i", "em", "font-style", (value) => value === "normal"],
];

export function normalizePastedHTML(html, parser = new DOMParser()) {
  if (!/<[bi][\s>]/i.test(html)) return html;
  const doc = parser.parseFromString(html, "text/html");
  let changed = false;
  for (const [from, to, property, off] of RENAMES)
    for (const element of doc.body.querySelectorAll(from)) {
      if (off(element.style?.getPropertyValue(property).trim().toLowerCase() ?? "")) continue;
      const replacement = doc.createElement(to);
      for (const { name, value } of element.attributes) replacement.setAttribute(name, value);
      replacement.append(...element.childNodes);
      element.replaceWith(replacement);
      changed = true;
    }
  return changed ? doc.body.innerHTML : html;
}

/** The attribute an aside Pages copies carries. A pasted aside without it
 * came from outside Pages. */
export const PAGES_ASIDE_ATTR = "data-pages-aside";
/** HTML from outside Pages pastes no aside: each one is replaced by its
 * content, so its paragraphs and lists land as ordinary blocks in place.
 * Pages has no Markdown form for an aside, and whether it should hold one
 * is open (DIRECTION.md). An aside copied inside Pages keeps its attribute
 * and pastes back as an aside. */
export function unwrapPastedAsides(html, parser = new DOMParser()) {
  if (!/<aside[\s>]/i.test(html)) return html;
  const doc = parser.parseFromString(html, "text/html");
  const outside = doc.body.querySelectorAll(`aside:not([${PAGES_ASIDE_ATTR}])`);
  if (!outside.length) return html;
  for (const aside of outside) aside.replaceWith(...aside.childNodes);
  return doc.body.innerHTML;
}
