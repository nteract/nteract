// What is open in this tab, for components deep inside its UI that draw
// links: comments (CommentRichText.jsx) and Page blocks
// (WordgardEditor.jsx) leave links to what is open without a glyph
// (page-link-shape.mjs). The shell (main.jsx) provides both.
//
// - CurrentPage: the Page open now, from the session; null on other screens.
// - CurrentProject: the Project whose content is open now (its route, or its
//   content document); null otherwise, including in an ordinary Page of a
//   Project, where a link to the Project still gets its glyph.
import { createContext } from "react";

export const CurrentPage = createContext(null);
export const CurrentProject = createContext(null);
