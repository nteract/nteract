// Math and HTML Pages can't represent: the scan that finds them outside code,
// the refusal agent writes get, and the literal escaping imports and exports
// use. Works on source text and markdown-it block tokens only.
import MarkdownIt from "markdown-it";
import { normalizeHighlight } from "./marks.mjs";
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN, splitCells, tokenizer } from "./markdown-tokenizer.mjs";

// Pages has no math node. These rules decide what Markdown counts as math:
// - A `$$` at a line start, after optional spaces, opens display math.
// - A `$$` pair on one line is display math, with or without spaces.
// - A `$` pair follows Pandoc's dollar rule: the opening `$` is followed by a
//   non-space, the closing `$` follows a non-space and is not followed by a
//   digit. Prose such as "$30 and $25" stays native text.
// When unsure, the text counts as math. Each rule spells out its spaces
// instead of using `\s`:
// - The dollar rule's spaces are ASCII whitespace, [ \t\n\v\f\r]. Any other
//   character is content, so the span counts as math.
// - Before a line-start `$$`, a space is a character that does not start a
//   line: ASCII space, tab, VT and FF, U+00A0, U+0085, U+1680,
//   U+2000-U+200A, U+202F, U+205F, U+3000, U+FEFF.
// A line starts at the start of input or after LF, CR, CRLF, U+2028 or
// U+2029. The pattern has no multiline flag and writes line starts as
// `(?:^|\r\n?|[\n\u2028\u2029])`. Line terminators are not in the prefix
// class, so the alternatives never overlap and a run of line breaks is
// scanned once. Each repetition has disjoint branches, so matching is linear.
// Every `\uXXXX` escape is a BMP code point, so the pattern needs no `u` flag.
export const MATH_SYNTAX =
  /(?:^|\r\n?|[\n\u2028\u2029])[ \t\v\f\u00a0\u0085\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*\$\$|\$\$(?:[^\n$]|\$[^\n$])*\$\$|\$[^ \t\n\v\f\r$](?:[^ \t\n\v\f\r$]|[ \t\v\f\r]+[^ \t\n\v\f\r$])*\$(?:[^0-9]|$)/;

// Markdown Pages can't represent, and what happens to it.
//
// Every construct Markdown-it reads has a native mapping except two: math and
// HTML other than highlight tags (and `<br>` in a table cell). The scan finds
// both outside code. Code spans, fenced and indented code, and characters a
// backslash escapes are masked first, so `~~x~~` or `$x$` inside backticks is
// code, not syntax.
//
// Agent writes refuse such source with `unsupported_markdown`, naming the
// construct, line and column (`parseAgentMarkdown`). Everything else
// (preserved-block migration, legacy blocks, read projections) keeps it as
// literal, editable text: the scan's ranges are backslash-escaped before
// parsing, so math keeps its exact characters (`parseMarkdown`). Export
// escapes the same ranges, so read-then-write never trips the refusal.
//
// The scan is linear in the input. Page Markdown can be close to the record
// size limit, so no step may rescan a run of line breaks, spaces or brackets:
// code spans pair through per-length queues that only move forward, the math
// pattern runs once over the text, and each tag or link destination is read
// within a bounded window.

// Block structure only: which lines are code, tables or inline content.
const blockTokenizer = new MarkdownIt("commonmark", {
  html: false,
  linkify: false,
})
  .enable("table")
  .disable(["inline", "text_join"]);
const MASKED = "\u0000";
const isAsciiPunctuation = (code) =>
  (code >= 0x21 && code <= 0x2f) ||
  (code >= 0x3a && code <= 0x40) ||
  (code >= 0x5b && code <= 0x60) ||
  (code >= 0x7b && code <= 0x7e);
// Markdown-it reads CRLF and CR as LF and NUL as U+FFFD before parsing. The
// scan reads the same text, so its line numbers are Markdown-it's lines.
export const normalizeSource = (source) =>
  String(source).replace(/\r\n?/g, "\n").replaceAll("\u0000", "\ufffd");

// Mark code spans and backslash escapes in source[start, end). A backtick run
// opens a span when its first backtick is not escaped; the span closes at the
// next run of exactly the same length. Inside a span, backslashes are literal.
function maskInline(source, masked, start, end) {
  const runs = new Map(); // length -> start offsets of maximal backtick runs
  for (let i = start; i < end; ) {
    if (source.charCodeAt(i) !== 0x60) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && source.charCodeAt(j) === 0x60) j++;
    if (!runs.has(j - i)) runs.set(j - i, { at: 0, starts: [] });
    runs.get(j - i).starts.push(i);
    i = j;
  }
  const closer = (length, after) => {
    const queue = runs.get(length);
    if (!queue) return -1;
    while (queue.at < queue.starts.length && queue.starts[queue.at] < after) queue.at++;
    return queue.at < queue.starts.length ? queue.starts[queue.at] : -1;
  };
  for (let i = start; i < end; ) {
    const code = source.charCodeAt(i);
    if (code === 0x5c && i + 1 < end && isAsciiPunctuation(source.charCodeAt(i + 1))) {
      masked[i + 1] = 1;
      i += 2;
      continue;
    }
    if (code !== 0x60) {
      i++;
      continue;
    }
    let j = i;
    while (j < end && source.charCodeAt(j) === 0x60) j++;
    const close = closer(j - i, j);
    if (close < 0) {
      i = j;
      continue;
    }
    masked.fill(1, i, close + (j - i));
    i = close + (j - i);
  }
}

// Link destinations and titles, after `](` or a definition's `]:`, are URLs
// and quoted text, never math or HTML: `[a](<x>)` is a link to `x`. Each is
// read with Markdown-it's own helpers, at most LINK_WINDOW characters, so each
// `]` costs a bounded read. A longer destination is scanned like prose. A `](`
// Markdown-it doesn't read as a link stays masked too; that only accepts text
// Markdown-it keeps literal anyway.
const LINK_WINDOW = 4096;
const { parseLinkDestination, parseLinkTitle } = tokenizer.helpers;
function maskDestinations(source, masked) {
  const skipSpace = (at, newlines) => {
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === 0x0a) {
        if (!newlines--) break;
      } else if (code !== 0x20 && code !== 0x09) break;
      at++;
    }
    return at;
  };
  for (let at = source.indexOf("]"); at >= 0; at = source.indexOf("]", at + 1)) {
    const next = source.charCodeAt(at + 1);
    if (masked[at] || (next !== 0x28 && next !== 0x3a)) continue;
    const start = skipSpace(at + 2, 1);
    const destination = parseLinkDestination(
      source,
      start,
      Math.min(source.length, start + LINK_WINDOW),
    );
    if (!destination.ok) continue;
    let end = destination.pos;
    const titleStart = skipSpace(end, 1);
    if (titleStart > end) {
      const title = parseLinkTitle(
        source,
        titleStart,
        Math.min(source.length, titleStart + LINK_WINDOW),
      );
      if (title.ok) end = title.pos;
    }
    masked.fill(1, start, end);
    at = end - 1;
  }
}

/**
 * Math and HTML outside code in the normalized `source`. Returns `found`, the
 * `{ construct, start, end }` ranges in order and not overlapping, and
 * `masked`, which flags each code or escaped position.
 */
export function scanMarkdown(source, tokens = blockTokenizer.parse(source, {})) {
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1))
    lineStarts.push(i + 1);
  const offset = (line) => (line < lineStarts.length ? lineStarts[line] : source.length);
  const masked = new Uint8Array(source.length);
  // Inline content, as `[start, end, inTable]`, in order: where code spans
  // pair and where HTML can be. A table cell is its own range, as Markdown-it
  // splits cells before reading their inline content.
  const inline = [];
  for (const token of tokens) {
    if (!token.map) continue;
    const start = offset(token.map[0]),
      end = offset(token.map[1]);
    if (token.type === "fence" || token.type === "code_block") masked.fill(1, start, end);
    else if (token.type === "inline") inline.push([start, end, false]);
    else if (token.type === "table_open")
      for (let line = token.map[0]; line < token.map[1]; line++) {
        if (line === token.map[0] + 1) continue; // the delimiter row
        const lineStart = offset(line);
        const lineEnd = Math.max(lineStart, offset(line + 1) - 1);
        const starts = splitCells(source.slice(lineStart, lineEnd));
        starts.forEach((cell, index) =>
          inline.push([
            lineStart + cell,
            index + 1 < starts.length ? lineStart + starts[index + 1] - 1 : lineEnd,
            true,
          ]),
        );
      }
  }
  for (const [start, end] of inline) maskInline(source, masked, start, end);
  maskDestinations(source, masked);
  // Line breaks stay, so the line-start rules still see every line.
  let text = source;
  if (masked.includes(1)) {
    const chars = source.split("");
    for (let i = 0; i < chars.length; i++) if (masked[i] && chars[i] !== "\n") chars[i] = MASKED;
    text = chars.join("");
  }
  const found = [];
  const math = new RegExp(MATH_SYNTAX.source, "g");
  const blank = /\n[ \t]*\n/g;
  let paragraphEnd = -1;
  for (let match = math.exec(text); match; match = math.exec(text)) {
    const first = match.index + match[0].indexOf("$"),
      matched = match.index + match[0].length;
    let end;
    if (matched - first === 2) {
      // A line-start `$$` opens display math. It runs to the next `$$` before
      // a blank line, or to that blank line.
      if (paragraphEnd < matched) {
        blank.lastIndex = matched;
        paragraphEnd = blank.exec(text)?.index ?? text.length;
      }
      const close = text.indexOf("$$", matched);
      end = close >= 0 && close < paragraphEnd ? close + 2 : paragraphEnd;
    } else if (text[first + 1] === "$") end = matched;
    // The dollar rule's body holds no `$`, and its match may read one more
    // character after the closing `$`.
    else end = text.indexOf("$", first + 1) + 1;
    found.push({ construct: "math", start: first, end });
    math.lastIndex = end;
  }
  const mathCount = found.length;
  let inMath = 0;
  const tags = text.includes("<") ? tagMatcher(text) : null;
  for (const [rangeStart, rangeEnd, inTable] of tags ? inline : []) {
    for (let at = text.indexOf("<", rangeStart); at >= 0 && at < rangeEnd; ) {
      while (inMath < mathCount && found[inMath].end <= at) inMath++;
      if (inMath < mathCount && found[inMath].start <= at) {
        at = text.indexOf("<", found[inMath].end);
        continue;
      }
      const end = tags.match(at, rangeEnd);
      if (end < 0) {
        at = text.indexOf("<", at + 1);
        continue;
      }
      const tag = text.slice(at, end);
      const highlight = [HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE].some((pattern) => {
        const match = pattern.exec(tag);
        return match?.[0].length === tag.length && highlightColorValid(match);
      });
      const tableBreak = inTable && TABLE_BREAK.exec(tag)?.[0].length === tag.length;
      if (!highlight && !tableBreak) found.push({ construct: "html", start: at, end });
      at = text.indexOf("<", end);
    }
  }
  // An HTML comment or instruction can span a math range. Overlapping ranges
  // merge, and the first one names the construct.
  const merged = [];
  for (const range of found.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return { found: merged, masked };
}

// CommonMark raw HTML, recognized at a `<` within an inline range: an open or
// closing tag, a comment, a processing instruction, a declaration or CDATA.
// `match(at, end)` returns the tag's end, or -1. Whitespace is ASCII, as in
// CommonMark.
//
// The work is linear in the text. A quoted attribute value jumps to its
// closing quote through a precomputed next-quote table. Comment, instruction,
// declaration and CDATA ends come from forward searches whose start only
// moves forward, so no stretch of text is searched twice. Walks over names,
// spaces and unquoted values cost one step a character, and only a quoted
// value can hold a later `<`, so a re-walk needs a quote pair; past a budget
// of steps (only adversarial input reaches it) every remaining `<` reads as
// HTML, which only ever escapes it.
function tagMatcher(text) {
  const length = text.length;
  const nextOf = (char) => {
    const table = new Int32Array(length + 1).fill(-1);
    for (let i = length - 1; i >= 0; i--) table[i] = text[i] === char ? i : table[i + 1];
    return table;
  };
  let doubleQuote, singleQuote;
  const searches = new Map();
  const after = (needle, from) => {
    let search = searches.get(needle);
    if (!search) searches.set(needle, (search = { from: -1, at: -1 }));
    if (from < search.from || (search.at >= 0 && from > search.at) || search.from < 0) {
      search.from = from;
      search.at = text.indexOf(needle, from);
    }
    return search.at;
  };
  let budget = 16 * length + 4096;
  const code = (i) => text.charCodeAt(i);
  const isSpace = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  const isLetter = (c) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
  const isDigit = (c) => c >= 0x30 && c <= 0x39;
  const nameChar = (c) => isLetter(c) || isDigit(c) || c === 0x2d;
  const attrStart = (c) => isLetter(c) || c === 0x5f || c === 0x3a;
  const attrChar = (c) => attrStart(c) || isDigit(c) || c === 0x2e || c === 0x2d;
  // Not space or a control character, and not one of " ' = < > `.
  const unquoted = (c) =>
    c > 0x20 && c !== 0x22 && c !== 0x27 && c !== 0x3d && c !== 0x3c && c !== 0x3e && c !== 0x60;
  const bounded = (at, needle, end) =>
    at >= 0 && at + needle.length <= end ? at + needle.length : -1;
  function match(at, end) {
    if (budget < 0) return at + 1;
    const walk = (i, test) => {
      const start = i;
      while (i < end && test(code(i))) i++;
      budget -= i - start + 1;
      return i;
    };
    const next = code(at + 1);
    if (next === 0x21) {
      if (text.startsWith("<!--", at)) {
        if (text.startsWith("<!-->", at)) return at + 5 <= end ? at + 5 : -1;
        if (text.startsWith("<!--->", at)) return at + 6 <= end ? at + 6 : -1;
        return bounded(after("-->", at + 4), "-->", end);
      }
      if (text.startsWith("<![CDATA[", at)) return bounded(after("]]>", at + 9), "]]>", end);
      if (isLetter(code(at + 2))) return bounded(after(">", at + 2), ">", end);
      return -1;
    }
    if (next === 0x3f) return bounded(after("?>", at + 2), "?>", end);
    if (next === 0x2f) {
      if (!isLetter(code(at + 2))) return -1;
      const i = walk(walk(at + 3, nameChar), isSpace);
      return i < end && code(i) === 0x3e ? i + 1 : -1;
    }
    if (!isLetter(next)) return -1;
    let i = walk(at + 2, nameChar);
    for (;;) {
      const spaced = walk(i, isSpace);
      if (spaced < end && code(spaced) === 0x3e) return spaced + 1;
      if (spaced + 1 < end && code(spaced) === 0x2f && code(spaced + 1) === 0x3e) return spaced + 2;
      if (spaced === i || spaced >= end || !attrStart(code(spaced))) return -1;
      i = walk(spaced + 1, attrChar);
      let j = walk(i, isSpace);
      if (j >= end || code(j) !== 0x3d) continue;
      j = walk(j + 1, isSpace);
      const quote = code(j);
      if (quote === 0x22 || quote === 0x27) {
        const table =
          quote === 0x22 ? (doubleQuote ??= nextOf('"')) : (singleQuote ??= nextOf("'"));
        const close = j + 1 <= length ? table[j + 1] : -1;
        if (close < 0 || close >= end) return -1;
        budget--;
        i = close + 1;
      } else {
        const valueEnd = walk(j, unquoted);
        if (valueEnd === j) return -1;
        i = valueEnd;
      }
    }
  }
  return { match };
}
const TABLE_BREAK = /^<br\s*(?:\/\s*)?>/i;
function highlightColorValid(match) {
  if (match[1] === undefined && match[2] === undefined) return true;
  try {
    normalizeHighlight(match[1] ?? match[2]);
    return true;
  } catch {
    return false;
  }
}

const CONSTRUCTS = {
  "table-cells": {
    name: "A table row with more cells than its header",
    advice:
      "Add the missing header cells, or remove the extra cells, so every row matches the header.",
  },
  definition: {
    name: "A reference definition no link uses (or a repeated label)",
    advice:
      "Use it in a link such as [text][label], or remove it. Write [label]: as \\[label]: to keep it as text.",
  },
  "wrapped-image": {
    name: "An image inside a link or formatting",
    advice:
      "Pages images can't be linked or formatted. Put the image on its own and the link next to it.",
  },
  "empty-link": {
    name: "A link with no text",
    advice: "Give the link text, as in [text](url).",
  },
  unrepresentable: {
    name: "Markdown that Pages would store with content missing",
    advice:
      "Simplify it: give every link visible text, and keep images out of links, formatting and table line breaks.",
  },
  math: {
    name: "Math",
    advice:
      "Pages has no math. Put it in a code span or a ```math code block, or escape each $ as \\$ to keep it as text.",
  },
  html: {
    name: "HTML",
    advice:
      'Use Markdown instead. Highlights use <mark data-color="...">; to keep a tag as text, put it in a code span or escape < as \\<.',
  },
};

/** The first construct Pages can't represent in `source`, outside code, as
 * `{ construct, line, column, excerpt }`, or null. Line and column are
 * 1-based; the column counts characters (code points) in that line. */
export function unsupportedMarkdown(source) {
  const text = normalizeSource(source);
  const env = {};
  return firstUnsupported(text, tokenizer.parse(text, env), env);
}
// The earliest construct, math and HTML or lossy, located.
export function firstUnsupported(text, tokens, env) {
  const [range] = scanMarkdown(text, tokens).found;
  const [lost] = env.pagesLossy ?? [];
  if (!range && !lost) return null;
  if (range && (!lost || range.start <= lost.offset)) return locate(text, range);
  return locate(text, {
    construct: lost.construct,
    start: lost.offset,
    end: lost.offset + 40,
  });
}
export function locate(text, first) {
  const lineStart = text.lastIndexOf("\n", first.start - 1) + 1;
  const lineEnd = text.indexOf("\n", first.start);
  const excerpt = text.slice(first.start, Math.min(first.end, lineEnd < 0 ? Infinity : lineEnd));
  return {
    construct: first.construct,
    line: text.slice(0, lineStart).split("\n").length,
    // Code points, not UTF-16 units.
    column: Array.from(text.slice(lineStart, first.start)).length + 1,
    excerpt: [...excerpt].slice(0, 80).join(""),
  };
}

/** The refusal for agent-written Markdown Pages can't represent. */
export function unsupportedMarkdownError(found) {
  const { name, advice } = CONSTRUCTS[found.construct];
  return Object.assign(
    Error(
      `${name} at line ${found.line}, column ${found.column} (${JSON.stringify(found.excerpt)}) isn't supported in Pages Markdown. ${advice}`,
    ),
    {
      status: 400,
      code: "unsupported_markdown",
      details: { unsupported: found },
    },
  );
}

// Backslash-escape every ASCII punctuation character in each range, outside
// code, so Markdown-it reads the range as its literal characters. A line break
// between two lines of display math becomes a hard break, so it keeps its
// lines.
export function literalize(source, { found, masked }) {
  if (!found.length) return source;
  let result = "",
    copied = 0;
  for (const { construct, start, end } of found) {
    result += source.slice(copied, start);
    for (let i = start; i < end; i++) {
      const code = source.charCodeAt(i);
      if (!masked[i]) {
        if (
          construct === "math" &&
          code === 0x0a &&
          i > start &&
          i + 1 < end &&
          source[i - 1] !== "\n" &&
          source[i + 1] !== "\n" &&
          !masked[i + 1]
        )
          result += "\\";
        else if (isAsciiPunctuation(code)) result += "\\";
      }
      result += source[i];
    }
    copied = end;
  }
  return result + source.slice(copied);
}

// Export escapes literal text that would otherwise read back as math or HTML:
// every `$` and `<` in a math or HTML range. Escaping one range can expose
// another (escaping `$a$` leaves the `$` after it unpaired, which can pair
// with a later one), so this repeats; a third pass escapes every `$` and `<`
// outside code, which always ends it. A later import, including an agent's
// write of what it read, reads the same text.
export function escapeLiteralSyntax(markdown) {
  if (!markdown.includes("$") && !markdown.includes("<")) return markdown;
  for (let pass = 0; ; pass++) {
    const { found, masked } = scanMarkdown(markdown);
    if (!found.length) return markdown;
    const ranges = pass < 2 ? found : [{ start: 0, end: markdown.length }];
    let result = "",
      copied = 0;
    for (const { start, end } of ranges)
      for (let i = start; i < end; i++) {
        if (masked[i] || (markdown[i] !== "$" && markdown[i] !== "<")) continue;
        result += `${markdown.slice(copied, i)}\\`;
        copied = i;
      }
    markdown = result + markdown.slice(copied);
  }
}
