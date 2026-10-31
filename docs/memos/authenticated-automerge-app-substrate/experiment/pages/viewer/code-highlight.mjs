// Syntax highlighting for code blocks with a known language. It is a view
// decoration only: Wordgard adds a `wg-t-<kind>` class to each token span and
// never writes to the document, so code text stays unmarked (#4572). Token
// colors live in wordgard.css and follow nteract's editor palette.
import {
  CSS,
  Go,
  HTML,
  JSON,
  JavaScript,
  Python,
  R,
  Rust,
  SQL,
  Shell,
  TypeScript,
  YAML,
  highlightCode,
} from "wordgard/highlight-code";
import { CodeBlockLanguage } from "wordgard/types";

// The code block language menu. Each highlights through code-highlight.mjs
// except Mermaid (a diagram) and Markdown, which stay plain.
export const CODE_LANGUAGES = Object.freeze([
  "Mermaid",
  "Bash",
  "CSS",
  "HTML",
  "JavaScript",
  "JSON",
  "Markdown",
  "Python",
  "R",
  "Rust",
  "SQL",
  "TypeScript",
  "YAML",
]);
export const HIGHLIGHT_LANGUAGES = Object.freeze([
  CSS,
  Go,
  HTML,
  JSON,
  JavaScript,
  Python,
  R,
  Rust,
  SQL,
  Shell,
  TypeScript,
  YAML,
]);

// Every name a fence may use: Wordgard's aliases plus the ones people type
// that it misses. A Map, so names like "constructor" never find inherited
// object properties.
const byName = new Map([
  ...HIGHLIGHT_LANGUAGES.flatMap((language) => language.alias.map((name) => [name, language])),
  ["py", Python],
  ["python3", Python],
  ["ipython", Python],
  ["jsx", JavaScript],
  ["mjs", JavaScript],
  ["cjs", JavaScript],
  ["tsx", TypeScript],
  ["console", Shell],
  ["shell", Shell],
  ["rs", Rust],
  ["jsonc", JSON],
  ["golang", Go],
]);

/** The highlighter for a code block's stored language. The stored value can be
 * a menu choice ("python"), a typed fence ("Python") or a Markdown info string
 * ("python title=x"), so only its first word counts, case-insensitively. */
export function languageFor(stored) {
  if (typeof stored !== "string") return null;
  const name = stored.trim().split(/\s+/)[0]?.toLowerCase();
  if (!name) return null;
  return byName.get(name) ?? null;
}

// highlightCode returns [theme, language options, decorations]. Pages keeps
// only the decorations: wordgard.css colors the tokens, and Pages' own menu
// (CODE_LANGUAGES) lists the languages.
const [, , decorations] = highlightCode({
  languages: HIGHLIGHT_LANGUAGES,
  getLanguage: (block) => languageFor(block.mark(CodeBlockLanguage)),
});
export const codeHighlighting = decorations;
