# MCP App Renderer Unification

The MCP App output view should converge on the same isolated output renderer used
by the desktop app. The long-term target is a thin MCP App shell that receives
`ui/notifications/tool-result`, adapts nteract `structuredContent`, and delegates
all rich output rendering to `createNteractOutputEmbed`.

## Why Not Import Output Components Directly?

The MCP App document is already the spec-level app iframe. Rendering notebook
HTML directly in that document would put untrusted cell output in the same
JavaScript realm as the MCP Apps JSON-RPC bridge. That differs from the desktop
app, where rich HTML runs inside the sandboxed isolated output frame.

The safe shared boundary is therefore:

1. Host renders `ui://nteract/output.html` as an MCP App.
2. The MCP App receives tool results via MCP Apps JSON-RPC.
3. The MCP App converts nteract structured content into shared output manifests.
4. `createNteractOutputEmbed` creates a nested sandboxed nteract output frame.
5. The nested frame uses the shared renderer bundle and renderer plugins.

This keeps notebook output isolated from both the host page and the MCP App
control plane.

## Spec Alignment

The MCP Apps spec makes three parts relevant to this migration:

- The nteract UI resource remains `text/html;profile=mcp-app` and is linked from
  tools through `_meta.ui.resourceUri`.
- The app view reports body size via `ui/notifications/size-changed` and receives
  host sizing through `HostContext.containerDimensions`.
- Nested frames are a declared CSP surface through `ui.csp.frameDomains`, so the
  final runtime flip needs host-specific validation for the nested isolated
  frame source before we require it in Claude/Codex.

## Migration Slices

1. Add a structured-content adapter that turns current MCP App `cell.outputs`
   into shared isolated renderer manifests and proves those manifests resolve
   through `resolveEmbeddableOutputs`.
2. Add an MCP App renderer bundle provider. Prefer daemon-served renderer assets
   or a build-time virtual bundle, but avoid depending on Git LFS pointer files
   in local source checkouts.
3. Render one rich-output path through `createNteractOutputEmbed` under the MCP
   App shell, starting with HTML/SVG where the current app has the most layout
   drift from the desktop renderer.
4. Extend the MCP resource CSP metadata for the nested frame source once the
   source is concrete for each host surface.
5. Delete the duplicate MCP App MIME components and plugin registry after the
   shared renderer path covers text, images, HTML/SVG, errors, markdown,
   Plotly/Vega/Leaflet, and Sift.
