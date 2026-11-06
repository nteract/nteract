// How a link mark draws in the Wordgard editors: Page blocks
// (WordgardEditor.jsx) and comments (CommentRichText.jsx). One shape for
// both, so a link to another Page gets the same class, `data-page-id` and
// glyph wherever it appears (link-destination.mjs linkAttributes).
//
// The glyph is CSS only (wordgard.css, `a.page-link::after`): no widget
// enters the editor, the link's text and stored mark don't change, and a
// pseudo-element is neither selected, copied nor a caret position.
import { Decoration } from "wordgard/editor";
import { PagesLink } from "./wordgard-model.mjs";
import { linkAttributes } from "./link-destination.mjs";

/** The link mark's shape. `currentPageId()` names the Page open now, whose
 * links are section links and get no glyph; without one, the Page the
 * address shows. */
export function pagesLinkShape({ currentPageId = () => null } = {}) {
  return Decoration.Mark.shape(PagesLink, {
    element: "a",
    attributes: (value) => {
      try {
        return linkAttributes(value, {
          base: globalThis.location.href,
          currentPageId: currentPageId(),
        });
      } catch {
        return {};
      }
    },
  });
}
