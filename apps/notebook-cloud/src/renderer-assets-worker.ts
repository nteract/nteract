import type { Env, ExportedHandler } from "./cloudflare-types.ts";

type RendererAssetsEnv = Pick<Env, "ASSETS">;

export function createRendererAssetsWorker({
  fallbackToOrigin = true,
}: { fallbackToOrigin?: boolean } = {}): ExportedHandler<RendererAssetsEnv> {
  // Cloudflare path Routes can fall through to the main Custom Domain Worker.
  // A standalone celld service has no downstream origin; fetching itself would
  // recurse on a miss, so its generated entrypoint disables this fallback.
  const fallback = (request: Request, response: Response) =>
    fallbackToOrigin ? fallThroughToOrigin(request, response) : response;
  return {
    async fetch(request: Request, env: RendererAssetsEnv): Promise<Response> {
      if (request.method === "OPTIONS") {
        return withRendererAssetCors(new Response(null, { status: 204 }));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" }, 405);
      }

      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return json({ status: "ok", service: "nteract-notebook-cloud-renderer-assets" });
      }

      const assetPathname = assetPathnameForRequest(url.pathname);
      if (!assetPathname) {
        return json({ error: "not found" }, 404);
      }
      if (!env.ASSETS) {
        return fallback(request, json({ error: "renderer assets are not configured" }, 503));
      }

      const assetUrl = new URL(request.url);
      assetUrl.pathname = assetPathname;
      let response: Response;
      try {
        response = await env.ASSETS.fetch(new Request(assetUrl, request));
      } catch {
        return fallback(request, json({ error: "renderer assets are unavailable" }, 503));
      }
      const assetResponse = withRendererAssetCors(new Response(response.body, response), {
        assetPathname,
      });
      if (response.status >= 400) {
        return fallback(request, assetResponse);
      }
      return assetResponse;
    },
  };
}

export default createRendererAssetsWorker();

function assetPathnameForRequest(pathname: string): string | null {
  if (pathname.startsWith("/renderer-assets/")) {
    return rendererAssetPathname(pathname.slice("/renderer-assets/".length));
  }
  if (pathname.startsWith("/plugins/")) {
    return rendererAssetPathname(pathname.slice("/plugins/".length));
  }
  return null;
}

function rendererAssetPathname(rawName: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }

  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return null;
  }

  return `/${name}`;
}

async function fallThroughToOrigin(request: Request, fallback: Response): Promise<Response> {
  try {
    // A path Route can continue to the Worker on the matching Custom Domain by
    // fetching the untouched incoming request. Keep the main Worker's bundled
    // renderer assets available while the two Workers roll out independently.
    return await fetch(request);
  } catch {
    // Preserve the renderer Worker's original error if the downstream request
    // cannot be completed.
    return fallback;
  }
}

function json(value: unknown, status = 200): Response {
  return withRendererAssetCors(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function withRendererAssetCors(
  response: Response,
  options: { assetPathname?: string | null } = {},
): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Timing-Allow-Origin", "*");
  if (options.assetPathname && response.ok) {
    response.headers.set(
      "Cache-Control",
      isContentHashedAssetPathname(options.assetPathname)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    );
  }
  return response;
}

function isContentHashedAssetPathname(pathname: string): boolean {
  const name = pathname.split("/").pop() ?? "";
  return /\.[a-f0-9]{12,64}\.(?:css|js|wasm)$/.test(name);
}
