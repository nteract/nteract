import type { NteractOutputRendererPluginLoader } from "@/components/isolated/output-embed";
import { rendererPluginInfoForMime } from "@/components/isolated/renderer-plugin-info";

declare const __DAEMON_PLUGIN_ASSET_HASHES__: Record<string, string> | undefined;

const PLUGIN_ASSET_HASHES =
  typeof __DAEMON_PLUGIN_ASSET_HASHES__ === "object" ? __DAEMON_PLUGIN_ASSET_HASHES__ : {};

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function rendererPluginAssetUrl(blobBaseUrl: string, filename: string): string {
  const version = PLUGIN_ASSET_HASHES[filename];
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  return `${trimTrailingSlash(blobBaseUrl)}/renderer-plugins/${filename}${suffix}`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch renderer plugin asset ${url}: ${response.status}`);
  }
  return response.text();
}

export function createDaemonRendererPluginLoader(
  blobBaseUrl: string | undefined,
): NteractOutputRendererPluginLoader | undefined {
  if (!blobBaseUrl) return undefined;

  const cache = new Map<string, Promise<{ code: string; css?: string } | undefined>>();

  return (mime) => {
    const info = rendererPluginInfoForMime(mime);
    if (!info) return Promise.resolve(undefined);

    const cached = cache.get(info.name);
    if (cached) return cached;

    const codeUrl = rendererPluginAssetUrl(blobBaseUrl, `${info.name}.js`);
    const cssUrl = info.hasCss
      ? rendererPluginAssetUrl(blobBaseUrl, `${info.name}.css`)
      : undefined;
    const promise = Promise.all([fetchText(codeUrl), cssUrl ? fetchText(cssUrl) : undefined])
      .then(([code, css]) => ({ id: info.name, code, css }))
      .catch((error) => {
        cache.delete(info.name);
        throw error;
      });

    cache.set(info.name, promise);
    return promise;
  };
}

export function daemonOutputFrameUrl(blobBaseUrl: string | undefined): string | null {
  if (!blobBaseUrl) return null;
  return `${trimTrailingSlash(blobBaseUrl)}/output-frame`;
}

export function daemonRendererAssetsBaseUrl(blobBaseUrl: string | undefined): string | undefined {
  if (!blobBaseUrl) return undefined;
  return `${trimTrailingSlash(blobBaseUrl)}/plugins/`;
}
