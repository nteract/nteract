import type { ConnectionStatus } from "runtimed";
import type { CommandId, CommandPayloads } from "../commands";
import type {
  DaemonInfo,
  DaemonProgressPayload,
  DaemonReadyPayload,
  DaemonUnavailablePayload,
  GitInfo,
  HostDialogOpenOptions,
  HostDialogSaveOptions,
  HostNativeTheme,
  HostSyncedSettings,
  HostUpdaterState,
  TyposquatWarning,
} from "../types";

/**
 * Version of the capability-scoped Electron host protocol.
 *
 * This is deliberately independent of the runtimed wire protocol. Runtime
 * frames remain opaque and retain their own negotiated protocol number; this
 * version covers only the Electron host calls and events multiplexed beside
 * those frames on the transferred MessagePort.
 */
export const ELECTRON_HOST_PROTOCOL_VERSION = 1 as const;

export interface ElectronHostMethodMap {
  "daemon.isConnected": { params: undefined; result: boolean };
  "daemon.reconnect": { params: { force?: boolean }; result: void };
  "daemon.getInfo": { params: undefined; result: DaemonInfo | null };
  "daemon.getReadyInfo": { params: undefined; result: DaemonReadyPayload | null };
  "relay.prepareSync": { params: { generation?: number }; result: void };
  "relay.notifySyncReady": { params: { generation?: number }; result: void };
  "blobs.getPort": { params: undefined; result: number };
  "deps.checkTyposquats": { params: { packages: string[] }; result: TyposquatWarning[] };
  "notebook.applyPathChanged": { params: { path: string }; result: void };
  "notebook.getDefaultSaveDirectory": { params: undefined; result: string };
  "notebook.openInNewWindow": { params: { path: string }; result: void };
  "notebook.openHostedInNewWindow": { params: { url: string }; result: void };
  "notebook.cloneToEphemeral": { params: undefined; result: string };
  "window.getTitle": { params: undefined; result: string };
  "window.setTitle": { params: { title: string }; result: void };
  "window.setTheme": { params: { theme: HostNativeTheme }; result: void };
  "system.getGitInfo": { params: undefined; result: GitInfo | null };
  "system.getUsername": { params: undefined; result: string };
  "system.getFontFamilies": { params: undefined; result: string[] };
  "dialog.openFile": { params: HostDialogOpenOptions | undefined; result: string | null };
  "dialog.saveFile": { params: HostDialogSaveOptions | undefined; result: string | null };
  "externalLinks.open": { params: { url: string }; result: void };
  "updater.check": { params: undefined; result: HostUpdaterState };
  "updater.beginUpgrade": { params: undefined; result: void };
  "settings.openWindow": { params: undefined; result: void };
  "settings.getSynced": { params: undefined; result: HostSyncedSettings };
  "settings.setSynced": { params: { key: string; value: unknown }; result: void };
  "settings.rotateInstallId": { params: undefined; result: string };
}

export type ElectronHostMethod = keyof ElectronHostMethodMap;
export type ElectronHostMethodParams<M extends ElectronHostMethod> =
  ElectronHostMethodMap[M]["params"];
export type ElectronHostMethodResult<M extends ElectronHostMethod> =
  ElectronHostMethodMap[M]["result"];

export interface ElectronHostEventMap {
  "daemon.ready": DaemonReadyPayload;
  "daemon.progress": DaemonProgressPayload;
  "daemon.disconnected": undefined;
  "daemon.unavailable": DaemonUnavailablePayload;
  "transport.status": ConnectionStatus;
  "window.focusChanged": boolean;
  "updater.changed": HostUpdaterState;
  "settings.changed": HostSyncedSettings;
  command: { id: CommandId; payload: CommandPayloads[CommandId] };
}

export type ElectronHostEvent = keyof ElectronHostEventMap;

export type ElectronHostNotification =
  | { method: "log.debug"; params: { message: string } }
  | { method: "log.info"; params: { message: string } }
  | { method: "log.warn"; params: { message: string } }
  | { method: "log.error"; params: { message: string } };

export interface ElectronHostBootstrap {
  protocolVersion: typeof ELECTRON_HOST_PROTOCOL_VERSION;
  /**
   * URL of the emitted isolated output document. The Electron host must serve
   * this route with the output document's CSP, not the application CSP.
   */
  outputDocumentUrl: string;
  updaterState?: HostUpdaterState;
}

export interface ElectronHostFrameMessage {
  type: "nteract:frame";
  frame: ArrayBuffer | ArrayBufferView | number[];
}

export interface ElectronHostRequestMessage<M extends ElectronHostMethod = ElectronHostMethod> {
  type: "nteract:host-request";
  id: string;
  method: M;
  params: ElectronHostMethodParams<M>;
}

export interface ElectronHostSuccessMessage {
  type: "nteract:host-response";
  id: string;
  ok: true;
  value: unknown;
}

export interface ElectronHostFailureMessage {
  type: "nteract:host-response";
  id: string;
  ok: false;
  error: string;
}

export interface ElectronHostEventMessage<E extends ElectronHostEvent = ElectronHostEvent> {
  type: "nteract:host-event";
  event: E;
  payload: ElectronHostEventMap[E];
}

export interface ElectronHostNotificationMessage {
  type: "nteract:host-notification";
  notification: ElectronHostNotification;
}

export type ElectronHostPortMessage =
  | ElectronHostFrameMessage
  | ElectronHostRequestMessage
  | ElectronHostSuccessMessage
  | ElectronHostFailureMessage
  | ElectronHostEventMessage
  | ElectronHostNotificationMessage;

export interface ElectronHostConnectMessage {
  type: "nteract:electron-host-connect";
  bootstrap: ElectronHostBootstrap;
}

export interface ElectronHostReadyMessage {
  type: "nteract:electron-host-ready";
  protocolVersion: typeof ELECTRON_HOST_PROTOCOL_VERSION;
}

export interface ElectronHostConnection {
  port: MessagePort;
  bootstrap: ElectronHostBootstrap;
}

export function isElectronHostMethod(value: unknown): value is ElectronHostMethod {
  return typeof value === "string" && ELECTRON_HOST_METHODS.has(value as ElectronHostMethod);
}

const ELECTRON_HOST_METHODS = new Set<ElectronHostMethod>([
  "daemon.isConnected",
  "daemon.reconnect",
  "daemon.getInfo",
  "daemon.getReadyInfo",
  "relay.prepareSync",
  "relay.notifySyncReady",
  "blobs.getPort",
  "deps.checkTyposquats",
  "notebook.applyPathChanged",
  "notebook.getDefaultSaveDirectory",
  "notebook.openInNewWindow",
  "notebook.openHostedInNewWindow",
  "notebook.cloneToEphemeral",
  "window.getTitle",
  "window.setTitle",
  "window.setTheme",
  "system.getGitInfo",
  "system.getUsername",
  "system.getFontFamilies",
  "dialog.openFile",
  "dialog.saveFile",
  "externalLinks.open",
  "updater.check",
  "updater.beginUpgrade",
  "settings.openWindow",
  "settings.getSynced",
  "settings.setSynced",
  "settings.rotateInstallId",
]);

export function isElectronHostConnectMessage(value: unknown): value is ElectronHostConnectMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ElectronHostConnectMessage>;
  return (
    candidate.type === "nteract:electron-host-connect" &&
    candidate.bootstrap?.protocolVersion === ELECTRON_HOST_PROTOCOL_VERSION &&
    typeof candidate.bootstrap.outputDocumentUrl === "string" &&
    candidate.bootstrap.outputDocumentUrl.length > 0
  );
}

export interface WaitForElectronHostConnectionOptions {
  /** Exact origin of the trusted parent renderer. Wildcards are rejected. */
  parentOrigin: string;
  /** Defaults to this iframe's `window.parent`. */
  parentWindow?: WindowProxy;
  /** Defaults to 15 seconds. Set to 0 to wait indefinitely. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Bind an embedded notebook iframe to one capability-scoped MessagePort.
 *
 * The initial window message is the only origin-bearing step. After this
 * check, all traffic stays on the transferred port, so callers must provide
 * an exact trusted parent origin and source window.
 */
export function waitForElectronHostConnection(
  options: WaitForElectronHostConnectionOptions,
): Promise<ElectronHostConnection> {
  if (options.parentOrigin === "*") {
    return Promise.reject(new Error("Electron host parentOrigin must be exact, not '*'."));
  }

  const expectedSource = options.parentWindow ?? window.parent;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      options.signal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onAbort = () => fail(new Error("Electron host connection was aborted."));
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== expectedSource || event.origin !== options.parentOrigin) return;
      if (!isElectronHostConnectMessage(event.data)) return;
      const port = event.ports[0];
      if (!port) {
        fail(new Error("Electron host connection did not include a MessagePort."));
        return;
      }
      cleanup();
      resolve({ port, bootstrap: event.data.bootstrap });
    };

    if (options.signal?.aborted) {
      fail(new Error("Electron host connection was aborted."));
      return;
    }

    window.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      expectedSource.postMessage(
        {
          type: "nteract:electron-host-ready",
          protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
        } satisfies ElectronHostReadyMessage,
        options.parentOrigin,
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (timeoutMs > 0) {
      timeout = setTimeout(
        () => fail(new Error(`Electron host connection timed out after ${timeoutMs}ms.`)),
        timeoutMs,
      );
    }
  });
}

export interface OnElectronNotebookFrameReadyOptions {
  iframeWindow: WindowProxy;
  iframeOrigin: string;
  onReady(): void;
}

/** Wait for the iframe listener before transferring its one-use MessagePort. */
export function onElectronNotebookFrameReady(
  options: OnElectronNotebookFrameReadyOptions,
): () => void {
  if (options.iframeOrigin === "*") {
    throw new Error("Electron notebook iframeOrigin must be exact, not '*'.");
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== options.iframeWindow || event.origin !== options.iframeOrigin) return;
    const message = event.data as Partial<ElectronHostReadyMessage> | null;
    if (
      message?.type !== "nteract:electron-host-ready" ||
      message.protocolVersion !== ELECTRON_HOST_PROTOCOL_VERSION
    ) {
      return;
    }
    window.removeEventListener("message", onMessage);
    options.onReady();
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Parent-renderer helper. The exact iframe origin must be supplied. */
export function connectElectronNotebookFrame(
  targetWindow: WindowProxy,
  targetOrigin: string,
  connection: ElectronHostConnection,
): void {
  if (targetOrigin === "*") {
    throw new Error("Electron notebook targetOrigin must be exact, not '*'.");
  }
  targetWindow.postMessage(
    {
      type: "nteract:electron-host-connect",
      bootstrap: connection.bootstrap,
    } satisfies ElectronHostConnectMessage,
    targetOrigin,
    [connection.port],
  );
}
