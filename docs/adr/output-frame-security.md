# Output Frame Security Boundaries

**Status:** Draft, 2026-10-15. Records the current rendering and serving contracts. No runtime change is selected here.

## Boundary summary

| Surface | Boundary | What it prevents | What it does not guarantee |
|---------|----------|------------------|----------------------------|
| Output iframe (`frame.html`) | `sandbox="allow-scripts allow-downloads allow-forms allow-pointer-lock"` (omits `allow-same-origin`); `event.source === window.parent` | Direct same-origin DOM, cookie, or storage access to the app or other frames; messages from non-parent windows | Offline containment (`connect-src *`, forms, downloads stay allowed); isolation between outputs in one frame; protection if a third-party embedder omits `sandbox`; exfiltration prevention for data sent over `postMessage` |
| Native host & control plane (`daemon.rs`, host shells) | Unix domain socket `0600` (default dir `0700`) or Windows named pipes; no native bridges in output shell | Output JavaScript gaining daemon privileges, cell execution, or arbitrary filesystem writes | Blocking platform-specific native script injection by host adapters; cross-process isolation within the same UID |
| Loopback HTTP server (`127.0.0.1`, `blob_server.rs`) | Loopback-only bind; GET-only (non-GET returns `405`, unknown returns `404`); manifest-checked plugin paths | Internet-facing exposure; non-GET mutations; serving files outside the embedded plugin manifest | UID or room isolation; reader authentication; blocking wildcard CORS (`Access-Control-Allow-Origin: *`) reads from local-reachable pages |
| Blob store (`blob_store.rs`) | Unsalted `SHA256(data)` (64 hex chars); no HTTP listing route; best-effort env redaction | Casual enumeration of arbitrary unknown blobs | Confidentiality for known or low-entropy payloads, leaked hashes, binary data, or imported manifests |

## Purpose and execution boundary

The reusable [frame shell](../../src/components/isolated/frame.html) loads without notebook contents or daemon credentials. Its parent supplies renderer code, output data, and supported widget traffic. Multiple outputs can share one frame; outputs inside the same frame are not isolated from each other.

Executing supplied JavaScript is intentional. Both `nteract/eval` and legacy `eval` messages reach `eval.call(null, code)`. Renderer initialization uses this path, and [plugin installation](../../src/isolated-renderer/index.tsx) uses `new Function`. Containment of intentionally executed code is the security boundary, not banning `eval`.

[Supported consumers](../../src/components/isolated/isolated-frame.tsx), including [output embeds](../../src/components/isolated/output-embed.ts), apply the [shared sandbox configuration](../../src/components/isolated/frame-config.ts): `allow-scripts allow-downloads allow-forms allow-pointer-lock`.

Omitting `allow-same-origin` gives each frame an opaque effective origin. That blocks direct same-origin DOM and storage access to the app and other frames. A document's URL origin and its sandbox-induced origin are distinct:

- A separate URL origin enables a dedicated CSP and avoids sharing app-origin authority, but it does not replace sandboxing.
- `srcdoc` inherits the parent's policy context and, without that sandbox restriction, its origin.

Native bridges belong to [host shells](../../packages/notebook-host/src/tauri/index.ts). The output shell exposes no native or kernel control endpoint, and host adapters must never inject privileged bridges into outputs. Native script injection is platform-specific; iframe sandboxing alone cannot block it.

This is not an offline sandbox. `connect-src *` and broad resource directives allow network requests subject to browser and destination policy. Forms and downloads remain enabled. An opaque origin does not block network requests or guarantee credential-free fetches in every browser path.

## Messages and embedding

The shell checks `event.source === window.parent`. That binds messages to the immediate parent `WindowProxy`, not a vendor, user, or application. Any page embedding the frame is its parent. The handler checks no `event.origin` allowlist, auth token, or channel nonce.

Parent receive paths in the [frame runtime](../../src/components/isolated/isolated-frame-runtime.ts) and [JSON-RPC transport](../../src/components/isolated/jsonrpc-transport.ts) bind to the exact `iframe.contentWindow` and validate basic protocol shape. The JSON-RPC envelope check is minimal rather than full parameter validation. The local reload generation is not an authenticated on-wire session.

In MCP Apps, output embedding follows this chain:

- [App.connect](../../apps/mcp-app/src/mcp-app.tsx) connects the nteract view to its host.
- [SharedCellOutputs](../../apps/mcp-app/src/components/shared-cell-outputs.tsx) renders [McpAppOutputFrame](../../src/components/isolated/mcp-app-output-frame.tsx), which calls `createNteractOutputEmbed`.
- The output's immediate parent is the nteract MCP view (which may itself be sandboxed), not necessarily a chat provider's top-level domain.
- [Daemon asset selection](../../src/components/isolated/daemon-renderer-assets.ts) selects `/output-frame` only when host CSP `frameDomains` allows it. Otherwise, or on the resource-reader path, it falls back to `srcdoc`.
- Host-specific CSP behavior motivates the URL shell, though compatibility still depends on the host.

A fixed desktop-only origin or ancestor allowlist would break cross-host and opaque-origin consumers. Deployment-specific policy remains possible. CORS governs response readability, not iframe embedding. `frame-ancestors` governs embedders and requires an HTTP CSP header rather than a meta tag; `frame-src` and `child-src 'none'` constrain nested frames inside outputs. The HTTP shell deliberately omits `frame-ancestors` (see the [CSP specification](https://w3c.github.io/webappsec-csp/#directive-frame-ancestors)).

The parent delegates data and supported actions. [Comm bridges](../../src/components/isolated/comm-bridge-manager.ts) forward model state, updates, and callbacks. Any data handed to arbitrary output code is readable by that code; `postMessage` does not stop exfiltration.

## Loopback HTTP surface

The [server](../../crates/runtimed/src/blob_server.rs) binds IPv4 `127.0.0.1`, trying a preferred channel port, nearby ports, then an OS-assigned port. It is local-only, not internet-facing, and its port is neither a secret nor a UID or room boundary.

| GET route | Response |
|-----------|----------|
| `/output-frame` | Reusable HTML shell with its own CSP |
| `/blob/{hash}` | Raw stored bytes with recorded MIME type |
| `/plugins/{name}` | Static assets; JavaScript gets legacy wrapping |
| `/renderer-plugins/{name}` | Raw static renderer assets |
| `/health` | Health response |

Unknown GET routes return `404`. All non-GET methods, including `OPTIONS` and `HEAD`, return `405`. Plugin paths require embedded manifest membership, even in development. All responses set `Access-Control-Allow-Origin: *`.

Blob reads have no authentication, room filtering, or listing route. Blob responses use immutable caching and carry no CSP. Shell responses permit `unsafe-inline`, `unsafe-eval`, and `connect-src *`, with no CSP `sandbox` directive.

Any external page can embed `/output-frame` without a `sandbox` attribute. The shell then runs under its loopback URL origin instead of an opaque origin, with loopback same-origin/CORS authority and local network address-space rules. Sandbox attributes on legitimate nteract consumers protect those consumers, not the HTTP service itself. Even when unsandboxed, a fresh frame starts empty and gains no access to another notebook's or frame's in-memory state.

Wildcard CORS already allows credentialless reads of known hashes whenever browser network policy permits local reachability; `eval` is unnecessary for those reads. Neither CORS nor message source checks authenticate readers. [Local Network Access](https://wicg.github.io/local-network-access/) is separate from CORS and Private Network Access; reachability varies by browser version, flags, permissions, and embedding context.

The [native control plane](../../crates/runtimed/src/daemon.rs) is separate from the HTTP server. Unix domain sockets use mode `0600` in a `0700` default directory; Windows uses named pipes with platform access policy. JavaScript running at the HTTP origin gains no daemon privileges, cell execution, or filesystem write access.

## Blob confidentiality

The [store](../../crates/runtimed/src/blob_store.rs) hashes bytes with unsalted `SHA256(data)` (no secret, salt, or room key). Hash validation checks 64 hexadecimal characters. The shared store holds outputs, streams, tracebacks, attachments, images, HTML, JSON, widget buffers, and imported notebook data, any of which may be sensitive.

[Redaction](../../crates/runtimed/src/output_redaction.rs) scrubs selected launch-environment values on a best-effort basis. It can be disabled, skips binary payloads, and does not run on the [manifest path used for imports](../../crates/runtimed/src/output_store.rs).

Omitting an HTTP listing route limits casual discovery, not access. High-entropy blobs resist blind guessing and cannot be enumerated. However, anyone can hash known or low-entropy payloads to derive their URLs, and any leaked hash permits retrieval. Read-only serving, loopback binding, non-listing, and content addressing provide no confidentiality guarantee. True confidentiality requires server-enforced scoped reads or capability tokens compatible with cross-host rendering. See the [storage ADR](blob-storage-and-content-addressing.md) for storage and upload mechanics.

## Responsibilities and alternatives

nteract separates output execution from privileged app and control endpoints. Keep app credentials off the output origin, retain sandbox and `event.source` checks, and validate and scope parent bridge calls. Never expose privileged APIs or sensitive indexes on the output HTTP origin.

Browser integrators govern whether arbitrary web content can reach local endpoints; local services own their own authentication. nteract can tighten serving, CSP, and auth policy further. A browser or session request guard can complement the renderer boundary without altering its open rendering protocol, though enforcement varies across browsers.

## Open Follow-ups

- Evaluate scoped bearer capabilities or authentication when confidentiality requires it. Authorized recipients seeing a capability is expected. URL fragments are never sent to the server, so enforcing blob reads requires a server mechanism. The Draft [hosted-output ADR](hosted-output-origin-isolation.md) defines future capability and credential-segregation requirements, not current local HTTP enforcement.
- Evaluate narrower `connect-src` separately for compatibility and hardening. `'self' https:` does not fully block local network access: an unsandboxed shell's `'self'` is its URL origin, HTTPS targets can be local, and other resource directives still apply. This ADR selects no CSP change.
