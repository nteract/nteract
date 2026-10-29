import createDOMPurify from "dompurify";
import { parseTableMarkdown, renderTableMarkdown } from "../model/table-markdown.mjs";
import { linkDestination } from "./link-destination.mjs";

// The preview never becomes document state. Keep the original opaque node and
// exact source intact; converting it to a native table requires an editor transaction.
export function tablePreviewFragment(source, doc = document) {
  const tokens = parseTableMarkdown(source);
  if (!tokens) return null;
  // Markdown-it emits only alignment here. Turn that known value into a data
  // attribute so no arbitrary inline CSS needs to cross the sanitizer boundary.
  for (const token of tokens) {
    if (!["th_open", "td_open"].includes(token.type)) continue;
    const alignment = /^text-align:(left|center|right)$/.exec(token.attrGet("style") ?? "");
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== "style");
    if (alignment) token.attrSet("data-align", alignment[1]);
    if (token.type === "th_open") token.attrSet("scope", "col");
  }
  const fragment = createDOMPurify(doc.defaultView).sanitize(renderTableMarkdown(tokens), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "code",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    ALLOWED_ATTR: ["href", "title", "start", "scope", "data-align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const link of fragment.querySelectorAll("a")) {
    const destination = linkDestination(link.getAttribute("href"), doc.baseURI);
    if (!destination) {
      link.replaceWith(...link.childNodes);
      continue;
    }
    link.href = destination;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  for (const table of fragment.querySelectorAll("table")) {
    const scroll = doc.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Table");
    scroll.tabIndex = 0;
    table.before(scroll);
    scroll.append(table);
  }
  return fragment;
}
