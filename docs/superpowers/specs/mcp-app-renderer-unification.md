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

The MCP Apps spec makes four parts relevant to this migration:

- The nteract UI resource remains `text/html;profile=mcp-app` and is linked from
  tools through `_meta.ui.resourceUri`.
- The app view reports body size via `ui/notifications/size-changed` and receives
  host sizing through `HostContext.containerDimensions`.
- Nested frames are a declared CSP surface through `ui.csp.frameDomains`, so the
  runtime flip declares the daemon blob origin before creating the nested
  isolated output frame at `{blob_base_url}/output-frame`.
- The MCP App fetches raw renderer plugin assets from the daemon blob origin, so
  blob and plugin fetches stay in `ui.csp.connectDomains`. The nested output
  frame gets its own daemon-served CSP header.

## Current Runtime Shape

The MCP App now uses the shared output embed for all cell outputs:

1. `ui/notifications/tool-result` provides MCP App structured cell output.
2. The app adapts those outputs into shared `OutputManifest` values.
3. `createNteractOutputEmbed` creates a sandboxed nested iframe whose `src` is
   `{blob_base_url}/output-frame`.
4. The app injects the shared isolated renderer bundle from
   `virtual:isolated-renderer`.
5. Heavy renderer plugins are fetched as raw CJS from
   `{blob_base_url}/renderer-plugins/{name}.js` and installed with
   `nteract/installRenderer`.
6. The duplicate MCP App MIME renderer and `window.__nteract` plugin registry
   are not part of the app bundle anymore.

## Migration Slices

1. Add a structured-content adapter that turns current MCP App `cell.outputs`
   into shared isolated renderer manifests and proves those manifests resolve
   through `resolveEmbeddableOutputs`.
2. Add an MCP App renderer bundle provider. The current slice uses the
   build-time `virtual:isolated-renderer` bundle for the core renderer and
   daemon-served raw sidecar plugins for heavy renderers.
3. Render one rich-output path through `createNteractOutputEmbed` under the MCP
   App shell, starting with all `display_data` / `execute_result` / stream /
   error outputs that can be adapted from current MCP structured content.
4. Extend the MCP resource CSP metadata for the nested frame source. The
   current slice declares `frameDomains: [blob_base_url]`.
5. Delete the duplicate MCP App MIME components and plugin registry after the
   shared renderer path covers text, images, HTML/SVG, errors, markdown,
   Plotly/Vega/Leaflet, and Sift. Done in the shared-only MCP App slice.
