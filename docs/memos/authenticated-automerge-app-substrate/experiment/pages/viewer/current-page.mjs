// The Page open in this tab, for components deep inside its UI that draw
// links: comments (CommentRichText.jsx) leave the open Page's own links
// without the Page glyph, as its blocks do (page-link-shape.mjs). The shell
// (main.jsx) provides it from the session; it is null on other screens.
import { createContext } from "react";

export const CurrentPage = createContext(null);
