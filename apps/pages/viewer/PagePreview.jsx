// The read-only Page the shell shows while the editor chunk, its WASM
// runtimes and the first sync are still loading. The content comes from the
// head script's /api/connect request (early-session.mjs) as JSON built by
// model/page-preview.mjs. This component builds elements from an allowlist of
// tags and attributes; anything else keeps only its text. Its markup mirrors
// the editor's (.wordgard-document, with .preview-content for wg-content), so
// the editor's prose styles apply and the swap to the live editor doesn't move
// the text. It never renders wg-content, so nothing that finds the editor by
// that element finds the preview.
import React, { createElement, useEffect, useRef } from "react";
import { linkedTarget } from "../shared/page-links.mjs";
import { imageLifecycle } from "./image-lifecycle.mjs";
import { targetAttributes } from "./link-destination.mjs";

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
const DATA = new Set([
  "data-task-list",
  "data-task-checked",
  "data-align",
  "data-highlight",
  // Cards (model/page-card.mjs): image and dataframe stand-ins, and a code
  // block's language.
  "data-card-placeholder",
  "data-language",
]);

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

function props(tag, attrs, key, { currentPageId = null, currentProjectId = null } = {}) {
  const out = { key };
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return out;
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    if (DATA.has(name)) out[name] = value;
    else if (tag === "a" && name === "href") {
      const href = previewHref(value);
      if (href) out.href = href;
      // The editor draws a link to another Page or a Project with its
      // glyph (link-destination.mjs); so does the preview, so the swap to
      // the editor doesn't move the text.
      const target =
        href && globalThis.location
          ? linkedTarget(href, globalThis.location.href, { currentPageId, currentProjectId })
          : null;
      const { class: className, ...data } = targetAttributes(target);
      if (className) Object.assign(out, { className, ...data });
    } else if (tag === "a" && name === "title") out.title = value;
    else if (tag === "img" && (name === "src" || name === "dark_src")) {
      const src = previewSrc(value);
      if (src) out[name] = src;
    } else if (tag === "img" && (name === "alt" || name === "title")) out[name] = value;
    else if (tag === "input" && name === "checked") out.defaultChecked = true;
  }
  if (tag === "img") out.loading = "lazy";
  // Task checkboxes are display only, like the rest of the preview.
  if (tag === "input") Object.assign(out, { type: "checkbox", disabled: true, tabIndex: -1 });
  if (tag === "img" && !out.src) return null;
  return out;
}

/** Inline marks a link can sit inside in preview content. */
const LINK_WRAPPERS = new Set(["strong", "em", "s", "code", "mark", "span"]);

/** `node`'s link when `node` is one, or a chain of single-child inline marks
 * around one: `{ attrs, unwrap }`, where `unwrap()` is `node` without that
 * link. Otherwise null. */
function linkInside(node) {
  if (!Array.isArray(node) || typeof node[0] !== "string") return null;
  const [tag, attrs, ...children] = node;
  if (tag === "a") return { attrs: attrs ?? {}, unwrap: () => children };
  if (!LINK_WRAPPERS.has(tag) || children.length !== 1) return null;
  const inner = linkInside(children[0]);
  return inner && { attrs: inner.attrs, unwrap: () => [[tag, attrs, ...inner.unwrap()]] };
}

const sameLink = (a, b) => a.href === b.href && (a.title ?? null) === (b.title ?? null);

/**
 * Preview content with each link drawn once. The host renders text runs one
 * at a time, so a link whose text is formatted arrives as sibling fragments:
 * `<a>the </a><strong><a>evening</a></strong><a> focus</a>`. This joins
 * adjacent fragments with one href into one link around the formatting,
 * `<a>the <strong>evening</strong> focus</a>`, as the editor draws it, so
 * the Page glyph appears once and the swap to the editor doesn't move text.
 */
export function joinLinks(content) {
  if (!Array.isArray(content)) return content;
  const out = [];
  let run = null;
  for (const node of content) {
    const joined = Array.isArray(node) ? [node[0], node[1], ...joinLinks(node.slice(2))] : node;
    const link = linkInside(joined);
    if (link && run && sameLink(run.attrs, link.attrs)) {
      run.node.push(...link.unwrap());
      continue;
    }
    if (link) {
      run = { attrs: link.attrs, node: ["a", link.attrs, ...link.unwrap()] };
      out.push(run.node);
      continue;
    }
    run = null;
    out.push(joined);
  }
  return out;
}

/**
 * React nodes for preview content: strings and [tag, attrs, ...children].
 *
 * `inert` renders content that sits inside another link, as a library card
 * does (PageCardPreview.jsx): links keep their text in a span, a task
 * checkbox becomes a drawn box, and images draw nothing. No interactive
 * element is rendered, so nothing nests inside the card's link.
 * `currentPageId` names the Page open now, whose own links get no glyph, and
 * `currentProjectId` the Project whose content it is, whose own links get
 * none either.
 */
export function previewNodes(content, prefix = "n", options = {}) {
  if (!Array.isArray(content)) return [];
  return drawNodes(joinLinks(content), prefix, options);
}

function drawNodes(
  content,
  prefix,
  { inert = false, currentPageId = null, currentProjectId = null } = {},
) {
  return content.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (typeof node === "string") return node;
    if (!Array.isArray(node) || typeof node[0] !== "string") return null;
    const [tag, attrs, ...children] = node;
    const inner = drawNodes(children, key, { inert, currentPageId, currentProjectId });
    if (!TAGS.has(tag)) return createElement(React.Fragment, { key }, inner);
    if (inert && tag === "a")
      return createElement("span", { key, className: "preview-link" }, ...inner);
    if (inert && tag === "img") return null;
    if (inert && tag === "input")
      return createElement("span", {
        key,
        className: "preview-check",
        "data-checked": typeof attrs?.checked === "string" ? "true" : "false",
      });
    const elementProps = props(tag, attrs, key, { currentPageId, currentProjectId });
    if (!elementProps) return null;
    if (tag === "img" && elementProps.dark_src) return createElement(PreviewImage, elementProps);
    return VOID.has(tag)
      ? createElement(tag, elementProps)
      : createElement(tag, elementProps, ...inner);
  });
}

function PreviewImage({ src, dark_src, alt, title }) {
  const ref = useRef(null);
  useEffect(() => {
    const lifecycle = imageLifecycle(ref.current, { src, dark_src, alt, title });
    lifecycle.connect();
    return () => lifecycle.disconnect();
  }, [src, dark_src, alt, title]);
  return <span className="pages-image" ref={ref} />;
}

/** The preview of one Page, laid out like the open Page. `pageId` is the
 * Page it previews, whose own links are section links; `projectId` the
 * Project it is the content of, if known, whose own links get no glyph. */
export function PagePreview({ preview, pageId = null, projectId = null }) {
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
                <div className="preview-content">
                  {previewNodes(block.content, block.id, {
                    currentPageId: pageId,
                    currentProjectId: projectId,
                  })}
                </div>
              </div>
            </div>
          </section>
        ))}
      </article>
    </main>
  );
}
