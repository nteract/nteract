/**
 * The renderer's only door to the file system. No Node in the renderer: the
 * window is sandboxed and context-isolated, and this exposes three calls.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { HarnessBridge } from "../shared/bridge";

const bridge: HarnessBridge = {
  openFile: (path) => ipcRenderer.invoke("harness:open-file", path),
  stat: (path) => ipcRenderer.invoke("harness:stat", path),
  readRange: (request) => ipcRenderer.invoke("harness:read-range", request),
};

contextBridge.exposeInMainWorld("harness", bridge);
