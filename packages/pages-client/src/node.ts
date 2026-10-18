import WebSocket from "ws";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import {
  PagesClient,
  PagesError,
  pagesOrigin,
  type PageChanges,
  type Permission,
} from "./index.js";
export interface ConnectionFile {
  origin: string;
  token: string;
  page_id: string;
  driver?: string;
}
export function prepareConnection(
  origin: string,
  pageId: string,
  driver: string,
  permissions: Permission[] = ["read", "edit", "comment"],
) {
  origin = pagesOrigin(origin);
  if (!/^page_[a-f0-9]{32}$/.test(pageId) || !driver.trim() || driver.length > 80)
    throw Error("Provide a Page ID and connection name");
  const token = `pages_${randomBytes(32).toString("hex")}`;
  const request = {
    page_id: pageId,
    driver,
    permissions,
    token_hash: createHash("sha256").update(token).digest("hex"),
  };
  const url = new URL(origin);
  url.searchParams.set("connect", JSON.stringify(request));
  return { config: { origin, token, page_id: pageId }, approvalUrl: url.href };
}
export async function saveConnection(path: string, config: ConnectionFile) {
  await writeFile(path, JSON.stringify(config) + "\n", { mode: 0o600, flag: "wx" });
}
export async function loadConnection(path: string): Promise<ConnectionFile> {
  const info = await stat(path);
  if (process.platform !== "win32" && info.mode & 0o077)
    throw Error("Connection file must be accessible only to its owner (chmod 600)");
  const config = JSON.parse(await readFile(path, "utf8")) as ConnectionFile;
  pagesOrigin(config.origin);
  if (!/^pages_[a-f0-9]{64}$/.test(config.token) || !/^page_[a-f0-9]{32}$/.test(config.page_id))
    throw Error("Invalid connection file");
  return config;
}
/** Live semantic events; no local Automerge replica and no content polling. */
export function watchPage(
  config: ConnectionFile,
  onChange: (event: PageChanges) => void,
  options: { sinceSequence?: number; onError?: (error: Error) => void } = {},
) {
  const origin = pagesOrigin(config.origin);
  let since = options.sinceSequence ?? 0,
    stopped = false,
    socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempts = 0,
    pongAt = Date.now();
  function connect() {
    const url = new URL("/api/events", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("page", config.page_id);
    url.searchParams.set("since", String(since));
    socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(config.driver ? { "X-Pages-Driver": config.driver } : {}),
      },
      maxPayload: 2 * 1024 * 1024,
    });
    socket.on("open", () => {
      attempts = 0;
      pongAt = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - pongAt > 45000) socket?.terminate();
        else socket?.send("ping");
      }, 15000);
    });
    socket.on("message", (raw) => {
      try {
        if (raw.toString() === "pong") {
          pongAt = Date.now();
          return;
        }
        const message = JSON.parse(raw.toString());
        if (message.type === "page_changed") {
          const event = message.value as PageChanges;
          if (!Number.isSafeInteger(event.through_sequence) || event.through_sequence < 0)
            throw Error("Invalid change cursor");
          onChange(event);
          since = event.through_sequence;
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error : Error(String(error)));
        socket?.terminate();
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      // Revoked/expired credentials must not enter a reconnect loop.
      if ([401, 403, 404, 410].includes(response.statusCode ?? 0)) stopped = true;
      response.resume();
      socket?.terminate();
      options.onError?.(
        [404, 410].includes(response.statusCode ?? 0)
          ? new PagesError("Page deleted or unavailable", "not_found", 404, "not_committed")
          : Error(`Event connection rejected (${response.statusCode})`),
      );
    });
    socket.on("error", (error) => {
      if (!stopped) options.onError?.(error);
    });
    socket.on("close", (code) => {
      clearInterval(heartbeat);
      if (code === 4004) {
        stopped = true;
        options.onError?.(new PagesError("Page deleted", "not_found", 404, "not_committed"));
      }
      if (code === 4001) {
        stopped = true;
        options.onError?.(Error("Connection expired or revoked"));
      }
      if (!stopped) retry = setTimeout(connect, Math.min(10000, 500 * 2 ** attempts++));
    });
  }
  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.close();
    },
    client: new PagesClient(origin, { token: config.token, driver: config.driver }),
  };
}
