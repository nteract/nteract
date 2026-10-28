/**
 * Harness main process: registers `harness://`, opens one window on the app
 * or embedded origin, and answers the preload's file IPC.
 *
 * Launch arguments (`electron . <file> --worker=0 …`) become the window's
 * query string, which the renderer reads:
 *
 *   <path> or --file=<path>   Parquet file to open (made readable to the renderer)
 *   --worker=0|1              Sift data worker (default 1)
 *   --autoLoad=scroll|manual|off
 *   --cap=<bytes>             worker allocationCap
 *   --maxDecoded=<bytes>      limits.maxDecodedBytes (default 512 MiB)
 *   --origin=app|embedded     which origin and CSP serves the renderer
 *   --spawn=module|blob       how the worker factory creates the worker
 *   --readDelayMs=<ms>        delay each readRange (main side), for tests
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { ReadRangeRequest } from "../shared/bridge";
import { createFileService } from "./files";
import {
  APP_ORIGIN,
  EMBEDDED_ORIGIN,
  handleHarnessScheme,
  registerHarnessScheme,
} from "./protocol";

const QUERY_KEYS = ["worker", "autoLoad", "cap", "maxDecoded", "origin", "spawn"] as const;

type LaunchOptions = {
  file: string | null;
  query: URLSearchParams;
  origin: string;
  readDelayMs: number;
};

function parseLaunch(argv: readonly string[]): LaunchOptions {
  const flags = new Map<string, string>();
  let file: string | null = null;
  // argv[0] is Electron, argv[1] the app path.
  for (const arg of argv.slice(2)) {
    const match = /^--([A-Za-z]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1]!, match[2]!);
    else if (!arg.startsWith("-") && existsSync(arg)) file = arg;
  }
  file = flags.get("file") ?? file;
  const query = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = flags.get(key);
    if (value !== undefined) query.set(key, value);
  }
  const origin = flags.get("origin") === "embedded" ? EMBEDDED_ORIGIN : APP_ORIGIN;
  return { file, query, origin, readDelayMs: Number(flags.get("readDelayMs") ?? 0) || 0 };
}

const launch = parseLaunch(process.argv);
const files = createFileService({ readDelayMs: launch.readDelayMs });
if (launch.file) launch.query.set("file", files.allow(launch.file));

registerHarnessScheme();

/** Only the harness's own origins may use the file bridge. */
function assertHarnessSender(event: IpcMainInvokeEvent) {
  // Node's URL reports `origin: "null"` for non-special schemes; build it.
  const url = event.senderFrame ? new URL(event.senderFrame.url) : null;
  const origin = url ? `${url.protocol}//${url.host}` : "";
  if (origin !== APP_ORIGIN && origin !== EMBEDDED_ORIGIN) {
    throw new Error(`File IPC refused for ${origin || "an unknown frame"}`);
  }
}

ipcMain.handle("harness:open-file", async (event, filePath: unknown) => {
  assertHarnessSender(event);
  if (typeof filePath === "string") return files.openFile(filePath);
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    properties: ["openFile" as const],
    filters: [{ name: "Parquet", extensions: ["parquet"] }],
  };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;
  return files.openFile(files.allow(picked.filePaths[0]));
});

ipcMain.handle("harness:stat", async (event, filePath: unknown) => {
  assertHarnessSender(event);
  if (typeof filePath !== "string") throw new Error("stat needs a path");
  return files.stat(filePath);
});

ipcMain.handle("harness:read-range", async (event, request: ReadRangeRequest) => {
  assertHarnessSender(event);
  return files.readRange(request);
});

app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  handleHarnessScheme(path.join(__dirname, "../renderer"));
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Sift Electron harness",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const search = launch.query.size > 0 ? `?${launch.query}` : "";
  void window.loadURL(`${launch.origin}/index.html${search}`);
});
