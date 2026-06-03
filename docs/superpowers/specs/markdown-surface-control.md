# Markdown Surface Control

Markdown is a primary notebook surface, not just another output MIME type. The
reader should be able to scroll, select, copy, expand rails, and switch between
read and edit states without seeing iframe height jumps or placeholder flashes.

## Problem

The current markdown preview path depends on an isolated rendering lifecycle that
can be too visible:

- Markdown cells and markdown outputs can briefly show the wrong height while
  the iframe measures and reports its content.
- Rail expansion and collapse can expose transient scrollbars while markdown
  frames settle.
- Text selection and copy behavior can feel worse than native document text.
- Wheel forwarding through the iframe transport can make ordinary markdown feel
  slower than a normal page.

Rich outputs still need isolation. Markdown does not always need to feel like a
foreign document.

## Goals

- Render markdown as document content first: readable, selectable, copyable, and
  scroll-native.
- Keep first paint stable enough that markdown does not shift when notebook
  chrome, rails, or iframes finish loading.
- Preserve the notebook's typography, theme, code highlighting, math, links, and
  heading anchors across desktop, hosted cloud, and Elements.
- Keep unsafe HTML and active rich embeds isolated even if ordinary markdown is
  rendered more directly.
- Leave room for a future WYSIWYG editor that edits markdown underneath while
  behaving more like a collaborative document editor.

## Requirements

### Measurement Before Rendering

Use a markdown-aware measurement path before the interactive render path becomes
available. Pretext is a promising fit because it can produce a fast, structured
layout representation for text-like content before the final DOM is ready.

The first visible markdown height should come from one of:

1. A durable previous measurement for the same markdown revision.
2. A fast local measurement using the current renderer inputs.
3. A conservative text fallback based on the raw markdown line count.

The final rendered surface may refine the height, but it should not collapse to
zero or expose a scrollbar during ordinary rail and shell transitions.

### Native Text Fallback

Before isolated renderers are ready, markdown should show useful text instead of
blank space. The fallback can be plain rendered text or lightly formatted
markdown, but it must:

- reserve approximately the same block height as the final surface,
- allow text selection and copy,
- keep links inert until the trusted click handler is attached,
- avoid executing HTML, scripts, widgets, or rich embeds.

This fallback should disappear without a visible snap once the final render path
is ready.

### Interaction Model

Ordinary markdown should scroll with the notebook. It should not send a high
volume of wheel events through JSON-RPC just to let the page continue scrolling.

Iframe or active-frame behavior should be reserved for content that genuinely
needs it:

- interactive widgets,
- Plotly, Vega, Leaflet, Sift, and similar rich renderers,
- unsafe HTML,
- anywidgets and other focused interactive surfaces.

Static markdown should support native selection and copy. If markdown stays in
an iframe for a given host, that iframe should behave like document text until a
specific interactive region is engaged.

### Rendering Package Shape

Prefer a first-party markdown package in this monorepo rather than treating
markdown rendering as opaque app glue. The package should own:

- parsing and sanitization policy,
- heading anchor generation,
- code block and math rendering hooks,
- measurement outputs,
- text fallback generation,
- render adapters for direct DOM, isolated frame, and future editor surfaces.

This keeps desktop, cloud, Elements, and future markdown documents on the same
contract.

### Editor Direction

The long-term direction should support a WYSIWYG-ish markdown editor where the
document reads like prose and still stores markdown. Future editor work should
consider:

- collaborative cursors and selections inside rendered markdown,
- editing markdown blocks without bouncing between preview and raw modes,
- stable mapping from rendered blocks back to markdown source spans,
- preserving markdown as the durable document format.

## Non-Goals

- This does not remove isolated rendering for unsafe HTML or interactive rich
  outputs.
- This does not choose the final editor engine.
- This does not require immediate migration of every markdown output path.
- This does not change notebook storage format.

## Open Questions

- Which markdown constructs require an iframe even when the rest of the markdown
  can render natively?
- Can Pretext provide enough measurement fidelity for math, code blocks, and
  embedded images, or do those need cached post-render measurements?
- Should markdown output and markdown cells share one surface package with
  different host adapters, or should authoring cells own extra editor-only
  affordances?
- How much of the fallback render should preserve formatting before the final
  renderer is ready?
