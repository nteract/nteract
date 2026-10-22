import createDOMPurify from "dompurify";
import { Plugin } from "prosemirror-state";
import { parseTableMarkdown, renderTableMarkdown } from "../model/table-markdown.mjs";
import { linkDestination } from "./rich-links.mjs";

// The preview never becomes document state. Keep the original opaque node and
// exact source intact until table editing has a native rich-text representation.
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

export class PreservedTableView {
  constructor(node, doc = document) {
    this.node = node;
    this.doc = doc;
    this.dom = doc.createElement("section");
    this.dom.className = "preserved-table";
    this.dom.contentEditable = "false";
    this.toolbar = doc.createElement("div");
    this.toolbar.className = "preserved-table-toolbar";
    this.toggle = doc.createElement("button");
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-label", "Show table Markdown source");
    this.toggle.textContent = "Source";
    this.toggle.setAttribute("aria-expanded", "false");
    this.source = doc.createElement("pre");
    this.source.className = "preserved-table-source";
    this.source.setAttribute("aria-label", "Preserved Markdown source");
    this.source.hidden = true;
    this.preview = doc.createElement("div");
    this.preview.className = "preserved-table-preview";
    this.onToggle = () => {
      this.source.hidden = !this.source.hidden;
      this.preview.hidden = !this.source.hidden;
      this.toggle.textContent = this.source.hidden ? "Source" : "Preview";
      this.toggle.setAttribute("aria-expanded", String(!this.source.hidden));
      this.toggle.setAttribute(
        "aria-label",
        this.source.hidden ? "Show table Markdown source" : "Show rendered table",
      );
    };
    // Custom handleDOMEvents listeners run before ProseMirror consults a
    // node view's stopEvent. Keep preview links native without canceling them.
    this.onPreviewClick = (event) => {
      if (event.target.closest?.("a")) event.stopPropagation();
    };
    this.preview.addEventListener("click", this.onPreviewClick);
    this.toggle.addEventListener("click", this.onToggle);
    this.toolbar.append(this.toggle);
    this.dom.append(this.toolbar, this.preview, this.source);
    this.refresh();
  }

  refresh() {
    this.source.textContent = this.node.attrs.source;
    const fragment = tablePreviewFragment(this.node.attrs.source, this.doc);
    this.preview.replaceChildren(...(fragment ? [fragment] : []));
  }

  update(node) {
    if (node.type !== this.node.type || node.attrs.kind !== "markdown") return false;
    if (node.attrs.source === this.node.attrs.source) {
      this.node = node;
      return true;
    }
    if (!parseTableMarkdown(node.attrs.source)) return false;
    this.node = node;
    this.refresh();
    return true;
  }

  stopEvent(event) {
    // Preserve native controls and text selection inside the table or source.
    // Padding remains available for selecting and deleting the opaque node.
    return !!event.target.closest?.("a, button, .markdown-table-scroll, .preserved-table-source");
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.toggle.removeEventListener("click", this.onToggle);
    this.preview.removeEventListener("click", this.onPreviewClick);
  }
}

export function preservedTablePreview() {
  return new Plugin({
    props: {
      nodeViews: {
        raw(node) {
          return node.attrs.kind === "markdown" && parseTableMarkdown(node.attrs.source)
            ? new PreservedTableView(node)
            : null;
        },
      },
    },
  });
}
