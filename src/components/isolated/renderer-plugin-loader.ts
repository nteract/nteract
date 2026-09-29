import type { NteractOutputRendererPluginLoader } from "./output-embed";
import { rendererPluginInfoForMime } from "./renderer-plugin-info";

/** Load the same plugin bundles through a host-provided transport. */
export function createRendererPluginLoader(
  readTextAsset: (name: string) => Promise<string>,
): NteractOutputRendererPluginLoader {
  const cache = new Map<string, Promise<{ id: string; code: string; css?: string } | undefined>>();

  return (mime) => {
    const info = rendererPluginInfoForMime(mime);
    if (!info) return Promise.resolve(undefined);

    const cached = cache.get(info.name);
    if (cached) return cached;

    const codeUrl = `${info.name}.js`;
    const cssUrl = info.hasCss ? `${info.name}.css` : undefined;
    const promise = Promise.all([
      readTextAsset(codeUrl),
      cssUrl ? readTextAsset(cssUrl) : undefined,
    ])
      .then(([code, css]) => ({ id: info.name, code, css }))
      .catch((error) => {
        cache.delete(info.name);
        throw error;
      });

    cache.set(info.name, promise);
    return promise;
  };
}
