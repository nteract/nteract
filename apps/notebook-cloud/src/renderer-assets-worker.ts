import type { Env, ExportedHandler } from "./cloudflare-types.ts";

type RendererAssetsEnv = Pick<Env, "ASSETS">;

const rendererAssetsWorker: ExportedHandler<RendererAssetsEnv> = {
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
      return json({ error: "renderer assets are not configured" }, 503);
    }

    const assetUrl = new URL(request.url);
    assetUrl.pathname = assetPathname;
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    return withRendererAssetCors(new Response(response.body, response), { immutable: true });
  },
};

export default rendererAssetsWorker;

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
  options: { immutable?: boolean } = {},
): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  if (options.immutable && response.ok) {
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return response;
}
