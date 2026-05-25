/**
 * On-demand library loading for isolated iframes.
 *
 * Heavy output renderers are NOT bundled into the isolated renderer IIFE.
 * Instead, they are built as renderer plugins — CJS modules loaded via
 * `frame.installRenderer()`. The iframe's plugin loader provides a shared
 * React instance and a registration API. No window globals needed.
 *
 * Each plugin has its own virtual module (`virtual:renderer-plugin/{name}`)
 * so Vite can code-split them into independent chunks that load only when
 * their MIME types appear in cell outputs.
 *
 * The MIME type → plugin name mapping lives in `renderer-plugin-info` so
 * external embedders, like the MCP App, use the same dispatch table as the
 * in-app notebook renderer.
 */

import { logIsolatedDiagnostic } from "@/components/isolated/diagnostics";
import {
  needsRendererPlugin,
  rendererPluginNameForMime,
  type RendererPluginName,
} from "./renderer-plugin-info";

interface PluginModule {
  id?: string;
  code: string;
  css?: string;
}

export interface RendererPluginTarget {
  installRenderer(code: string, css?: string): void;
}

/** Normalize a raw virtual module import to { code, css? }. */
function normalize(m: { code: string; css?: string }): PluginModule {
  return { code: m.code, css: m.css || undefined };
}

const PLUGIN_LOADERS: Record<RendererPluginName, () => Promise<PluginModule>> = {
  markdown: () => import("virtual:renderer-plugin/markdown").then(normalize),
  plotly: () => import("virtual:renderer-plugin/plotly").then(normalize),
  vega: () => import("virtual:renderer-plugin/vega").then(normalize),
  leaflet: () => import("virtual:renderer-plugin/leaflet").then(normalize),
  sift: () => import("virtual:renderer-plugin/sift").then(normalize),
};

/**
 * Check whether a MIME type requires a renderer plugin.
 */
export function needsPlugin(mime: string): boolean {
  return needsRendererPlugin(mime);
}

/** Cache of plugin code promises, keyed by shared plugin name. */
const pluginCache = new Map<string, Promise<PluginModule>>();

/**
 * Load the renderer plugin for a MIME type.
 * Returns undefined if the MIME type doesn't need a plugin.
 * Deduplicates concurrent loads for the same MIME type.
 */
export function loadPluginForMime(mime: string): Promise<PluginModule | undefined> {
  const pluginName = rendererPluginNameForMime(mime);
  if (!pluginName) return Promise.resolve(undefined);

  const cached = pluginCache.get(pluginName);
  if (cached) return cached;

  const loader = PLUGIN_LOADERS[pluginName];
  const promise = loader()
    .then((plugin) => ({ ...plugin, id: pluginName }))
    .catch((error) => {
      if (pluginCache.get(pluginName) === promise) {
        pluginCache.delete(pluginName);
      }
      throw error;
    });
  pluginCache.set(pluginName, promise);
  return promise;
}

/**
 * Pre-warm the plugin cache for the given MIME types.
 * Kicks off virtual module fetches so later injection resolves instantly.
 */
export function preWarmForMimes(mimes: Iterable<string>): void {
  for (const mime of mimes) {
    loadPluginForMime(mime).catch((error) => {
      console.warn(`[iframe-libraries] failed to prewarm renderer plugin for "${mime}":`, error);
    });
  }
}

/**
 * Install renderer plugins required by the given MIME types into an iframe.
 * Idempotent per iframe — tracks what has been installed via `injectedSet`.
 */
export async function injectPluginsForMimes(
  frame: RendererPluginTarget,
  mimes: Iterable<string>,
  injectedSet: Set<string>,
): Promise<void> {
  for (const mime of mimes) {
    const installKey = rendererPluginNameForMime(mime) ?? mime;
    if (injectedSet.has(installKey)) continue;
    const plugin = await loadPluginForMime(mime);
    if (!plugin) continue;
    logIsolatedDiagnostic({
      source: "iframe-libraries",
      phase: "renderer-plugin-install-dispatch",
      details: {
        mime,
        codeLength: plugin.code.length,
        hasCss: plugin.css !== undefined,
        cssLength: plugin.css?.length ?? 0,
      },
    });
    frame.installRenderer(plugin.code, plugin.css);
    injectedSet.add(installKey);
  }
}
