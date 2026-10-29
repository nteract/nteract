/**
 * Kilo Desktop's two renderer Content-Security-Policies, copied verbatim.
 *
 * Source: anaconda/agentic-desktop `origin/main`,
 * `apps/desktop/src/main/platform/ElectronProtocol.ts`:
 * `createContentSecurityPolicy` (app origin) and
 * `createEmbeddedContentSecurityPolicy` (embedded hosts). KD's comments are
 * trimmed to what matters for Sift.
 *
 * Keep these byte-for-byte equal to KD. The harness exists to prove Sift's
 * worker under the real policy; a permissive copy proves nothing. In
 * particular the app-origin policy has no `worker-src`, so workers fall back
 * to `script-src 'self' 'wasm-unsafe-eval'`: a same-origin module worker
 * loads, a `blob:` worker does not.
 */

// Application policy: renderer features may connect to app-managed loopback servers on
// ephemeral ports. Remote HTTP, localhost aliases, and WebSocket origins remain disallowed.
const LOOPBACK_SERVER_CONNECT_SOURCE = "http://127.0.0.1:*";

export function createContentSecurityPolicy(
  developmentOrigin?: string,
  inlineScriptHashes: readonly string[] = [],
  frameOrigins: readonly string[] = [],
  /** Plugin-declared protocol schemes (mainSdk.protocol), connectable. */
  pluginSchemes: readonly string[] = [],
): string {
  const developmentSources = developmentOrigin ? ` ${new URL(developmentOrigin).origin} ws:` : "";
  // Production pins each shipped inline script by its sha256 hash, never
  // `'unsafe-inline'`. `'unsafe-inline'` and hash/nonce sources are mutually
  // exclusive in CSP, so exactly one is emitted.
  const inlineScriptSources = developmentOrigin
    ? " 'unsafe-inline'"
    : inlineScriptHashes.map((hash) => ` 'sha256-${hash}'`).join("");
  return [
    "default-src 'self'",
    // `'wasm-unsafe-eval'` instantiates bundled WASM. It is not `'unsafe-eval'`
    // and does not allow remote script.
    `script-src 'self'${inlineScriptSources} 'wasm-unsafe-eval'${developmentSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${pluginSchemes.map((scheme) => `${scheme}:`).join(" ")} ${LOOPBACK_SERVER_CONNECT_SOURCE}${developmentSources}`,
    // `frameOrigins` names the sibling embedded hosts.
    `frame-src 'self' blob:${frameOrigins.length > 0 ? ` ${frameOrigins.join(" ")}` : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * Policy for an embedded third-party bundle. Deliberately looser than the app's
 * own. What the extra grants buy, none of which the app origin gains:
 * - `'wasm-unsafe-eval'`: embedded bundles may instantiate WebAssembly.
 * - loopback HTTP on connect/img/media supports host-authorized local services.
 * - `worker-src blob:` supports embedded bundles that create blob workers.
 */
export function createEmbeddedContentSecurityPolicy(
  appOrigin: string,
  inlineScriptHashes: readonly string[] = [],
): string {
  const trustedInlineScripts = inlineScriptHashes.map((hash) => ` 'sha256-${hash}'`).join("");
  const loopback = "http://127.0.0.1:*";
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${trustedInlineScripts}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${loopback}`,
    "font-src 'self' data:",
    `media-src 'self' data: blob: ${loopback}`,
    `connect-src 'self' ${loopback}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // The child's own header decides whether it can be framed, so the app
    // origin has to be named here.
    `frame-ancestors ${appOrigin}`,
  ].join("; ");
}
