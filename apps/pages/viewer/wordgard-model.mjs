// The editor's view of the Pages document model. The schema, node and mark
// types and the span codec live in model/wordgard-doc.mjs, which the Worker
// shares; this module re-exports them and adds the editor's DOM-only helpers.
import { parseAssetPath, readDataframe } from "../shared/dataset-assets.mjs";
import { DATAFRAME_ATTR, plainAttrs } from "../model/wordgard-doc.mjs";
import { VIEW_ATTR } from "../shared/views.mjs";
import { normalizePastedHTML, unwrapPastedAsides } from "./clipboard-html.mjs";
import { COPY_ATTR, stripCopyMarkers } from "./copy-registry.mjs";

export * from "../model/wordgard-doc.mjs";

/** The stored attrs a pasted figure carries, or null when they aren't a
 * dataframe this build reads. */
function figureAttrs(figure) {
  try {
    const value = plainAttrs(JSON.parse(figure.getAttribute(DATAFRAME_ATTR)));
    return value && readDataframe(value) ? value : null;
  } catch {
    return null;
  }
}

/** The datasets of pasted dataframes that name another Page than `pageId`,
 * one entry per distinct src: `{ src, pageId, assetId }`. */
export function foreignDataframes(html, pageId, parser = new DOMParser()) {
  if (!pageId || !html?.includes(DATAFRAME_ATTR)) return [];
  const doc = parser.parseFromString(html, "text/html");
  const found = new Map();
  for (const figure of doc.body.querySelectorAll(`figure[${DATAFRAME_ATTR}]`)) {
    const value = figureAttrs(figure);
    const path = value && parseAssetPath(value.src);
    if (path && path.pageId !== pageId && !found.has(value.src))
      found.set(value.src, { src: value.src, ...path });
  }
  return [...found.values()];
}

/** Copy HTML keeps a dataframe only when it names an asset on `pageId`. A
 * dataframe from another Page pastes as its title, because its asset isn't
 * readable here, unless `copied` maps its src to this Page's copy of the
 * same asset: then it keeps its attrs with that src. */
export function filterPastedDataframes(html, pageId, parser = new DOMParser(), copied = new Map()) {
  if (!html.includes(DATAFRAME_ATTR) && !html.includes(COPY_ATTR)) return html;
  const doc = parser.parseFromString(html, "text/html");
  // A copy marker (copy-registry.mjs) is never content.
  let changed = stripCopyMarkers(doc);
  for (const figure of doc.body.querySelectorAll(`figure[${DATAFRAME_ATTR}]`)) {
    const value = figureAttrs(figure);
    const path = value && parseAssetPath(value.src);
    if (value?.binding && pageId && figure.getAttribute("data-pages-source-page") === pageId)
      continue;
    if (path && pageId && path.pageId === pageId) continue;
    const local = value && copied.get(value.src);
    if (local && parseAssetPath(local)?.pageId === pageId) {
      figure.setAttribute(DATAFRAME_ATTR, JSON.stringify({ ...value, src: local }));
    } else {
      const text = doc.createElement("p");
      text.textContent = figure.textContent;
      figure.replaceWith(text);
    }
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/** Pasted or dropped HTML as a Page block reads it: <b> and <i> as bold and
 * italic, no aside from outside Pages, and no dataframe from another Page
 * but those in `copied` (filterPastedDataframes). */
export const pastedPageHTML = (html, pageId, parser = new DOMParser(), copied) =>
  filterPastedDataframes(
    unwrapPastedAsides(normalizePastedHTML(html, parser), parser),
    pageId,
    parser,
    copied,
  );

/** HTML with each view figure replaced by a paragraph of its text, for a
 * composer that can't hold a view. */
function viewsAsText(html, parser) {
  if (!html.includes(VIEW_ATTR)) return html;
  const doc = parser.parseFromString(html, "text/html");
  const figures = doc.body.querySelectorAll(`figure[${VIEW_ATTR}]`);
  if (!figures.length) return html;
  for (const figure of figures) {
    const text = doc.createElement("p");
    text.textContent = figure.textContent;
    figure.replaceWith(text);
  }
  return doc.body.innerHTML;
}

/** Pasted HTML as the comment composer reads it: no aside from outside
 * Pages, and no dataframe or view. */
export const pastedCommentHTML = (html, parser = new DOMParser()) =>
  viewsAsText(filterPastedDataframes(unwrapPastedAsides(html, parser), null, parser), parser);
