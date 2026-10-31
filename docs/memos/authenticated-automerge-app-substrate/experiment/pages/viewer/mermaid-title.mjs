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

const fence = /^---\s*$/;
const ignorable = (line) => !line.trim() || line.trimStart().startsWith("%%");
const titledTypes = new Set([
  "pie",
  "gantt",
  "journey",
  "timeline",
  "quadrantchart",
  "xychart",
  "xychart-beta",
]);

// This runs synchronously while the editor renders a diagram, on source any
// collaborator can write. Every pass below is a single linear scan; regexes in
// this file stay anchored with no nested or adjacent ambiguous repeats.
const isSpace = (char) => char === " " || char === "\t";

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
    const match = /^title\s*:(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    // Block scalars (`|`, `>`) are valid YAML but not worth a YAML parser here.
    // A leading `#` is a comment, so the value is empty.
    if (/^[|>#]/.test(value)) return null;
    return unquote(value, true).trim() || null;
  }
  return null;
}

/** The diagram title from `source`, or null when it has none. */
export function mermaidTitle(source) {
  const lines = String(source ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r\n?|\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  let body = start;
  if (fence.test(lines[start] ?? "")) {
    const close = lines.findIndex((line, index) => index > start && fence.test(line));
    if (close < 0) return null;
    const title = frontmatterTitle(lines.slice(start + 1, close));
    if (title) return title;
    body = close + 1;
  }
  const statements = lines.slice(body).filter((line) => !ignorable(line));
  const [header = "", next = ""] = statements.map((line) => line.trim());
  const type = /^\S+/.exec(header)?.[0].toLowerCase();
  if (!type || !titledTypes.has(type)) return null;
  const inline = /^\S+(?:\s+showData)?\s+title\s+(.+)$/.exec(header);
  const statement = inline ?? /^title\s+(.+)$/.exec(next);
  return statement ? unquote(statement[1].trim()).trim() || null : null;
}
