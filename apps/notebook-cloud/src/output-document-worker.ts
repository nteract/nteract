import type { Env, ExportedHandler } from "./cloudflare-types.ts";

type OutputDocumentEnv = Pick<Env, "ASSETS">;

const OUTPUT_DOCUMENT_PATHS = new Set([
  "/",
  "/frame",
  "/frame/",
  "/frame/index.html",
  "/index.html",
]);
const OUTPUT_DOCUMENT_ASSET_PATH = "/";
const OUTPUT_DOCUMENT_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https: http://127.0.0.1:*",
  "style-src 'unsafe-inline' https: http://127.0.0.1:*",
  "img-src * data: blob:",
  "font-src * data:",
  "media-src * data: blob:",
  "object-src * data: blob:",
  "connect-src *",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "child-src 'none'",
].join("; ");

const outputDocumentWorker: ExportedHandler<OutputDocumentEnv> = {
  async fetch(request: Request, env: OutputDocumentEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ status: "ok", service: "nteract-notebook-cloud-output-document" });
    }

    if (!OUTPUT_DOCUMENT_PATHS.has(url.pathname)) {
      return json({ error: "not found" }, 404);
    }
    if (!env.ASSETS) {
      return json({ error: "output document assets are not configured" }, 503);
    }

    const assetUrl = new URL(request.url);
    assetUrl.pathname = OUTPUT_DOCUMENT_ASSET_PATH;
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    return withOutputDocumentHeaders(new Response(response.body, response));
  },
};

export default outputDocumentWorker;

function json(value: unknown, status = 200): Response {
  return withOutputDocumentHeaders(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return withOutputDocumentHeaders(response);
}

function withOutputDocumentHeaders(response: Response): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  response.headers.set("Content-Security-Policy", OUTPUT_DOCUMENT_CSP);
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "picture-in-picture=()",
      "publickey-credentials-get=()",
      "screen-wake-lock=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  );
  response.headers.delete("Set-Cookie");
  response.headers.delete("Access-Control-Allow-Credentials");
  if (response.ok && response.headers.get("Content-Type")?.includes("text/html")) {
    response.headers.set("Cache-Control", "public, max-age=300, must-revalidate");
  } else if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}
