// Read a Mermaid diagram's title from its source text without loading the
// renderer. Two forms are recognized:
//
//   ---            frontmatter at the top of the source, any diagram type
//   title: X
//   ---
//
//   pie title X    a title statement on the header line or the first line
//   gantt          after it, for diagram types whose grammar has one
//     title X
//
// Anything else, including frontmatter without a closing fence, has no title.
// The result is plain text: use it as textContent or an attribute value, never
// as HTML.

// This runs synchronously while the editor renders a diagram, on source any
// collaborator can write. Parsing is index scanning with startsWith and
// explicit loops, never a regex with repeats that can both match whitespace.
// Line separators such as U+2028 survive the line split and are ordinary
// characters here; String.prototype.trim treats them as whitespace.
const isSpace = (char) => char === " " || char === "\t";
const ignorable = (line) => !line.trim() || line.trimStart().startsWith("%%");
const isFence = (line) => line.startsWith("---") && !line.slice(3).trim();
const titledTypes = new Set([
  "pie",
  "gantt",
  "journey",
  "timeline",
  "quadrantchart",
  "xychart",
  "xychart-beta",
]);

/** The index after one or more spaces or tabs at `index`, or -1 without any. */
function afterSpaces(text, index) {
  if (!isSpace(text[index])) return -1;
  while (isSpace(text[index])) index++;
  return index;
}

/** The index after `word` and its trailing spaces at `index`, or -1. */
function afterKeyword(text, index, word) {
  return index >= 0 && text.startsWith(word, index) ? afterSpaces(text, index + word.length) : -1;
}

// A YAML plain scalar ends at the first `#` that follows whitespace.
function stripComment(value) {
  for (let index = 1; index < value.length; index++)
    if (value[index] === "#" && isSpace(value[index - 1])) return value.slice(0, index).trimEnd();
  return value;
}

// The text of a value wrapped in `quote`, or null when it is not one. Double
// quotes take backslash escapes; single quotes escape themselves as `''`.
function quoted(value, quote, comments) {
  let text = "";
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (quote === '"' && char === "\\" && index + 1 < value.length) {
      text += value[++index];
    } else if (quote === "'" && char === "'" && value[index + 1] === "'") {
      text += "'";
      index++;
    } else if (char === quote) {
      const rest = value.slice(index + 1).trim();
      return !rest || (comments && rest.startsWith("#")) ? text : null;
    } else {
      text += char;
    }
  }
  return null;
}

// A quoted value may be followed by a YAML comment; an unquoted one ends at
// ` #`. Mermaid statement values have no comments, so `comments` is opt-in.
function unquote(value, comments) {
  const quote = value[0];
  const text = quote === '"' || quote === "'" ? quoted(value, quote, comments) : null;
  if (text !== null) return text;
  return comments ? stripComment(value) : value;
}

function frontmatterTitle(lines) {
  for (const line of lines) {
    // Top-level key only; nested `title:` under `config:` is something else.
    if (!line.startsWith("title")) continue;
    let index = "title".length;
    while (isSpace(line[index])) index++;
    if (line[index] !== ":") continue;
    const value = line.slice(index + 1).trim();
    // Block scalars (`|`, `>`) are valid YAML but not worth a YAML parser here.
    // A leading `#` is a comment, so the value is empty.
    if ("|>#".includes(value[0] ?? "-")) return null;
    return unquote(value, true).trim() || null;
  }
  return null;
}

/** The text after a title statement in `header` or the `next` line, or null. */
function statementTitle(header, next) {
  let typeEnd = 0;
  while (typeEnd < header.length && !isSpace(header[typeEnd])) typeEnd++;
  if (!titledTypes.has(header.slice(0, typeEnd).toLowerCase())) return null;
  // `pie title X` and `pie showData title X` carry the title on the header.
  let index = afterSpaces(header, typeEnd);
  const afterShowData = afterKeyword(header, index, "showData");
  if (afterShowData >= 0) index = afterShowData;
  const inline = afterKeyword(header, index, "title");
  if (inline >= 0) return header.slice(inline);
  const statement = afterKeyword(next, 0, "title");
  return statement >= 0 ? next.slice(statement) : null;
}

/** The diagram title from `source`, or null when it has none. */
export function mermaidTitle(source) {
  let text = String(source ?? "");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  // `\n?` is a single optional character after a literal, so the split stays
  // linear; it is the only regex in this file.
  const lines = text.split(/\r\n?|\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  let body = start;
  if (isFence(lines[start] ?? "")) {
    const close = lines.findIndex((line, index) => index > start && isFence(line));
    if (close < 0) return null;
    const title = frontmatterTitle(lines.slice(start + 1, close));
    if (title) return title;
    body = close + 1;
  }
  const statements = lines.slice(body).filter((line) => !ignorable(line));
  const [header = "", next = ""] = statements.map((line) => line.trim());
  const statement = statementTitle(header, next);
  return statement === null ? null : unquote(statement.trimEnd()).trim() || null;
}
