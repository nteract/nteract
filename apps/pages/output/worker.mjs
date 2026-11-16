// The credential-free output Worker: it serves the anywidget frame shell on
// its own origin. npm run build bundles this module, with the frame HTML
// inlined, into dist/output/worker.js: the module the release package ships
// as output/worker.js and wrangler.output.toml deploys.
import { FRAME_HTML } from "../.output-dist/frame-html.mjs";
import { PAGES_BUILD } from "../shared/build-identity.mjs";
import { OUTPUT_FRAME_PATHS } from "../shared/output-frame-paths.mjs";

// The bundle names its build: scripts/build.mjs defines __PAGES_BUILD__ as the
// build receipt's build_id, so a deployer can match the deployed shell to a
// package. Unbundled (scripts/output-smoke.mjs, unit tests) PAGES_BUILD is
// "dev" and /health reports the bare version, with no id.
export const HEALTH_TEXT =
  PAGES_BUILD === "dev" ? "pages-output-v2" : `pages-output-v2 ${PAGES_BUILD}`;

export const FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "connect-src *",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src https: data:",
  "worker-src blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    const frame = OUTPUT_FRAME_PATHS.includes(path);
    const valid = frame || path === "/health";
    const status = !["GET", "HEAD"].includes(request.method) ? 405 : !valid ? 404 : 200;
    const html = status === 200 && frame;
    return new Response(
      request.method === "HEAD"
        ? null
        : status !== 200
          ? "Not available"
          : html
            ? FRAME_HTML
            : HEALTH_TEXT,
      {
        status,
        headers: {
          "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Security-Policy": FRAME_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          // Origin-dependent CDN injections (such as the RUM beacon) cannot
          // run correctly in this opaque sandbox. Serve the authored shell.
          "Cache-Control": "no-store, no-transform",
        },
      },
    );
  },
};
