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
} from "wordgard/highlight-code";
import { StringStream } from "@codemirror/streamparser";
import { Leaf } from "wordgard/doc";
import { Decoration, decoratePlots } from "wordgard/editor";
import { CodeBlock, CodeBlockLanguage, LineBreak } from "wordgard/types";

// The code block language menu lives in shared/ so agent guidance lists it too.
export { CODE_LANGUAGES } from "../shared/code-languages.mjs";
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

/** The CodeMirror language data the language's parser carries, such as
 * `commentTokens` and `closeBrackets`. Empty for an unknown language. */
export function languageData(stored) {
  return languageFor(stored)?.parser.languageData ?? {};
}

// Mermaid never gets token decorations: it isn't in the highlighter list.
// Tokenizing follows wordgard/highlight-code: the same language parsers, token
// classes and 10,000-character cap. Pages keeps its own language aliases and
// token classes, so it feeds its tokenizer to decoratePlots rather than using
// highlightCode, which also brings Wordgard's theme and language menu.
const MAX_HIGHLIGHT = 10_000;
const tokenClassCache = new Map();
export function tokenClass(token) {
  if (!tokenClassCache.has(token)) tokenClassCache.set(token, classify(token));
  return tokenClassCache.get(token);
}
function classify(token) {
  if (/\.local/.test(token)) return "local";
  if (token === "variable-2" || token === "variableName.special") return "special";
  if (token === "def" || token === "variableName.definition") return "def";
  if (token.startsWith("keyword")) return "keyword";
  // Legacy modes (Python, R, Shell) tag built-in functions such as `print`
  // as "builtin"; color them like other special names.
  if (token.startsWith("builtin") || token === "variableName.standard") return "special";
  if (token.startsWith("string")) return "string";
  if (/^(variable|name)/.test(token)) return "name";
  if (/^(type|tag)/.test(token)) return "type";
  if (/^(attribute|prop)/.test(token)) return "prop";
  if (/^(error|invalid)/.test(token)) return "error";
  if (token.startsWith("number")) return "number";
  if (token.startsWith("bool")) return "bool";
  if (token.startsWith("atom")) return "atom";
  if (/^(literal|regexp|color)/.test(token)) return "literal";
  if (token.startsWith("label")) return "label";
  if (token.startsWith("class")) return "class";
  if (token.startsWith("namespace")) return "namespace";
  if (token.startsWith("macro")) return "macro";
  if (/comment/i.test(token)) return "comment";
  return null;
}
const tokenDeco = new Map();
const decoFor = (cls) => {
  if (!tokenDeco.has(cls)) tokenDeco.set(cls, Decoration.Range.attribute("class", `wg-t-${cls}`));
  return tokenDeco.get(cls);
};

function blockText(block) {
  let text = "";
  for (const child of block.content) {
    if (child.is(Leaf.Text)) text += child.param;
    else if (child.type === LineBreak.type) text += "\n";
    else if (child.isLeaf) text += " ";
    else return null;
  }
  return text;
}

function readToken(token, stream, state) {
  stream.start = stream.pos;
  for (let i = 0; i < 10; i++) {
    const result = token(stream, state);
    if (stream.pos > stream.start) return result;
  }
  stream.skipToEnd();
  return "";
}

/** Whether `probe`, appended to `prefix`, joins a string, quote or comment
 * token as `parser` reads it. */
function probeJoinsString(parser, prefix, probe) {
  const state = parser.startState ? parser.startState(2) : true;
  const lines = (prefix + probe).split("\n");
  const last = lines.pop();
  for (const line of lines) {
    const stream = new StringStream(line, 4, 2);
    if (stream.eol()) parser.blankLine?.(state, 2);
    while (!stream.eol()) readToken(parser.token, stream, state);
  }
  const stream = new StringStream(last, 4, 2);
  for (;;) {
    const token = readToken(parser.token, stream, state);
    if (stream.eol()) return /string|quote|comment/.test(token || "");
  }
}

/** Whether `offset` in code block `text` of `stored` language lies inside a
 * string or a comment, as the highlighter's tokenizer reads the block up to
 * it. The tokenizer reads a probe character placed at `offset`: inside a
 * string or comment it joins that token. Each probe can start one by itself
 * elsewhere (">" makes CSS `url(>` an unquoted string and JavaScript `-->` a
 * comment; ")" is an unquoted HTML attribute value), so the offset counts as
 * inside only when both join.
 *
 * Tokenizers that keep no state for an unfinished string read the probe as
 * outside it: a multi-line YAML quoted scalar, an R backtick name, and Shell
 * text right after `$` in a double-quoted string. Past the highlight cap the
 * answer is true, so callers that pair quotes hold back. Null for a language
 * with no highlighter. */
export function insideStringOrComment(stored, text, offset) {
  const language = languageFor(stored);
  if (!language) return null;
  if (offset >= MAX_HIGHLIGHT) return true;
  const prefix = text.slice(0, offset);
  return (
    probeJoinsString(language.parser, prefix, ">") && probeJoinsString(language.parser, prefix, ")")
  );
}

/** Add token decorations for a code block, relative to the start of its content. */
function addCodeBlockTokens(block, add) {
  const language = languageFor(block.mark(CodeBlockLanguage));
  const text = language && blockText(block);
  if (!text) return;
  const { parser } = language;
  let offset = 0;
  const state = parser.startState ? parser.startState(2) : true;
  // The cap is applied before tokenizing: the tokenizer never sees text past
  // it, so one huge token or a run of blank lines can't exceed it either.
  for (const line of text.slice(0, MAX_HIGHLIGHT).split("\n")) {
    const stream = new StringStream(line, 4, 2);
    if (stream.eol()) parser.blankLine?.(state, 2);
    else
      while (!stream.eol()) {
        const token = readToken(parser.token, stream, state);
        const cls = token && tokenClass(token);
        if (cls) add(decoFor(cls), offset + stream.start, offset + stream.pos);
      }
    offset += line.length + 1;
  }
}

export const codeHighlighting = decoratePlots({ type: CodeBlock, ranges: addCodeBlockTokens });
