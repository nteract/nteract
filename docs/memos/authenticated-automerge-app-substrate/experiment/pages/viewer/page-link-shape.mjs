// How a link mark draws in the Wordgard editors: Page blocks
// (WordgardEditor.jsx) and comments (CommentRichText.jsx). One shape for
// both, so a link to another Page or to a Project gets the same class, data
// attribute and glyph wherever it appears (link-destination.mjs
// linkAttributes).
//
// The glyphs are CSS only (wordgard.css, `a.page-link::after` and
// `a.project-link::after`): no widget enters the editor, the link's text and
// stored mark don't change, and a pseudo-element is neither selected, copied
// nor a caret position.
import { Decoration } from "wordgard/editor";
import { PagesLink } from "./wordgard-model.mjs";
import { linkAttributes } from "./link-destination.mjs";

/** The link mark's shape. `currentPageId()` names the Page open now, whose
 * links are section links and get no glyph, and `currentProjectId()` the
 * Project whose content is open now, whose own links get none either;
 * without them, what the address shows. */
export function pagesLinkShape({ currentPageId = () => null, currentProjectId = () => null } = {}) {
  return Decoration.Mark.shape(PagesLink, {
    element: "a",
    attributes: (value) => {
      try {
        return linkAttributes(value, {
          base: globalThis.location.href,
          currentPageId: currentPageId(),
          currentProjectId: currentProjectId(),
        });
      } catch {
        return {};
      }
    },
  });
}
