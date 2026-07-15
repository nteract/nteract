# MCP tool results have two audiences

Status: doctrine, adopted 2026-07-15. Companion changes: #4049 (priority text replaces blob-URL placeholders), the agent-channel annotations branch, and the create-notebook spec refactor.

## The doctrine

Every output-bearing MCP tool result serves two consumers with opposite cost functions:

- **Content blocks are the agent channel.** Optimize for minimal token consumption, maximal contextual understanding, and navigability: the agent gets summarized text inline, knows that humans see richer rendered forms, and gets pointers (resource URIs, blob URLs with sizes) to pull more only when needed.
- **structuredContent is the human render contract.** It is literally structured content for our own rendering purposes: the MCP App renderer (output.html) hydrates tables, charts, and images from it. It must stay complete and URL-rich. Never token-optimize this channel; its shape belongs to the renderer.

A blob URL in the agent channel is a fallback for content nothing resolved, never a substitute for text the resolver already holds. A summary in the render channel is a bonus for blob-less clients, never a replacement for the hydration URLs.

## What went wrong (the 2.1 regression)

nteract 2.1 shipped `text/llm+plain` synthesis and selective MIME resolution so agents read outputs instead of sifting HTML or base64. The resolver (`resolve_cell_outputs_for_llm_aligned`, `CONTENT_PRIORITY`) kept doing that work on every execution path. But in `structured.rs`, the manifest walk emitted blob URLs for every blob-stored ContentRef including the text MIMEs, and the merge guard treated a URL placeholder as existing content. Any text crossing the 1KB inline threshold reached agents as five localhost URLs. Fixed in #4049: resolved priority text replaces URL placeholders; author-provided inline summaries keep precedence.

The second failure is routing, not shape: harnesses show agents both channels, so agents are billed for the renderer's mail (source echo, hash URLs, per-mime duplication).

## Audience annotations (rmcp 1.5)

MCP content items are `Annotated`; `Annotations.audience` takes `["user"]`, `["assistant"]`, or both. We now annotate agent-channel text (summaries, resolved output text, headers) as assistant-audience. Resource links stay unannotated (both audiences).

Open questions to verify empirically:

1. Which harnesses respect `audience` today (Claude Code, claude.ai, other MCP clients)? Test: a result with a user-only content item; check whether the model transcript contains it.
2. Does any harness suppress structuredContent from the model when content blocks exist? If not, the routing problem persists for the render channel regardless of annotations.

## The forward play: render payload as user-audience content

If harnesses respect `audience`, the renderer payload can move from structuredContent into an `EmbeddedResource` content item annotated `audience: ["user"]`. Compliant harnesses would render it for humans and never show it to the model. structuredContent stays during migration for renderer compatibility. This ends billing agents for renderer mail entirely within spec, with no harness-specific hacks. Sequence only after question 1 above is answered for the harnesses we care about.

## Agent-channel affordances (shipped alongside)

- Priority text inline, always, on every execution-result path (#4049).
- One legibility line per rich output, with sizes from ContentRef metadata: rendered for humans; fetch by URL only if needed: apache-arrow 500KB, html 20KB. Text MIMEs are excluded from the list because they arrive inline.
- The cell resource URI remains the canonical navigation handle; blob URLs are per-format escape hatches.

## Review checklist for output-touching changes

- Does the agent get readable text without fetching anything?
- Does the renderer still get every URL it hydrates from?
- Did anything add tokens to the agent channel that only the renderer needs?
- Are new content items annotated with the audience they serve?
