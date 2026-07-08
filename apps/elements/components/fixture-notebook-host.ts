import { EMPTY } from "rxjs";
import type { NotebookHost } from "@nteract/notebook-host";

export const noop = () => {};
export const asyncNoop = async () => {};
export const asyncTrue = async () => true;

const unlisten = () => {};

interface FixtureNotebookHostOptions {
  name?: string;
  transport?: Partial<NotebookHost["transport"]>;
}

export function createFixtureNotebookHost({
  name = "elements-fixture",
  transport: transportOverrides = {},
}: FixtureNotebookHostOptions = {}): NotebookHost {
  const transport: NotebookHost["transport"] = {
    sendFrame: asyncNoop,
    sendTypedRequest: async () => {
      throw new Error("Fixture host does not send typed requests.");
    },
    onFrame: () => unlisten,
    sendRequest: async () => {
      throw new Error("Fixture host does not send requests.");
    },
    connected: true,
    disconnect: noop,
    ...transportOverrides,
    connectionStatus$: transportOverrides.connectionStatus$ ?? EMPTY,
  };

  return {
    name,
    transport,
    daemon: {
      isConnected: async () => true,
      reconnect: asyncNoop,
      getInfo: async () => null,
      getReadyInfo: async () => null,
    },
    daemonEvents: {
      onReadyLive: () => unlisten,
      onReady: () => unlisten,
      onProgress: () => unlisten,
      onDisconnected: () => unlisten,
      onUnavailable: () => unlisten,
    },
    relay: {
      requiresReadyGeneration: false,
      notifySyncReady: asyncNoop,
    },
    blobs: {
      port: async () => 0,
      resolver: async () => {
        throw new Error("Fixture host does not resolve blobs.");
      },
    },
    trust: {
      approve: asyncNoop,
    },
    deps: {
      checkTyposquats: async () => [],
    },
    notebook: {
      applyPathChanged: asyncNoop,
      getDefaultSaveDirectory: async () => "/Users/kyle/notebooks",
      saveAs: asyncNoop,
      openInNewWindow: asyncNoop,
      cloneToEphemeral: async () => "fixture-room",
    },
    window: {
      getTitle: async () => "fixture.ipynb",
      setTitle: asyncNoop,
      setTheme: asyncNoop,
      onFocusChange: () => unlisten,
    },
    system: {
      getGitInfo: async () => null,
      getUsername: async () => "kyle",
      getFontFamilies: async () => ["Arial", "Georgia", "Menlo", "SF Mono", "Times New Roman"],
    },
    dialog: {
      openFile: async () => null,
      saveFile: async () => null,
    },
    externalLinks: {
      open: asyncNoop,
    },
    updater: {
      getSnapshot: () => ({ status: "idle", version: null, error: null }),
      subscribe: () => unlisten,
      check: async () => ({ status: "idle", version: null, error: null }),
      beginUpgrade: asyncNoop,
    },
    settings: {
      openWindow: asyncNoop,
      getSynced: async () => ({}),
      setSynced: asyncNoop,
      rotateInstallId: async () => "fixture-install-id",
      onChanged: () => unlisten,
    },
    commands: {
      register: () => unlisten,
      run: asyncNoop,
      list: () => [],
    },
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
  };
}
