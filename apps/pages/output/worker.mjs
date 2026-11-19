// The credential-free output Worker: it serves the output frame's bootstrap
// document (@nteract/output-frame/bootstrap) on its own origin. The page
// sends the frame runtime at boot, so a runtime change needs no deploy here.
// npm run build bundles this module, with the bootstrap inlined, into
// dist/output/worker.js: the module the release package ships as
// output/worker.js and wrangler.output.toml deploys.
//
// This is the Worker's entry module: its only export is `default`. workerd
// refuses an entry module with any other export, so shared values live in
// output/policy.mjs.
import { FRAME_HTML } from "../.output-dist/frame-html.mjs";
import { OUTPUT_FRAME_PATHS } from "../shared/output-frame-paths.mjs";
import { FRAME_CSP, HEALTH_TEXT } from "./policy.mjs";

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
          // run correctly in this opaque sandbox. Serve the authored bytes.
          // A browser may keep the bootstrap for five minutes: long enough
          // that the views of one Page share a download, short enough that a
          // different document at this path, as after a rollback, reaches
          // readers quickly.
          "Cache-Control": html ? "public, max-age=300, no-transform" : "no-store, no-transform",
        },
      },
    );
  },
};
