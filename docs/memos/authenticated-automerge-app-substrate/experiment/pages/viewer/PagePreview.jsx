// The read-only Page the shell shows while the editor chunk, its WASM
// runtimes and the first sync are still loading. The content comes from the
// head script's /api/connect request (early-session.mjs) as JSON built by
// model/page-preview.mjs. This component builds elements from an allowlist of
// tags and attributes; anything else keeps only its text. Its markup mirrors
// the editor's (.wordgard-document, with .preview-content for wg-content), so
// the editor's prose styles apply and the swap to the live editor doesn't move
// the text. It never renders wg-content, so nothing that finds the editor by
// that element finds the preview.
import React, { createElement } from "react";

const TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "div",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "s",
  "mark",
  "a",
  "img",
  "hr",
  "br",
  "table",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
  "input",
]);
const VOID = new Set(["img", "hr", "br", "input"]);
const DATA = new Set(["data-task-list", "data-task-checked", "data-align", "data-highlight"]);

// Spaces and control characters, which no stored URL holds (model/marks.mjs).
const unsafeText = (value) =>
  typeof value !== "string" ||
  [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127);

/** Same-origin paths and http(s)/mailto links; never a script URL. */
export function previewHref(value) {
  if (unsafeText(value)) return null;
  if (/^\/(?!\/)/.test(value) || value.startsWith("#")) return value;
  return /^(https?:|mailto:)/i.test(value) ? value : null;
}
/** Image sources the Page CSP allows that a Page can hold: its own assets and https. */
export function previewSrc(value) {
  if (unsafeText(value)) return null;
  return /^\/api\/pages\/[0-9a-f-]{36}\/assets\/[0-9a-f]{64}$/.test(value) ||
    /^https:\/\//i.test(value)
    ? value
    : null;
}

function props(tag, attrs, key) {
  const out = { key };
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return out;
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    if (DATA.has(name)) out[name] = value;
    else if (tag === "a" && name === "href") {
      const href = previewHref(value);
      if (href) out.href = href;
    } else if (tag === "a" && name === "title") out.title = value;
    else if (tag === "img" && name === "src") {
      const src = previewSrc(value);
      if (src) out.src = src;
    } else if (tag === "img" && (name === "alt" || name === "title")) out[name] = value;
    else if (tag === "input" && name === "checked") out.defaultChecked = true;
  }
  if (tag === "img") out.loading = "lazy";
  // Task checkboxes are display only, like the rest of the preview.
  if (tag === "input") Object.assign(out, { type: "checkbox", disabled: true, tabIndex: -1 });
  if (tag === "img" && !out.src) return null;
  return out;
}

/** React nodes for preview content: strings and [tag, attrs, ...children]. */
export function previewNodes(content, prefix = "n") {
  if (!Array.isArray(content)) return [];
  return content.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (typeof node === "string") return node;
    if (!Array.isArray(node) || typeof node[0] !== "string") return null;
    const [tag, attrs, ...children] = node;
    const inner = previewNodes(children, key);
    if (!TAGS.has(tag)) return createElement(React.Fragment, { key }, inner);
    const elementProps = props(tag, attrs, key);
    if (!elementProps) return null;
    return VOID.has(tag)
      ? createElement(tag, elementProps)
      : createElement(tag, elementProps, ...inner);
  });
}

/** The preview of one Page, laid out like the open Page. */
export function PagePreview({ preview }) {
  return (
    <main className="workspace document page-preview" aria-busy="true">
      <article>
        <p className="sr-only" role="status">
          Opening…
        </p>
        <h1 className="document-title document-preview-title">{preview.title || "Untitled"}</h1>
        {preview.blocks.map((block) => (
          <section className="page-block" data-preview-block={block.id} key={block.id}>
            <div className="rich-editor wordgard-editor">
              <div className="wordgard-document">
                <div className="preview-content">{previewNodes(block.content, block.id)}</div>
              </div>
            </div>
          </section>
        ))}
      </article>
    </main>
  );
}

/** Whether a value has the shape model/page-preview.mjs produces. */
export function isPagePreview(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.title === "string" &&
    Array.isArray(value.blocks) &&
    value.blocks.every(
      (block) => block && typeof block.id === "string" && Array.isArray(block.content),
    )
  );
}
