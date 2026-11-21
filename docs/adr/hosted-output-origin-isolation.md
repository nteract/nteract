# Hosted Output Origin Isolation

**Status:** Draft, 2026-05-24.
**Addresses:** GitHub issue #2645.

## Context

Notebook outputs are untrusted content. A Python cell can emit arbitrary HTML, SVG, JavaScript widgets, Plotly/Vega/Leaflet documents, anywidget bundles, or renderer WASM sidecars. Desktop contains this content in the shared isolated output frame:

- Tauri serves the frame shell from the `nteract-frame://` custom scheme for a dedicated CSP.
- Plain browser development can use `srcDoc`.
- The iframe sandbox omits `allow-same-origin`, giving output code a sandbox-induced opaque origin.

That sandbox remains the core boundary. Hosted production adds authenticated browser sessions, OIDC tokens, notebook ACLs, viewer/editor WebSockets, and CDN-style renderer assets. Output JavaScript must never share cookies, `localStorage`, ambient credentials, room WebSocket privileges, or app-origin APIs with the notebook application.

### Prior art

The older `runtimed/intheloop` deployment established a useful origin-separation precedent. Its boundary maps to `notebook-cloud` as follows:

| `runtimed/intheloop` | `notebook-cloud` equivalent |
|----------------------|-----------------------------|
| `https://app.runt.run` unified app/API Worker | Notebook application origin |
| `https://runtusercontent.com` (preview: `https://preview.runtusercontent.com`) iframe output Worker | Output document origin |
| `VITE_IFRAME_OUTPUT_URI` | Deploy-time output-document base URL config |
| Separate iframe-output deploy script | Dedicated output-document Worker deploy |
| Cloudflare Worker assets for iframe shell | Renderer and output shell assets |

This map is prior art, not a compatibility contract. Keep the core security property — untrusted output never shares ambient application authority — while choosing modern Cloudflare, OIDC, browser, and operational patterns instead of copying old domains, env vars, or auth shortcuts.

Related docs:

- [Output frame security](output-frame-security.md), the current shared shell and local HTTP boundaries; this ADR's hosted requirements are separate.
- `src/components/isolated/AGENTS.md`
- `docs/adr/deployment-topology.md`
- `docs/adr/hosted-credential-transport.md`
- `docs/adr/hosted-room-authorization.md`
- `docs/adr/hosted-notebook-artifacts.md`
- `docs/adr/blob-storage-and-content-addressing.md`

## Decision 1: Hosted deployments have three origin classes

Production hosted deployments separate at least three origin classes:

1. **Notebook application origin.** Serves the authenticated UI, HTTP APIs, and typed-frame room WebSockets. Protected by the configured identity provider, it owns browser auth material, enforces WebSocket `Origin` policy, and stamps trusted room identity headers.
2. **Renderer asset origin.** Serves public build-time renderer sidecars (Sift WASM, plugin CSS, renderer chunks). It holds no notebook identity, room APIs, authenticated WebSockets, or user blobs. It sets `Access-Control-Allow-Origin: *` so sandboxed opaque-origin frames and parent viewers can load immutable sidecars.
3. **Output document origin.** Serves the document shell executing untrusted output JavaScript. It uses a separate host — ideally a separate registrable domain such as `*.nteractusercontent.com` — so no cookie scope or `localStorage` namespace overlaps with the app origin.

The `notebook-cloud` Worker may keep `/renderer-assets/` for local and demo convenience. Production deployments must point renderer assets and output documents at dedicated origins. Shared renderer code must never infer cloud paths from app-specific routes such as `/api/n/:id`.

The current `/n/:id` published viewer also runs on the notebook application origin as a prototype convenience. That leaves the read-only viewer sharing an origin with authenticated APIs, `localStorage`, and WebSocket credential bootstrapping. Before broad private notebook sharing, move the published viewer to a less privileged preview origin or split the privileged app shell from the unauthenticated viewer surface.

## Decision 2: A separate output origin does not replace the sandbox

Output frames must continue omitting `allow-same-origin`, even when served from a separate output host.

The separate host and the sandbox are complementary controls:

- **Output origin:** isolates deployment, response headers, CSP, caching, and observability from the app.
- **Sandbox without `allow-same-origin`:** isolates parent DOM, storage, cookies, and inter-output coordination via an opaque origin.
- **App-origin hardening:** evaluate `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` once renderer assets, WASM sidecars, and output documents have explicit CORS/CORP headers.

Never loosen the sandbox to simplify plugin loading. Add renderer network dependencies through host context, the renderer asset origin, or `BlobResolver`, not by granting app-origin authority.

## Decision 3: Output documents never hold room credentials

Output document JavaScript must never receive:

- direct OIDC access or refresh tokens;
- notebook room bearer tokens, one-time tickets, or dev tokens;
- `Authorization` headers or material;
- trusted identity headers;
- URLs implying editor or owner authority.

Output documents talk to the parent only through the `postMessage` bridge. Parent receive paths bind messages to the expected iframe window and check protocol shape. Because the local reload generation is not an authenticated on-wire session, hosted deployments enforce origin and session auth separately. The output frame may ask the parent to resolve a blob or forward a widget message; it must never open `/n/:id/sync` or any authenticated room WebSocket directly.

`hosted-credential-transport.md` and `deployment-topology.md` require the Worker to reject renderer asset origins, sandboxed output origins, and arbitrary third-party origins at the notebook WebSocket `Origin` gate. Those origins are untrusted output surfaces, not notebook application origins.

## Decision 4: Renderer assets are public sidecars, not notebook APIs

Renderer sidecars are static build-time artifacts. The dedicated renderer asset Worker serves only files required by isolated renderers:

```text
/renderer-assets/sift_wasm.wasm
/renderer-assets/*
```

It must never serve the notebook application bundle, authenticated API responses, notebook snapshots, room event streams, or user-generated blobs. Keep existing `notebook-cloud` tests that verify the renderer asset Worker hides the app bundle and rejects path-traversal shapes.

The renderer asset origin can be configured independently for:

- parent viewer preloads and dynamic imports;
- isolated output frames with origin `null`;
- cloud-hosted Sift/Arrow sidecars;
- future CDN hosting of renderer chunks.

This scales plugin hosting without teaching renderers about notebook route structure.

## Decision 5: Blob resolution stays host-owned

`RuntimeStateDoc` and `NotebookDoc` store host-neutral content references:

```json
{ "blob": "<sha256-hex>", "size": 1234, "media_type": "image/png" }
```

WASM and renderer plugins never rewrite refs into daemon-local or Cloudflare-local URLs. Each host provides a `BlobResolver`:

- **Desktop:** maps blob refs to the local daemon blob server.
- **Prototype `notebook-cloud`:** maps blob refs to `/api/n/:id/blobs/:hash`.
- **Production:** maps blob refs to a signed, cookie-free blob/output origin.

Hosted blob serving must restrict reads to the scope delegated by the parent. This is a deployment requirement, not a restriction enforced by the shared renderer or unauthenticated local blob server:

- **Private notebooks:** issue short-lived capability URLs scoped to the notebook, revision or render batch, blob hash, and viewer.
- **Public published notebooks:** content-addressed public URLs are acceptable only when the notebook is explicitly public.

Attribution and ACL decisions stay server-side; output JavaScript never self-identifies authors or principals.

## Decision 6: The Anaconda demo authenticates only the app origin

The Anaconda-friendly hosted demo uses direct OIDC on the notebook application host, starting with `preview.runt.run`. That browser credential belongs exclusively to the app origin.

Never place the output document origin or renderer asset origin behind the same browser auth surface. If those origins require access control, use capability URLs or output-specific validation that never shares the app's ambient browser credentials. This prevents the main issue #2645 failure mode: untrusted output code becoming same-site with the authenticated app.

Anaconda acts as identity provider for the app origin only. Output documents must never receive app-origin cookies or direct OIDC material.

## Prototype Deployment Shape

The Cloudflare prototype separates the three origin classes across three Workers (origins below are illustrative examples):

| Origin class | Worker | Example origin |
|--------------|--------|----------------|
| Notebook application origin | `nteract-notebook-cloud` | `https://<app-origin>` |
| Renderer asset origin | `nteract-notebook-cloud-assets` | `https://<asset-origin>/renderer-assets/` |
| Output document origin | `nteract-notebook-cloud-outputs` | `https://<output-origin>/frame/` |

The output document Worker stays narrow: it serves the shared isolated output shell and health checks only. It never binds the app bundle, renderer sidecars, notebook snapshots, blobs, APIs, or room WebSockets. When `OUTPUT_DOCUMENT_BASE_URL` is configured, the app Worker adds the output origin to `frame-src` but never to the room WebSocket `Origin` allowlist.

`srcDoc` remains the browser-local fallback when `OUTPUT_DOCUMENT_BASE_URL` is unset. Hosted deployments should configure `OUTPUT_DOCUMENT_BASE_URL` instead of relying on `srcDoc` as the security boundary.

## Non-Goals

- Choosing final public domain names (`nteractusercontent.com` describes the security shape, not a committed domain).
- Replacing `hosted-credential-transport.md` for credential transport and WebSocket origin policy.
- Defining invite or ACL semantics (owned by `hosted-room-authorization.md` and `../prd/hosted-sharing-invites.md`).
- Making output frames trusted; outputs stay untrusted even when served from a first-party output domain.

## Open Follow-ups

- Decide whether the production output-document host runs as a Cloudflare Worker with static assets, a Worker backed by R2, or a pure static CDN origin.
- Choose the private blob capability mechanism: path tokens, signed query parameters (which can leak into logs), signed cookies on an output-only host, or Worker-mediated authorization checks.
- Decide whether output documents need per-render-batch session ids beyond existing frame bridge ids to strengthen parent validation and observability.
- Verify whether the renderer asset origin and output document origin can safely share a registrable domain. Separate hosts with no shared cookie domain are the safer default. Subdomains of one registrable domain are unsafe if any app, asset, or output host can set `Domain=<registrable-domain>` cookies; app and output hosts must never share registrable-domain-scoped cookies.

## References

- GitHub issue #2645, "Design hosted web output-origin isolation."
- `runtimed/intheloop/DEPLOYMENT.md`, "Iframe Outputs Service."
- `runtimed/intheloop/iframe-outputs/worker/wrangler.toml`, which routes the iframe output Worker to `runtusercontent.com` and `preview.runtusercontent.com`.
- `runtimed/intheloop/iframe-outputs/worker/worker.ts`, which serves the output frame shell with output-specific response headers.
- `src/components/isolated/AGENTS.md`, which documents the current desktop and browser output-frame security invariants.
