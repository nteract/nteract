/**
 * Output-session plugins: host-side bridges for outputs whose iframe renderer
 * talks to a live session (e.g. a kernel-owned Bokeh document) after render.
 *
 * A plugin claims output MIME types, derives bindings from the outputs it
 * claims, and creates one bridge per isolated frame. The bridge serves the
 * iframe→host request methods the plugin lists in `hostMethods` and pushes
 * updates to the frame with `IsolatedFrameHandle.notifyExtension`. Plugins
 * register once at startup; the app supplies each plugin's runtime value
 * through `OutputSessionRuntimeContext`, keyed by plugin id.
 */

import { createContext, useContext } from "react";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";

export interface OutputSessionBridge {
  setBindings(bindings: unknown[]): void;
  updateRuntime(runtime: unknown): void;
  handleRequest(method: string, params: unknown): Promise<unknown>;
  /** Push any state the frame has not seen yet; called after each render batch. */
  notifyCurrentState(): void;
  dispose(): void;
}

export interface OutputSessionPlugin<Binding = unknown, Runtime = unknown> {
  id: string;
  mimeTypes: readonly string[];
  /** Iframe→host request methods this plugin serves. */
  hostMethods: readonly string[];
  bindings(outputs: readonly JupyterOutput[]): Binding[];
  createBridge(opts: {
    frame: IsolatedFrameHandle;
    runtime: Runtime;
    bindings: Binding[];
  }): OutputSessionBridge | null;
}

type AnyOutputSessionPlugin = OutputSessionPlugin<unknown, unknown>;

const plugins = new Map<string, AnyOutputSessionPlugin>();
let pluginSnapshot: readonly AnyOutputSessionPlugin[] = [];
let hostMethodSnapshot: readonly string[] = [];

function refreshSnapshots(): void {
  pluginSnapshot = Object.freeze([...plugins.values()]);
  hostMethodSnapshot = Object.freeze(pluginSnapshot.flatMap((plugin) => plugin.hostMethods));
}

/**
 * Register a plugin. Re-registering the same id replaces it, so app-level
 * install calls may run more than once. Returns an unregister function.
 */
export function registerOutputSessionPlugin<Binding, Runtime>(
  plugin: OutputSessionPlugin<Binding, Runtime>,
): () => void {
  const entry = plugin as AnyOutputSessionPlugin;
  const unregister = () => {
    if (plugins.get(entry.id) === entry) {
      plugins.delete(entry.id);
      refreshSnapshots();
    }
  };
  // Keep snapshot identities stable for repeated installs from render.
  if (plugins.get(entry.id) === entry) return unregister;
  for (const other of plugins.values()) {
    if (other.id === entry.id) continue;
    const method = entry.hostMethods.find((candidate) => other.hostMethods.includes(candidate));
    if (method) {
      throw new Error(
        `Output session plugin "${entry.id}" claims host method ${method}, already served by "${other.id}"`,
      );
    }
  }
  plugins.set(entry.id, entry);
  refreshSnapshots();
  return unregister;
}

/** Registered plugins. The array identity changes only when the set changes. */
export function getOutputSessionPlugins(): readonly AnyOutputSessionPlugin[] {
  return pluginSnapshot;
}

/** Host methods of every registered plugin, for `IsolatedFrame.extensionMethods`. */
export function getOutputSessionHostMethods(): readonly string[] {
  return hostMethodSnapshot;
}

export function getOutputSessionPluginForMethod(method: string): AnyOutputSessionPlugin | null {
  return pluginSnapshot.find((plugin) => plugin.hostMethods.includes(method)) ?? null;
}

function outputClaimsMime(output: JupyterOutput, mimeTypes: readonly string[]): boolean {
  if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
    return false;
  }
  return mimeTypes.some((mimeType) => mimeType in output.data);
}

export interface OutputSessionPluginBindings {
  plugin: AnyOutputSessionPlugin;
  bindings: unknown[];
}

/**
 * Bindings for each plugin whose MIME types appear in `outputs`, keyed by
 * plugin id. Plugins with no bindings are omitted.
 */
export function outputSessionBindings(
  outputs: readonly JupyterOutput[],
): ReadonlyMap<string, OutputSessionPluginBindings> {
  const result = new Map<string, OutputSessionPluginBindings>();
  for (const plugin of pluginSnapshot) {
    if (!outputs.some((output) => outputClaimsMime(output, plugin.mimeTypes))) continue;
    const bindings = plugin.bindings(outputs);
    if (bindings.length > 0) result.set(plugin.id, { plugin, bindings });
  }
  return result;
}

/** Runtime values by plugin id, provided once by the app. */
export const OutputSessionRuntimeContext = createContext<Readonly<Record<string, unknown>>>(
  Object.freeze({}),
);

export function useOutputSessionRuntimes(): Readonly<Record<string, unknown>> {
  return useContext(OutputSessionRuntimeContext);
}

/**
 * The output-session bridges of one isolated frame, one per plugin id. A
 * bridge exists while the frame is mounted, the plugin has bindings in the
 * frame's outputs and the app provides the plugin's runtime.
 */
export class OutputSessionBridges {
  private readonly active = new Map<string, OutputSessionBridge>();

  sync(
    frame: IsolatedFrameHandle | null,
    bindings: ReadonlyMap<string, OutputSessionPluginBindings>,
    runtimes: Readonly<Record<string, unknown>>,
  ): void {
    for (const [id, bridge] of this.active) {
      if (!frame || !bindings.has(id) || runtimes[id] === undefined) {
        bridge.dispose();
        this.active.delete(id);
      }
    }
    if (!frame) return;
    for (const [id, entry] of bindings) {
      const runtime = runtimes[id];
      if (runtime === undefined) continue;
      let bridge = this.active.get(id);
      if (bridge) {
        bridge.setBindings(entry.bindings);
      } else {
        const created = entry.plugin.createBridge({ frame, runtime, bindings: entry.bindings });
        if (!created) continue;
        bridge = created;
        this.active.set(id, bridge);
      }
      bridge.updateRuntime(runtime);
    }
  }

  notifyCurrentState(): void {
    for (const bridge of this.active.values()) {
      bridge.notifyCurrentState();
    }
  }

  handleRequest(method: string, params: unknown): Promise<unknown> {
    const plugin = getOutputSessionPluginForMethod(method);
    if (!plugin) {
      return Promise.reject(new Error(`No output session plugin serves ${method}`));
    }
    const bridge = this.active.get(plugin.id);
    if (!bridge) {
      return Promise.reject(
        new Error(`Output session "${plugin.id}" is unavailable for this output`),
      );
    }
    return bridge.handleRequest(method, params);
  }

  dispose(): void {
    for (const bridge of this.active.values()) {
      bridge.dispose();
    }
    this.active.clear();
  }
}
