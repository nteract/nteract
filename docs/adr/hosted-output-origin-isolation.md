# Hosted Output Origin Isolation

**Status:** Draft, 2026-05-24.
**Addresses:** GitHub issue #2645.

## Context

Notebook outputs are untrusted content. A Python cell can emit arbitrary HTML,
SVG, JavaScript-backed widgets, Plotly/Vega/Leaflet documents, anywidget
bundles, or renderer-specific WASM sidecars. Desktop contains that content in
the shared isolated output frame:

- Tauri serves the frame document from the `nteract-frame://` custom scheme so
  it can receive a dedicated CSP.
- Plain browser development can use `srcDoc`.
- The iframe sandbox deliberately omits `allow-same-origin`, giving output code
  a sandbox-induced opaque origin.

That model is still the core security boundary, but hosted production adds real
authenticated browser sessions, OIDC tokens, notebook ACLs, viewer/editor
WebSockets, and public CDN-style renderer assets. A hosted deployment must not
let output JavaScript share cookies, localStorage, ambient credentials, room
WebSocket privileges, or application-origin APIs with the notebook application.

Prior art exists in the older `runtimed/intheloop` deployment. The main
application and API were served from `https://app.runt.run`, while user-created
HTML/SVG iframe output was served by a separate Cloudflare Worker on
`https://runtusercontent.com` (preview: `https://preview.runtusercontent.com`).
The main app was configured with `VITE_IFRAME_OUTPUT_URI` so the output frame
boundary was a deploy-time origin decision, not a renderer implementation
detail. That deployment is useful prior art, not a compatibility contract.
Notebook-cloud should keep the underlying security property: untrusted output
must not share ambient application authority. It should still adopt better
Cloudflare, OIDC, browser-platform, or operational patterns where they improve
the system instead of copying old domain names, environment variable names,
Worker layouts, or auth shortcuts wholesale.

Related docs:

- `src/components/isolated/AGENTS.md`
- `docs/adr/deployment-topology.md`
- `docs/adr/hosted-credential-transport.md`
- `docs/adr/hosted-room-authorization.md`
- `docs/adr/hosted-notebook-artifacts.md`
- `docs/adr/blob-storage-and-content-addressing.md`

## Decision 1: Hosted deployments have three origin classes

A production hosted notebook deployment should separate at least these origin
classes:

1. **Notebook application origin.** Serves the authenticated UI, HTTP APIs, and
   typed-frame room WebSockets. This origin is protected by the configured
   identity provider, owns browser auth material, enforces WebSocket `Origin`
   policy, and stamps trusted room identity headers.
2. **Renderer asset origin.** Serves public build-time renderer sidecars such
   as Sift WASM, plugin CSS, and future renderer chunk assets. It has no
   notebook identity, no room APIs, no authenticated WebSockets, and no
   user-generated notebook blobs. It may use `Access-Control-Allow-Origin: *`
   because sandboxed `srcDoc`/opaque-origin frames and parent viewers must be
   able to fetch these immutable sidecars.
3. **Output document origin.** Serves the document shell used to execute
   untrusted output JavaScript. It is a separate host from the notebook
   application and should ideally be on a separate registrable domain, such as
   `*.nteractusercontent.com`, so no cookie scope or localStorage namespace can
   overlap with the authenticated app origin.

The current notebook-cloud Worker may keep a prototype route like
`/renderer-assets/` for local/demo convenience, but production configuration
should be able to point renderer assets and output documents at dedicated
origins. Shared renderer code must not infer cloud paths from app-specific
routes such as `/api/n/:id`.

The current `/n/:id` published viewer is also a prototype convenience served
from the notebook application origin. That keeps the early demo simple, but it
means the read-only viewer page currently shares an origin with authenticated
APIs, localStorage, and WebSocket credential bootstrapping. Before broad private
notebook sharing, the published read-only viewer should move to a less
privileged preview/viewer origin, or the privileged application shell should be
split from the unauthenticated output/viewer surface so the app-origin
definition above is true in practice.

## Decision 2: A separate output origin does not replace the sandbox

The iframe sandbox remains load-bearing. Output frames must continue to omit
`allow-same-origin`, even when served from a separate output host.

The separate host gives the frame its own response headers, CSP, caching,
observability, and deploy lifecycle. The sandbox-induced opaque origin prevents
output JavaScript from using that host as a shared storage or same-origin
coordination space. These are complementary controls:

- output origin: deployment and browser-policy separation from the app;
- sandbox without `allow-same-origin`: parent DOM, storage, cookies, and
  inter-output isolation.
- app-origin hardening: future deployments should evaluate
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` once renderer
  assets, WASM sidecars, and output documents have explicit CORS/CORP behavior.

Do not loosen the sandbox to make plugin loading easier. If a renderer needs a
new network dependency, add it through the host context, renderer asset origin,
or blob resolver, not by giving the output frame application-origin powers.

## Decision 3: Output documents never hold room credentials

Output document JavaScript must not receive:

- direct OIDC access or refresh tokens;
- notebook room bearer tokens, one-time tickets, or dev tokens;
- `Authorization` material;
- trusted identity headers;
- URLs that imply editor/owner authority.

Output documents communicate with the parent through the existing explicit
`postMessage` bridge. The parent validates message source, expected frame
session, and renderer protocol shape before accepting messages. The output
frame may ask the parent to resolve a blob or send a widget message through the
existing renderer bridge; it must not open `/n/:id/sync` or any authenticated
notebook-room WebSocket itself.

`hosted-credential-transport.md` and `deployment-topology.md` already require
the Worker to reject renderer asset origins, sandboxed output origins, and
arbitrary third-party origins at the notebook WebSocket `Origin` gate. This ADR
adds the deployment reason: those origins are intentionally untrusted output
surfaces, not notebook application origins.

## Decision 4: Renderer assets are public sidecars, not notebook APIs

Renderer sidecars are static, build-time artifacts. The dedicated renderer asset
Worker/origin should serve only files needed by the isolated renderers, for
example:

```text
/renderer-assets/sift_wasm.wasm
/renderer-assets/*
```

It must not serve the notebook application bundle, authenticated API responses,
notebook snapshots, room event streams, or user-generated blobs. Existing
notebook-cloud tests already assert that the renderer asset Worker does not
expose the app bundle and rejects traversal-shaped asset paths; those tests
should remain part of this boundary.

The renderer asset origin can be configured independently for:

- parent viewer preloads and dynamic imports;
- isolated output frames whose origin is `null`;
- cloud-hosted Sift/Arrow sidecars;
- future CDN deployment of renderer chunks.

This keeps plugin hosting scalable without teaching renderers about notebook
route structure.

## Decision 5: Blob resolution stays host-owned

`RuntimeStateDoc` and `NotebookDoc` should continue to store host-neutral
content references such as:

```json
{ "blob": "<sha256-hex>", "size": 1234, "media_type": "image/png" }
```

WASM and renderer plugins should not rewrite these into daemon-local or
Cloudflare-local URLs. The host provides a `BlobResolver`:

- desktop maps blob refs to the local daemon blob server;
- notebook-cloud maps blob refs to `/api/n/:id/blobs/:hash` for the prototype;
- production can map blob refs to a signed, cookie-free blob/output origin.

The output document origin may fetch only the blob URLs the parent gives it.
For private notebooks, those URLs should be short-lived capabilities scoped to
the notebook, revision/render batch, hash, and viewer. For public published
notebooks, content-addressed public URLs are acceptable only when the notebook
is deliberately public. In both cases, attribution and ACL decisions stay
server-side; output JavaScript does not get to self-identify authors or
principals.

## Decision 6: The Anaconda demo authenticates only the app origin

The first Anaconda-friendly hosted demo uses direct OIDC on the notebook
application host, starting with `preview.runt.run`. That browser credential
belongs only to the notebook application origin.

Do not put the output document origin or renderer asset origin behind the same
browser auth surface. If those origins need access control, use capability URLs
or an output-specific validation layer that does not share the notebook app's
ambient browser credential. This avoids the main failure mode from issue #2645:
untrusted output code becoming same-site with the authenticated notebook app.

The `runtimed/intheloop` precedent maps to notebook-cloud like this:

| In the Loop | Notebook-cloud equivalent |
|-------------|---------------------------|
| `app.runt.run` unified app/API Worker | notebook application origin |
| `runtusercontent.com` iframe output Worker | output document origin |
| `VITE_IFRAME_OUTPUT_URI` | output-document base URL host config |
| separate iframe-output deploy script | future output-document Worker deploy |
| Cloudflare Worker assets for iframe shell | renderer/output shell assets |

This table is a precedent map, not a deployment mandate. It names the boundary
we want to preserve, while leaving the concrete hosting, CDN, OIDC, and
capability-token mechanics open to better current practice.

Anaconda is the identity provider for the app origin. It is not a reason for
output documents to receive app-origin cookies or direct OIDC material.


## Prototype Deployment Shape

The current Cloudflare prototype uses three Workers:

| Origin class | Worker | Current URL |
|--------------|--------|-------------|
| Notebook application origin | `nteract-notebook-cloud` | `https://nteract-notebook-cloud.rgbkrk.workers.dev` |
| Renderer asset origin | `nteract-notebook-cloud-assets` | `https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/` |
| Output document origin | `nteract-notebook-cloud-outputs` | `https://nteract-notebook-cloud-outputs.rgbkrk.workers.dev/frame/` |

The output document Worker is intentionally narrow. It serves the shared
isolated output shell and health checks only. It does not bind the notebook
application bundle, renderer sidecars, notebook snapshots, blobs, APIs, or room
WebSockets. The app Worker includes the output document origin in `frame-src`
when `OUTPUT_DOCUMENT_BASE_URL` is configured, but it does not add that origin
to the notebook room WebSocket allowlist.

`srcDoc` remains the browser-local fallback when `OUTPUT_DOCUMENT_BASE_URL` is
unset. Hosted deployments should configure the output document URL instead of
depending on `srcDoc` as the security boundary.

## Non-Goals

- This ADR does not choose the final public domain name. Names like
  `nteractusercontent.com` describe the security shape, not a committed domain.
- This ADR does not replace `hosted-credential-transport.md`; it relies on that
  ADR for credential transport and WebSocket origin policy.
- This ADR does not define invite or ACL semantics; those remain in
  `hosted-room-authorization.md` and `../prd/hosted-sharing-invites.md`.
- This ADR does not make output frames trusted. They remain untrusted even when
  served from a first-party controlled output domain.

## Open Questions

1. Whether the first production output-document host should be a Cloudflare
   Worker with static assets, a Worker plus R2-backed documents, or a pure
   static CDN origin.
2. Whether private blob capability URLs should be path tokens, signed query
   parameters, signed cookies on an output-only host, or a Worker-mediated
   authorization check. Query parameters are easy but can leak into logs.
3. Whether output documents need per-render-batch session ids beyond the
   existing frame bridge ids to make parent validation and observability
   clearer.
4. Whether the renderer asset origin and output document origin can share a
   registrable domain without weakening cookie/storage isolation. The safer
   default is separate hosts with no shared cookie domain. Different subdomains
   on the same registrable domain are not sufficient if any app, asset, or
   output host can set `Domain=<registrable-domain>` cookies; app and output
   hosts must never share registrable-domain-scoped cookies.

## References

- GitHub issue #2645, "Design hosted web output-origin isolation."
- `runtimed/intheloop/DEPLOYMENT.md`, "Iframe Outputs Service."
- `runtimed/intheloop/iframe-outputs/worker/wrangler.toml`, which routes the
  iframe output Worker to `runtusercontent.com` and
  `preview.runtusercontent.com`.
- `runtimed/intheloop/iframe-outputs/worker/worker.ts`, which serves the output
  frame shell with output-specific response headers.
- `src/components/isolated/AGENTS.md`, which documents the current desktop and
  browser output-frame security invariants.
