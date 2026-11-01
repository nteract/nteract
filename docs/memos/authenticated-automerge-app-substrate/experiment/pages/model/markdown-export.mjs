import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false });
// Titles, names and passages are user input. `\s+` consumes a whole run per
// match, and the other patterns match one character, so each pass is linear.
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

const quoted = (text) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

/** A Markdown section listing comment messages in `page` that `saved` lacks
 * (new messages, or bodies edited since). Both arguments are projectPage
 * projections; `saved` is the host-acknowledged state, or null when unknown,
 * in which case every comment is listed. Returns "" when nothing is unsent. */
export function unsentCommentsMarkdown(page, saved) {
  const savedThreads = new Map((saved?.comments ?? []).map((thread) => [thread.id, thread]));
  const sections = [];
  for (const thread of page.comments ?? []) {
    const before = savedThreads.get(thread.id);
    const lines = [];
    thread.messages.forEach((message, index) => {
      if (message.deletedAt) return;
      const old = before?.messages.find((candidate) => candidate.id === message.id);
      if (old && !old.deletedAt && old.body === message.body) return;
      const kind = old ? "edited" : index === 0 ? "comment" : "reply";
      const who = singleLine(message.author?.displayName ?? "") || "Collaborator";
      lines.push(`**${who}** · ${kind} · ${message.createdAt}\n\n${quoted(message.body ?? "")}`);
    });
    if (!lines.length) continue;
    const { target, selectionContext } = thread;
    const passage =
      selectionContext?.status === "attached"
        ? selectionContext.text
        : page.blocks.find((block) => block.id === target?.blockId)?.markdown;
    const anchor = singleLine(passage ?? "").slice(0, 120);
    sections.push(
      [`### ${anchor ? `On “${anchor}”` : "On this Page"}`, `Thread ${thread.id}`, ...lines].join(
        "\n\n",
      ),
    );
  }
  if (!sections.length) return "";
  const note = saved
    ? "These comments and replies never reached the server. Add them again after you reopen the Page."
    : "These comments and replies may not have reached the server. Check the Page and add any that are missing.";
  return `\n---\n\n## Unsent comments\n\n${note}\n\n${sections.join("\n\n")}\n`;
}

/** A Markdown section for comment drafts the person typed but never sent:
 * `{ kind: "comment" | "reply", body, quote?, thread_id? }`, as recovery
 * records keep them. Returns "" when there are none. */
export function commentDraftsMarkdown(drafts) {
  const sections = (drafts ?? [])
    .filter((draft) => typeof draft?.body === "string" && draft.body.trim())
    .map((draft) => {
      const anchor = singleLine(draft.quote ?? "").slice(0, 120);
      const heading = anchor ? `### On “${anchor}”` : "### On this Page";
      const kind = draft.kind === "reply" ? `Reply to thread ${draft.thread_id}` : "New comment";
      return [heading, kind, quoted(draft.body)].join("\n\n");
    });
  if (!sections.length) return "";
  return `\n---\n\n## Unsent comment drafts\n\nThese drafts were never sent. Add them again if you still need them.\n\n${sections.join("\n\n")}\n`;
}
