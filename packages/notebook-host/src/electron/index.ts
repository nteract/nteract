import {
  createHttpBlobResolver,
  NotebookClient,
  type NotebookResponse,
  type SaveBlockedReason,
} from "runtimed";
import { createCommandRegistry } from "../commands";
import type {
  HostBlobResolver,
  HostBlobs,
  HostDaemonEvents,
  HostLog,
  HostUpdaterState,
  NotebookHost,
  Unlisten,
} from "../types";
import { ElectronHostClient } from "./client";
import {
  ELECTRON_HOST_PROTOCOL_VERSION,
  type ElectronHostConnection,
  type ElectronHostEvent,
  type ElectronHostEventMap,
  type ElectronHostMethod,
  type ElectronHostMethodParams,
  type ElectronHostMethodResult,
} from "./protocol";
import { ElectronTransport } from "./transport";

export interface CreateElectronHostOptions extends ElectronHostConnection {}

function describeSaveBlockedReason(reason: SaveBlockedReason): string {
  switch (reason.type) {
    case "path_already_open":
      return `Another notebook session already has ${reason.path} open.`;
    case "sequence_exhausted":
      return "The notebook save sequence was exhausted.";
    case "superseded":
      return `The notebook save was superseded by sequence ${reason.latest_sequence}.`;
    case "source_conflict":
    case "source_degraded":
    case "io":
      return reason.message;
  }
}

/**
 * Construct the notebook host used inside an Electron-owned iframe.
 *
 * The iframe receives only a MessagePort. It never receives ipcRenderer,
 * Electron APIs, filesystem primitives, or the runtimed Unix socket path.
 */
export function createElectronHost(options: CreateElectronHostOptions): NotebookHost {
  if (options.bootstrap.protocolVersion !== ELECTRON_HOST_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Electron host protocol ${options.bootstrap.protocolVersion}; expected ${ELECTRON_HOST_PROTOCOL_VERSION}.`,
    );
  }
  const outputDocumentUrl = options.bootstrap.outputDocumentUrl.trim();
  const outputDocumentProtocol = new URL(outputDocumentUrl).protocol;
  if (["javascript:", "data:", "blob:"].includes(outputDocumentProtocol)) {
    throw new Error(
      `Electron output document must use a host-served URL, not ${outputDocumentProtocol}`,
    );
  }

  const client = new ElectronHostClient(options.port);
  const transport = new ElectronTransport(client);
  const notebookClient = new NotebookClient({ transport });
  const invoke = <M extends ElectronHostMethod>(
    method: M,
    params: ElectronHostMethodParams<M>,
    requestOptions?: { timeoutMs?: number },
  ): Promise<ElectronHostMethodResult<M>> => client.invoke(method, params, requestOptions);
  const onEvent = <E extends ElectronHostEvent>(
    event: E,
    cb: (payload: ElectronHostEventMap[E]) => void,
  ): Unlisten => client.onEvent(event, cb);

  const daemonEvents: HostDaemonEvents = {
    onReadyLive: (cb) => onEvent("daemon.ready", cb),
    onReady(cb) {
      let cancelled = false;
      const unlisten = onEvent("daemon.ready", (payload) => {
        if (!cancelled) cb(payload);
      });
      void invoke("daemon.getReadyInfo", undefined)
        .then((payload) => {
          if (!cancelled && payload) cb(payload);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        unlisten();
      };
    },
    onProgress: (cb) => onEvent("daemon.progress", cb),
    onDisconnected: (cb) => onEvent("daemon.disconnected", cb),
    onUnavailable: (cb) => onEvent("daemon.unavailable", cb),
  };

  let blobResolver: HostBlobResolver | null = null;
  const blobs: HostBlobs = {
    async port() {
      return invoke("blobs.getPort", undefined);
    },
    async resolver() {
      const port = await invoke("blobs.getPort", undefined);
      if (blobResolver?.port === port) return blobResolver;
      blobResolver = createHttpBlobResolver(port);
      return blobResolver;
    },
  };

  let updaterState: HostUpdaterState = options.bootstrap.updaterState ?? {
    status: "idle",
    version: null,
    error: null,
  };
  const updaterSubscribers = new Set<() => void>();
  onEvent("updater.changed", (state) => {
    updaterState = state;
    for (const subscriber of updaterSubscribers) subscriber();
  });

  const commands = createCommandRegistry();
  onEvent("command", ({ id, payload }) => {
    void commands.run(id, payload).catch((error) => {
      console.error(`[electron-host] command failed: ${id}`, error);
    });
  });

  const log = Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (message: string) => client.notify({ method: `log.${level}`, params: { message } }),
    ]),
  ) as unknown as HostLog;

  const host: NotebookHost = {
    name: "electron",
    outputDocumentUrl,
    transport,
    daemon: {
      isConnected: () => invoke("daemon.isConnected", undefined),
      reconnect: (reconnectOptions) =>
        invoke("daemon.reconnect", { force: reconnectOptions?.force }),
      getInfo: () => invoke("daemon.getInfo", undefined),
      getReadyInfo: () => invoke("daemon.getReadyInfo", undefined),
    },
    daemonEvents,
    relay: {
      requiresReadyGeneration: false,
      async prepareSync(generation) {
        await invoke("relay.prepareSync", { generation });
      },
      async notifySyncReady(generation) {
        await invoke("relay.notifySyncReady", { generation });
        transport.releaseFrames();
      },
    },
    blobs,
    trust: {
      async approve(approveOptions) {
        const response = (await transport.sendRequest({
          type: "approve_trust",
          ...(approveOptions?.observedHeads !== undefined
            ? { observed_heads: approveOptions.observedHeads }
            : {}),
        })) as NotebookResponse;
        switch (response.result) {
          case "ok":
            return;
          case "guard_rejected":
            throw new Error(response.reason);
          case "error":
            throw new Error(response.error);
          default:
            throw new Error(`Unexpected approve_trust response: ${JSON.stringify(response)}`);
        }
      },
    },
    deps: {
      checkTyposquats: (packages) => invoke("deps.checkTyposquats", { packages }),
    },
    notebook: {
      applyPathChanged: (path) => invoke("notebook.applyPathChanged", { path }),
      getDefaultSaveDirectory: () => invoke("notebook.getDefaultSaveDirectory", undefined),
      async saveAs(path) {
        const outcome = await notebookClient.saveNotebook({ formatCells: true, path });
        if (outcome.outcome === "blocked")
          throw new Error(describeSaveBlockedReason(outcome.reason));
      },
      openInNewWindow: (path) => invoke("notebook.openInNewWindow", { path }),
      openHostedInNewWindow: (url) => invoke("notebook.openHostedInNewWindow", { url }),
      cloneToEphemeral: () => invoke("notebook.cloneToEphemeral", undefined),
    },
    window: {
      getTitle: () => invoke("window.getTitle", undefined),
      setTitle: (title) => invoke("window.setTitle", { title }),
      setTheme: (theme) => invoke("window.setTheme", { theme }),
      onFocusChange: (cb) => onEvent("window.focusChanged", cb),
    },
    system: {
      getGitInfo: () => invoke("system.getGitInfo", undefined),
      getUsername: () => invoke("system.getUsername", undefined),
      getFontFamilies: () => invoke("system.getFontFamilies", undefined),
    },
    dialog: {
      openFile: (dialogOptions) => invoke("dialog.openFile", dialogOptions, { timeoutMs: 0 }),
      saveFile: (dialogOptions) => invoke("dialog.saveFile", dialogOptions, { timeoutMs: 0 }),
    },
    externalLinks: {
      open: (url) => invoke("externalLinks.open", { url }),
    },
    updater: {
      getSnapshot: () => updaterState,
      subscribe(cb) {
        updaterSubscribers.add(cb);
        return () => updaterSubscribers.delete(cb);
      },
      async check() {
        updaterState = await invoke("updater.check", undefined);
        for (const subscriber of updaterSubscribers) subscriber();
        return updaterState;
      },
      beginUpgrade: () => invoke("updater.beginUpgrade", undefined, { timeoutMs: 300_000 }),
    },
    settings: {
      openWindow: () => invoke("settings.openWindow", undefined),
      getSynced: () => invoke("settings.getSynced", undefined),
      setSynced: (key, value) => invoke("settings.setSynced", { key, value }),
      rotateInstallId: () => invoke("settings.rotateInstallId", undefined),
      onChanged: (cb) => onEvent("settings.changed", cb),
    },
    commands,
    log,
  };

  // Start only after transport and host-event listeners exist. MessagePort
  // queues anything the main process sent before this point.
  client.start();
  return host;
}

export { ElectronHostClient } from "./client";
export { ElectronTransport } from "./transport";
export {
  ELECTRON_HOST_PROTOCOL_VERSION,
  connectElectronNotebookFrame,
  isElectronHostConnectMessage,
  isElectronHostMethod,
  onElectronNotebookFrameReady,
  waitForElectronHostConnection,
  type ElectronHostBootstrap,
  type ElectronHostConnection,
  type ElectronHostConnectMessage,
  type ElectronHostEvent,
  type ElectronHostEventMap,
  type ElectronHostMethod,
  type ElectronHostMethodMap,
  type ElectronHostMethodParams,
  type ElectronHostMethodResult,
  type ElectronHostNotification,
  type ElectronHostPortMessage,
  type ElectronHostReadyMessage,
  type OnElectronNotebookFrameReadyOptions,
  type WaitForElectronHostConnectionOptions,
} from "./protocol";
