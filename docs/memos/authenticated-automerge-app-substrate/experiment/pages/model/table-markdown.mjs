import MarkdownIt from "markdown-it";

// Use the same Markdown parser family as the rich editor, with its built-in
// table rule. This is a view of preserved source, not another document model.
const markdown = new MarkdownIt("commonmark", { html: false, linkify: false }).enable("table");

// Preserve an image's description without starting a remote resource request.
markdown.renderer.rules.image = (tokens, index) => {
  const alt = markdown.renderer.renderInlineAsText(
    tokens[index].children ?? [],
    markdown.options,
    {},
  );
  return markdown.utils.escapeHtml(alt ? `[Image: ${alt}]` : "[Image omitted]");
};

export function parseTableMarkdown(source) {
  if (typeof source !== "string" || !source.includes("|")) return null;
  const tokens = markdown.parse(source, {});
  return tokens.some((token) => token.type === "table_open") ? tokens : null;
}

export function renderTableMarkdown(tokens) {
  return markdown.renderer.render(tokens, markdown.options, {});
}
