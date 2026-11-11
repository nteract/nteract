// The editor's view of the Pages document model. The schema, node and mark
// types and the span codec live in model/wordgard-doc.mjs, which the Worker
// shares; this module re-exports them and adds the editor's DOM-only helpers.
import { readDataframe } from "../shared/dataset-assets.mjs";
import { DATAFRAME_ATTR, plainAttrs } from "../model/wordgard-doc.mjs";
import { normalizePastedHTML, unwrapPastedAsides } from "./clipboard-html.mjs";

export * from "../model/wordgard-doc.mjs";

/** Copy HTML keeps a dataframe only when it names an asset on `pageId`. A
 * dataframe from another Page pastes as its title, because its asset isn't
 * readable here. */
export function filterPastedDataframes(html, pageId, parser = new DOMParser()) {
  if (!html.includes(DATAFRAME_ATTR)) return html;
  const doc = parser.parseFromString(html, "text/html");
  let changed = false;
  for (const figure of doc.body.querySelectorAll(`figure[${DATAFRAME_ATTR}]`)) {
    let value = null;
    try {
      value = readDataframe(plainAttrs(JSON.parse(figure.getAttribute(DATAFRAME_ATTR))));
    } catch {}
    if (value && value.src.split("/")[3] === pageId) continue;
    const text = doc.createElement("p");
    text.textContent = figure.textContent;
    figure.replaceWith(text);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/** Pasted or dropped HTML as a Page block reads it: <b> and <i> as bold and
 * italic, no aside from outside Pages, and no dataframe from another Page. */
export const pastedPageHTML = (html, pageId, parser = new DOMParser()) =>
  filterPastedDataframes(
    unwrapPastedAsides(normalizePastedHTML(html, parser), parser),
    pageId,
    parser,
  );
/** Pasted HTML as the comment composer reads it: no aside from outside
 * Pages, and no dataframe. */
export const pastedCommentHTML = (html, parser = new DOMParser()) =>
  filterPastedDataframes(unwrapPastedAsides(html, parser), null, parser);
