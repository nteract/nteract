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

// A quoted value may be followed by a YAML comment; an unquoted one ends at
// ` #`. Mermaid statement values have no comments, so `comments` is opt-in.
function unquote(value, comments) {
  const tail = comments ? String.raw`\s*(?:#.*)?$` : "$";
  const double = new RegExp(String.raw`^"((?:[^"\\]|\\.)*)"` + tail).exec(value);
  if (double) return double[1].replace(/\\(.)/g, "$1");
  const single = new RegExp(`^'((?:[^']|'')*)'` + tail).exec(value);
  if (single) return single[1].replaceAll("''", "'");
  return comments ? value.replace(/\s+#.*$/, "") : value;
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
