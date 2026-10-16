# Output Frame Security Boundaries

**Status:** Draft, 2026-10-15. Records the current rendering and serving
contracts. No runtime change is selected here.

## Purpose and execution boundary

The reusable [frame shell](../../src/components/isolated/frame.html) loads
without notebook contents or daemon credentials. Its parent supplies renderer
code, output data, and supported widget traffic. Multiple outputs can share a
frame; individual items within that frame are not isolated from each other.

Executing supplied JavaScript is intentional. Both `nteract/eval` and legacy
`eval` messages reach `eval.call(null, code)`. Renderer initialization uses
this path; [plugin installation](../../src/isolated-renderer/index.tsx) uses
`new Function`. The security feature is containment of intentionally executed
code, not `eval` itself.

[Supported consumers](../../src/components/isolated/isolated-frame.tsx),
including [output embeds](../../src/components/isolated/output-embed.ts), use
the [shared sandbox configuration](../../src/components/isolated/frame-config.ts):
`allow-scripts allow-downloads allow-forms allow-pointer-lock`.
Omitting `allow-same-origin` gives each frame an opaque effective origin,
preventing direct same-origin DOM and storage access to the app and other
frames. The document's URL origin and its sandbox-induced origin are distinct.
A separate URL origin permits a separate CSP and avoids sharing app origin
authority; it does not replace sandboxing. `srcdoc` inherits the parent's
policy context and, without that sandbox restriction, its origin.

Native bridges belong to
[host shells](../../packages/notebook-host/src/tauri/index.ts). The output shell
supplies no native or kernel control endpoint. Host adapters must not expose
privileged bridges to outputs. Native script injection is platform-specific;
iframe sandboxing alone does not control it.

This is not an offline sandbox. `connect-src *` and broad resource directives
permit network activity subject to browser and destination policy. Forms and
downloads are allowed. An opaque origin does not prohibit requests or ensure
that every browser request omits credentials.

## Messages and embedding

The shell checks `event.source === window.parent`. This binds messages to its
immediate parent WindowProxy, not a vendor, user, or application. Any page
creating its own frame is that frame's parent. The handler has no
`event.origin` allowlist, authenticated token, or channel nonce.

Parent receive paths in the
[frame runtime](../../src/components/isolated/isolated-frame-runtime.ts) and
[JSON-RPC transport](../../src/components/isolated/jsonrpc-transport.ts) bind to
the exact `iframe.contentWindow` and check protocol shape. The JSON-RPC
envelope check is minimal; it is not comprehensive parameter validation.
The local reload generation is not an authenticated on-wire session.

In MCP Apps, [App.connect](../../apps/mcp-app/src/mcp-app.tsx) connects the
nteract view to its host.
[SharedCellOutputs](../../apps/mcp-app/src/components/shared-cell-outputs.tsx)
renders [McpAppOutputFrame](../../src/components/isolated/mcp-app-output-frame.tsx),
which calls `createNteractOutputEmbed`. The output's immediate parent is the
nteract MCP view, possibly itself sandboxed, not necessarily a chat provider's
top-level domain.
[Daemon asset selection](../../src/components/isolated/daemon-renderer-assets.ts)
chooses `/output-frame` only when host CSP `frameDomains` allows it. The
resource-reader path or absent host CSP uses `srcdoc`. Host-specific CSP
behavior motivates the URL shell; compatibility still depends on the host.

A fixed desktop-only origin or ancestor allowlist would exclude legitimate
cross-host and opaque-origin consumers. Deployment-specific policy remains
possible. CORS controls response readability, not iframe embedding permission.
`frame-ancestors` governs embedders and requires an HTTP CSP header, not a meta
tag; `frame-src` and `child-src 'none'` constrain children inside the output.
The HTTP shell deliberately omits `frame-ancestors`. See the
[CSP specification](https://w3c.github.io/webappsec-csp/#directive-frame-ancestors).

The parent delegates data and supported actions.
[Comm bridges](../../src/components/isolated/comm-bridge-manager.ts) forward
model state, updates, and callbacks. Anything supplied to arbitrary output
code is exposed to it; `postMessage` does not prevent exfiltration.

## Loopback HTTP surface

The [server](../../crates/runtimed/src/blob_server.rs) binds IPv4 `127.0.0.1`,
trying a preferred channel port, nearby ports, then an OS-assigned port. This
is neither a secret port nor a UID or room boundary, and is not an
internet-facing listener.

| GET route | Response |
|-----------|----------|
| `/output-frame` | Reusable HTML shell with its own CSP |
| `/blob/{hash}` | Raw stored bytes with recorded MIME type |
| `/plugins/{name}` | Static assets; JavaScript gets legacy wrapping |
| `/renderer-plugins/{name}` | Raw static renderer assets |
| `/health` | Health response |

Unknown GET routes return 404. All non-GET methods, including OPTIONS and HEAD,
return 405. Plugin paths require embedded manifest membership, including in
development. All responses carry `Access-Control-Allow-Origin: *`.
Blob reads have no authentication, room filtering, or listing route. Blob
responses have immutable caching and no CSP. Shell responses allow
`unsafe-inline`, `unsafe-eval`, and `connect-src *`, with no CSP `sandbox`
directive.

An arbitrary embedder can omit the iframe sandbox. The shell then uses its
document URL origin, with potentially different same-origin/CORS authority and
network address-space policy than the remote embedder. Legitimate consumers'
attributes do not protect the HTTP service from arbitrary embedders. This does
not imply inheritance of another notebook or frame's in-memory state.

Wildcard CORS already permits credentialless known-hash reads where browser
network policy allows direct reachability; `eval` is unnecessary for those
reads. Neither CORS nor message source checks authenticate readers.
[Local Network Access](https://wicg.github.io/local-network-access/) is
distinct from CORS and Private Network Access. Reachability depends on browser
version, flags, permissions, and embedding.

The [native control plane](../../crates/runtimed/src/daemon.rs) is separate:
Unix domain sockets use mode `0600`, with a default socket directory of `0700`;
Windows uses named pipes with their own access policy. JavaScript at the HTTP
origin does not thereby obtain daemon process privileges, cell execution, or
arbitrary filesystem writes.

## Blob confidentiality

The [store](../../crates/runtimed/src/blob_store.rs) computes unsalted
`SHA256(data)` without a secret, randomness, or room key. Hash validation checks
64 hexadecimal characters. The shared store holds outputs, streams,
tracebacks, attachments, images, HTML, JSON, widget buffers, and imported
notebook data, which may be sensitive.

[Redaction](../../crates/runtimed/src/output_redaction.rs) matches selected
launch-environment values on a best-effort basis, can be disabled, skips binary
payloads, and is not applied by the
[manifest path used for imports](../../crates/runtimed/src/output_store.rs).

No HTTP listing reduces discovery; it is not authorization. Unknown
high-entropy bytes resist blind guessing, but known bytes or low-entropy
candidates can be hashed, and leaked references permit retrieval. This does
not make arbitrary unknown blobs enumerable. Read-only serving, loopback
binding, non-listing, and content addressing do not guarantee confidentiality.
Confidentiality needs separately enforced scoped reads or capabilities
compatible with cross-host rendering. The
[storage ADR](blob-storage-and-content-addressing.md) describes storage and
upload mechanics separately.

## Responsibilities and alternatives

nteract owns separation of output execution from privileged app and control
endpoints. Keep app credentials off the output origin, retain sandbox and
source checks, and validate and scope parent bridge operations. Do not add
privileged APIs or sensitive indexes to the output HTTP origin.

Browser integrators own policy for arbitrary web content reaching local
endpoints; local services own authentication. nteract can also narrow serving,
CSP, and authentication policy. A browser/session request guard can complement
the renderer boundary without changing its intentionally open rendering
protocol; it is not universal protection across browsers.

## Open Follow-ups

- Evaluate scoped bearer capabilities or authentication when confidentiality
  requires it. Authorized recipients seeing a capability is expected. A URL
  fragment is not sent to the server; enforcing blob reads requires a server
  mechanism. The Draft [hosted-output ADR](hosted-output-origin-isolation.md)
  sets future capability and credential-segregation requirements, not current
  local HTTP enforcement.
- Evaluate narrower `connect-src` separately for compatibility and hardening.
  `'self' https:` is not a complete local-network block: an unsandboxed shell's
  `self` is its URL origin, HTTPS destinations can be local, and other resource
  directives still matter. This ADR selects no CSP change.
