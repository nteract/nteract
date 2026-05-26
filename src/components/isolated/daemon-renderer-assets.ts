import type { NteractOutputRendererPluginLoader } from "./output-embed";
import { rendererPluginInfoForMime } from "./renderer-plugin-info";

declare const __DAEMON_PLUGIN_ASSET_HASHES__: Record<string, string> | undefined;

export interface DaemonRendererAssetCsp {
  frameDomains?: readonly string[];
}

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

  const cache = new Map<string, Promise<{ id: string; code: string; css?: string } | undefined>>();

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

interface ParsedCspSource {
  protocol: string;
  hostname: string;
  port: string;
}

const CSP_SOURCE_RE =
  /^([a-zA-Z][a-zA-Z\d+.-]*:)\/\/(\[[^\]]+\]|\*\.[^/:?#]+|[^/:?#]+)(?::(\*|\d+))?(?:[/?#]|$)/;

function parseCspSource(source: string): ParsedCspSource | null {
  const match = CSP_SOURCE_RE.exec(source.trim());
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  return {
    protocol,
    hostname: match[2].toLowerCase(),
    port: normalizeCspSourcePort(protocol, match[3] ?? ""),
  };
}

function normalizeCspSourcePort(protocol: string, port: string): string {
  if ((protocol === "https:" && port === "443") || (protocol === "http:" && port === "80")) {
    return "";
  }
  return port;
}

function sourceHostMatches(sourceHost: string, targetHost: string): boolean {
  if (sourceHost.startsWith("*.")) {
    const suffix = sourceHost.slice(2);
    return targetHost.endsWith(`.${suffix}`) && targetHost !== suffix;
  }
  return sourceHost === targetHost;
}

function sourcePortMatches(sourcePort: string, targetPort: string): boolean {
  return sourcePort === "*" || sourcePort === targetPort;
}

function frameDomainsAllowUrl(domains: readonly string[] | undefined, url: string): boolean {
  if (!domains || domains.length === 0) return false;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  const targetHost = target.hostname.toLowerCase();
  const targetPort = target.port;
  return domains.some((domain) => {
    if (domain === "*") return true;
    const source = parseCspSource(domain);
    if (!source) return false;
    return (
      source.protocol === target.protocol.toLowerCase() &&
      sourceHostMatches(source.hostname, targetHost) &&
      sourcePortMatches(source.port, targetPort)
    );
  });
}

export function daemonOutputFrameUrl(
  blobBaseUrl: string | undefined,
  hostCsp?: DaemonRendererAssetCsp | null,
): string | null {
  if (!blobBaseUrl) return null;
  const url = `${trimTrailingSlash(blobBaseUrl)}/output-frame`;
  if (!hostCsp) return url;
  return frameDomainsAllowUrl(hostCsp.frameDomains, url) ? url : null;
}

export function daemonRendererAssetsBaseUrl(blobBaseUrl: string | undefined): string | undefined {
  if (!blobBaseUrl) return undefined;
  return `${trimTrailingSlash(blobBaseUrl)}/plugins/`;
}
