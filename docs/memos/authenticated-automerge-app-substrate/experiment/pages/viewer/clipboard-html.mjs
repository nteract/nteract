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
    for (const element of [...doc.body.querySelectorAll(from)]) {
      if (off(element.style?.getPropertyValue(property).trim().toLowerCase() ?? "")) continue;
      const replacement = doc.createElement(to);
      for (const { name, value } of element.attributes) replacement.setAttribute(name, value);
      replacement.append(...element.childNodes);
      element.replaceWith(replacement);
      changed = true;
    }
  return changed ? doc.body.innerHTML : html;
}
