import { FRAME_HTML } from "../.output-dist/frame-html.mjs";

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
    const valid = path === "/frame/v1/" || path === "/health";
    const status = !["GET", "HEAD"].includes(request.method) ? 405 : !valid ? 404 : 200;
    const html = status === 200 && path === "/frame/v1/";
    return new Response(
      request.method === "HEAD"
        ? null
        : status !== 200
          ? "Not available"
          : html
            ? FRAME_HTML
            : "pages-output-v1",
      {
        status,
        headers: {
          "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Security-Policy": FRAME_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          "Cache-Control": "no-store",
        },
      },
    );
  },
};
