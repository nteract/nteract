// Code block languages, shared by the editor's language menu and the agent
// guidance. A code block stores its language as the marker's `params` string.
// The editor highlights each language through viewer/code-highlight.mjs,
// except Mermaid (rendered as a diagram) and Markdown, which stay plain.

/** The language a code block names to render as a Mermaid diagram. The whole
 * params string, trimmed and case-insensitive, must equal it. */
export const DIAGRAM_LANGUAGE = "mermaid";

export const isDiagramLanguage = (params) =>
  String(params ?? "")
    .trim()
    .toLowerCase() === DIAGRAM_LANGUAGE;

/** The code block language menu, in menu order. Stored lowercased. */
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
