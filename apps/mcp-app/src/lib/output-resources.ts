import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { OutputBlobResolver } from "@/components/isolated/output-manifest";
import { createRendererPluginLoader } from "@/components/isolated/renderer-plugin-loader";

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const ASSETS = "nteract://renderer-assets/";

export interface OutputResource {
  base64: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}
export type OutputResourceReader = (uri: string) => Promise<OutputResource>;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** One bounded cache for this widget instance; failures can be retried. */
export function createOutputResourceReader(
  read: (uri: string) => Promise<ReadResourceResult>,
): OutputResourceReader {
  const cache = new Map<string, Promise<OutputResource>>();
  const sizes = new Map<string, number>();
  let cachedBytes = 0;
  return (uri) => {
    const cached = cache.get(uri);
    if (cached) return cached;
    const pending = read(uri).then((result) => {
      const resource = result.contents.find((item) => item.uri === uri);
      if (!resource) throw new Error("MCP resource response did not contain the requested output");
      if ("blob" in resource && resource.blob.length > Math.ceil(MAX_RESOURCE_BYTES / 3) * 4) {
        throw new Error("Output resource exceeds the 16 MiB transfer limit");
      }
      const bytes = "blob" in resource
        ? Uint8Array.from(atob(resource.blob), (character) => character.charCodeAt(0))
        : new TextEncoder().encode(resource.text);
      if (bytes.byteLength > MAX_RESOURCE_BYTES) throw new Error("Output resource exceeds the 16 MiB transfer limit");
      const value = { bytes, base64: "blob" in resource ? resource.blob : encode(bytes), mimeType: resource.mimeType ?? "application/octet-stream" };
      cachedBytes += bytes.byteLength;
      sizes.set(uri, bytes.byteLength);
      while (cachedBytes > MAX_CACHED_BYTES) {
        const oldest = sizes.keys().next().value;
        if (!oldest) break;
        cachedBytes -= sizes.get(oldest) ?? 0;
        sizes.delete(oldest); cache.delete(oldest);
      }
      return value;
    }).catch((error) => { cache.delete(uri); throw error; });
    cache.set(uri, pending);
    return pending;
  };
}

export function createMcpOutputTransport(read: OutputResourceReader, resourceBase: string) {
  const blobUri = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid output blob hash");
    return `${resourceBase}${hash}`;
  };
  const blobResolver: OutputBlobResolver = {
    resolvesBinaryUrlsSynchronously: false,
    url() { throw new Error("MCP output URLs must be resolved asynchronously"); },
    async fetch(ref) {
      const resource = await read(blobUri(ref.blob));
      return new Response(resource.bytes, { headers: { "Content-Type": resource.mimeType } });
    },
    async displayUrl(ref, mimeType) {
      const resource = await read(blobUri(ref.blob));
      return `data:${mimeType ?? resource.mimeType};base64,${resource.base64}`;
    },
  };
  return {
    blobResolver,
    rendererPluginLoader: createRendererPluginLoader(async (name) => {
      const resource = await read(`${ASSETS}${name}`);
      return new TextDecoder().decode(resource.bytes);
    }),
    async rendererAssetUrls() {
      const resource = await read(`${ASSETS}sift_wasm.wasm`);
      return { "sift_wasm.wasm": `data:application/wasm;base64,${resource.base64}` };
    },
  };
}
