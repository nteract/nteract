import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false });
const singleLine = (text) => text.replace(/\s+/g, " ").trim();
const headingText = (title) =>
  title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/[\\`*_[\]{}()#+.!|>-]/g, "\\$&");

/** Export a current projectPage/session.snapshot projection, never raw import provenance. */
export function pageMarkdown(page) {
  if (!page) throw Error("No Page to copy");
  const title = singleLine(page.title) || "Untitled";
  const body = page.blocks.map((block) => block.markdown).join("\n\n");
  const [heading, inline] = markdown.parse(body, {});
  const leadingTitle = inline?.children
    ?.map((token) =>
      ["text", "code_inline", "image"].includes(token.type)
        ? token.content
        : ["softbreak", "hardbreak"].includes(token.type)
          ? " "
          : "",
    )
    .join("");
  // Keep an existing matching H1 as-is; do not remove headings or rewrite body content.
  const hasTitle =
    heading?.type === "heading_open" &&
    heading.tag === "h1" &&
    singleLine(leadingTitle ?? "") === title;
  const result = hasTitle ? body : `# ${headingText(title)}${body ? `\n\n${body}` : ""}`;
  return result.endsWith("\n") ? result : `${result}\n`;
}
