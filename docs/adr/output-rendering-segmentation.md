# Output Rendering Segmentation

**Status:** Accepted, 2026-05-26. Segmentation with six output lanes landed;
Sift, Vega, and Plotly each use standalone frames.

## Context

Notebook cells can emit a heterogeneous ordered output stream. A realistic cell
can produce stdout, progress widgets, an output widget, HTML, and a DataFrame
that renders through Sift. Historically `OutputArea` made an all-or-nothing
choice: if any output needed iframe isolation, the whole output list rendered
inside one isolated frame.

That single-frame path preserved order, but it also mixed outputs with different
interaction contracts:

- stdout/stderr and structured safe outputs do not need an iframe;
- widget and chart outputs need an iframe that can own pointer and wheel events;
- document-like HTML/markdown/SVG outputs want page scrolling by default;
- Sift tables need a click-to-engage frame so the notebook page can scroll
  through large tables until the user deliberately interacts with the table.

The problem is visible in hosted notebook-cloud and desktop. A Sift DataFrame
that shares a frame with widget/progress outputs inherits the widget frame's
focus and wheel behavior, so the table can trap page scroll. Solving this in
cloud alone would fork renderer behavior and contradict the hosted artifacts ADR:
cloud should use the shared `ReadOnlyNotebook` / `OutputArea` / isolated-frame
stack.

Related docs:

- `src/components/isolated/AGENTS.md`
- `docs/adr/frontend-sync-bridge.md`
- `docs/adr/hosted-notebook-artifacts.md`
- `docs/adr/hosted-output-origin-isolation.md`

## Decision: Segment outputs by rendering lane

`OutputArea` owns output segmentation for both desktop and hosted cloud. It
preserves the original output order, but it may render consecutive outputs in
separate lane segments when their interaction contracts differ.

The lanes (defined at `src/components/isolated/output-lane-policy.ts:22-28`):

1. **Main DOM lane (`dom`).** Outputs that are safe for the parent DOM: streams,
   classic errors/rich tracebacks, plain text, raster images, JSON, audio, and
   video. These render without an iframe.
2. **Static isolated lane (`static-frame`).** Document-like output that needs
   sandbox isolation but should not capture page scroll by default, such as
   markdown, HTML, and SVG. These frames use scroll-passthrough / click-to-engage
   behavior.
3. **Interactive isolated lane (`interactive-frame`).** Widgets, output widgets,
   maps, JavaScript, and unknown rich MIME outputs. These may need iframe-local
   pointer and wheel handling, and consecutive interactive outputs can share a
   frame.
4. **Sift isolated lane (`sift-frame`).** Each Sift-capable DataFrame output
   gets its own isolated frame. Sift remains click-to-engage so large tables do
   not trap notebook page scrolling until the user deliberately focuses the
   table.
5. **Vega isolated lane (`vega-frame`).** Vega/Vega-Lite chart outputs render in
   standalone frames to own wheel/pan interactions without affecting surrounding
   outputs. Each Vega output gets its own frame.
6. **Plotly isolated lane (`plotly-frame`).** Plotly chart outputs render in
   standalone frames for the same wheel/pan ownership reasons. Each Plotly
   output gets its own frame.

Lanes 4-6 are **standalone**: consecutive outputs in these lanes never coalesce
into a shared frame, because their wheel/pan interactions must not extend over
neighboring outputs (see `laneStandsAlone` at `output-lane-policy.ts:227-232`).

For example, a cell that emits:

```text
stdout
stdout
widget progress
widget progress update
output widget
Sift DataFrame
```

renders as:

```text
DOM segment:
  stdout
  stdout

Interactive iframe segment:
  widget progress
  widget progress update
  output widget

Sift iframe segment:
  Sift DataFrame
```

The segmentation boundary is a rendering concern only. It does not change
output IDs, output ordering, durable output manifests, renderer plugin
registration, or notebook sync semantics.

## Invariants

- Shared `OutputArea` owns this behavior; cloud viewer code must not fork a
  parallel renderer to get different segmentation.
- Iframe sandbox flags stay unchanged and must continue to omit
  `allow-same-origin`.
- Renderer plugins do not learn cloud routes such as `/api/n/:id`; host context
  and blob resolvers continue to provide URLs.
- Sift standalone framing must work in both desktop and notebook-cloud.
- Segmenting must preserve visual order and stable output IDs so renderer
  updates still target the same logical output.

## Non-Goals

- This ADR does not change the kernel output protocol or RuntimeStateDoc shape.
- This ADR does not define widget replay or output widget semantics.
- This ADR does not require every rich output to be isolated separately; only
  lane changes and Sift outputs force a frame boundary.

## Open Questions

1. Whether static isolated outputs should always be one output per frame or
   whether consecutive static outputs should continue to share one frame.
2. Whether Sift should eventually expose a parent-controlled wheel handoff API
   that lets it share an iframe with other outputs without losing page-scroll
   ergonomics.
