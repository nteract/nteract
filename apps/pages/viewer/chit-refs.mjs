// The tab's PageRefs, for chits (page-chits.mjs). The shell creates the
// store (main.jsx) before the editor chunk loads; this module has no editor
// dependencies, so giving it here doesn't pull Wordgard into the shell.
let refs = null;

/** Give chits the tab's PageRefs. */
export function provideChitRefs(pageRefs) {
  refs = pageRefs;
}

/** The tab's PageRefs, or null before the shell gave them. */
export const chitRefs = () => refs;
