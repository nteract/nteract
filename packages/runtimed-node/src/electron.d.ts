export const ELECTRON_HOST_PROTOCOL_VERSION: 1;

export type ConnectionStatus = "connecting" | "online" | "offline" | "reconnecting";

export type ElectronHostNativeTheme = "light" | "dark" | "system";
export type ElectronHostUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "unavailable"
  | "error";

export interface ElectronHostUpdaterState {
  status: ElectronHostUpdateStatus;
  version: string | null;
  error: string | null;
}

export interface ElectronHostMethodMap {
  "daemon.isConnected": { params: undefined; result: boolean };
  "daemon.reconnect": { params: { force?: boolean }; result: void };
  "daemon.getInfo": { params: undefined; result: unknown | null };
  "daemon.getReadyInfo": { params: undefined; result: unknown | null };
  "relay.prepareSync": { params: { generation?: number }; result: void };
  "relay.notifySyncReady": { params: { generation?: number }; result: void };
  "blobs.getPort": { params: undefined; result: number };
  "deps.checkTyposquats": { params: { packages: string[] }; result: unknown[] };
  "notebook.applyPathChanged": { params: { path: string }; result: void };
  "notebook.getDefaultSaveDirectory": { params: undefined; result: string };
  "notebook.openInNewWindow": { params: { path: string }; result: void };
  "notebook.openHostedInNewWindow": { params: { url: string }; result: void };
  "notebook.cloneToEphemeral": { params: undefined; result: string };
  "window.getTitle": { params: undefined; result: string };
  "window.setTitle": { params: { title: string }; result: void };
  "window.setTheme": { params: { theme: ElectronHostNativeTheme }; result: void };
  "system.getGitInfo": { params: undefined; result: unknown | null };
  "system.getUsername": { params: undefined; result: string };
  "system.getFontFamilies": { params: undefined; result: string[] };
  "dialog.openFile": { params: unknown; result: string | null };
  "dialog.saveFile": { params: unknown; result: string | null };
  "externalLinks.open": { params: { url: string }; result: void };
  "updater.check": { params: undefined; result: ElectronHostUpdaterState };
  "updater.beginUpgrade": { params: undefined; result: void };
  "settings.openWindow": { params: undefined; result: void };
  "settings.getSynced": { params: undefined; result: Record<string, unknown> };
  "settings.setSynced": { params: { key: string; value: unknown }; result: void };
  "settings.rotateInstallId": { params: undefined; result: string };
}

export type ElectronHostMethod = keyof ElectronHostMethodMap;
export const ELECTRON_HOST_METHODS: readonly ElectronHostMethod[];
export type ElectronHostMethodParams<M extends ElectronHostMethod> =
  ElectronHostMethodMap[M]["params"];
export type ElectronHostMethodResult<M extends ElectronHostMethod> =
  ElectronHostMethodMap[M]["result"];

export type ElectronHostNotification =
  | { method: "log.debug"; params: { message: string } }
  | { method: "log.info"; params: { message: string } }
  | { method: "log.warn"; params: { message: string } }
  | { method: "log.error"; params: { message: string } };

export interface ElectronHostEventMap {
  "daemon.ready": unknown;
  "daemon.progress": unknown;
  "daemon.disconnected": undefined;
  "daemon.unavailable": unknown;
  "transport.status": ConnectionStatus;
  "window.focusChanged": boolean;
  "updater.changed": ElectronHostUpdaterState;
  "settings.changed": Record<string, unknown>;
  command: { id: string; payload: unknown };
}

export interface ElectronMainPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): this;
  on(event: "close", listener: () => void): this;
  off(event: "message", listener: (event: { data: unknown }) => void): this;
  off(event: "close", listener: () => void): this;
  start(): void;
  close(): void;
}

/** Structural RelaySession surface; accepts @runtimed/node/relay sessions and test doubles. */
export interface ElectronRelaySession {
  send(frame: Uint8Array | ArrayBuffer): Promise<void>;
  onFrame(listener: (frame: Uint8Array) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface ElectronNotebookHostHandler {
  invoke<M extends ElectronHostMethod>(
    method: M,
    params: ElectronHostMethodParams<M>,
  ): Promise<ElectronHostMethodResult<M>> | ElectronHostMethodResult<M>;
  notify?(notification: ElectronHostNotification): void;
}

export interface ElectronNotebookHostServer {
  emit<E extends keyof ElectronHostEventMap>(event: E, payload: ElectronHostEventMap[E]): void;
  close(): Promise<void>;
}

export function serveElectronNotebookHost(options: {
  port: ElectronMainPort;
  relay: ElectronRelaySession;
  handler: ElectronNotebookHostHandler;
}): ElectronNotebookHostServer;
