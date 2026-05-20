# Embeddable Output Surface

The embeddable output surface renders already-resolved notebook outputs in an
isolated nteract iframe without requiring React, notebook execution, or a live
notebook session. Hosts create an iframe with `createNteractOutputEmbed`, provide
the renderer bundle, and optionally provide a `HostBlobResolver` for manifest
content stored outside the payload.

## Contract

- Rendering commands stay in the `nteract/*` namespace and accept
  `RenderPayload` batches.
- Host lifecycle notifications use the MCP Apps-shaped methods already supported
  by the iframe: host context changes, size changes, resource teardown, and log
  forwarding.
- Host context is shaped like MCP Apps `HostContext`, including theme, style
  variables, font CSS, display mode, container dimensions, locale, timezone,
  platform, device capabilities, and safe-area insets.
- Blob access is host-owned. Local daemon blobs, HTTPS blob services, and future
  Cloudflare/R2-backed URLs all fit behind `HostBlobResolver.url()` and
  `HostBlobResolver.fetch()`.

## Non-Goals

- This API does not execute cells or manage kernels.
- This API does not claim notebook output is an MCP `tool-result`; nteract render
  commands remain nteract-specific.
- This API does not implement external blob storage. Storage hosts must provide
  URL, fetch, auth, CORS, and CSP policy through the resolver and embedding
  environment.

## Security

Embedders must use the shared isolated-frame config. The sandbox must not include
`allow-same-origin`; fullscreen remains in the separate iframe allow policy.
Hosted deployments should serve output resources from an origin that does not
share cookies, localStorage, or ambient credentials with the authenticated app.
