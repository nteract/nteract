/**
 * `createTauriHost()` — Tauri desktop app implementation of `NotebookHost`.
 *
 * Most methods are thin wrappers around an existing Tauri command or plugin
 * call, shaped to match the `NotebookHost` interface so call sites stop
 * importing `@tauri-apps/api` directly. Notebook-scoped control operations
 * that must be daemon-owned use the supplied `NotebookTransport`.
 *
 * The transport is passed in rather than constructed here because the
 * `TauriTransport` class currently lives in `apps/notebook/src/lib/` and
 * uses the shared frontend logger. A later PR will move the transport into
 * this package and tighten the import direction.
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pluginOpenDialog, save as pluginSaveDialog } from "@tauri-apps/plugin-dialog";
import {
  debug as pluginDebug,
  error as pluginError,
  info as pluginInfo,
  warn as pluginWarn,
} from "@tauri-apps/plugin-log";
import { open as pluginOpenShell } from "@tauri-apps/plugin-shell";
import { check as pluginCheckUpdate } from "@tauri-apps/plugin-updater";
import {
  ReconnectGovernor,
  createHttpBlobResolver,
  type NotebookResponse,
  type NotebookTransport,
} from "runtimed";
import { createCommandRegistry } from "../commands";
import { wireTauriMenuBridge } from "./menu-bridge";
import { TauriTransport } from "./transport";

import type {
  DaemonInfo,
  DaemonProgressPayload,
  DaemonReadyPayload,
  DaemonUnavailablePayload,
  GitInfo,
  HostBlobResolver,
  HostBlobs,
  HostDaemon,
  HostDaemonEvents,
  HostDeps,
  HostDialog,
  HostExternalLinks,
  HostLog,
  HostNotebook,
  HostRelay,
  HostSettings,
  HostSyncedSettings,
  HostSystem,
  HostTrust,
  HostUpdater,
  HostUpdaterState,
  HostWindow,
  NotebookHost,
  TyposquatWarning,
  Unlisten,
} from "../types";

export interface CreateTauriHostOptions {
  /**
   * Override the `NotebookTransport`. Defaults to a fresh `TauriTransport`
   * construction, which is what the desktop app should use at boot.
   * Provide a custom instance for tests or multi-transport scenarios.
   */
  transport?: NotebookTransport;
}

interface TauriFrameChannelTransport {
  subscribeNotebookFrames(generation?: number): Promise<void>;
}

function canSubscribeNotebookFrames(
  transport: NotebookTransport,
): transport is NotebookTransport & TauriFrameChannelTransport {
  return (
    typeof (transport as Partial<TauriFrameChannelTransport>).subscribeNotebookFrames === "function"
  );
}

/** Helper: subscribe to a Tauri webview event with a sync unlisten. */
function listenWebview<T>(eventName: string, cb: (payload: T) => void): Unlisten {
  const webview = getCurrentWebview();
  let unlisten: Unlisten | null = null;
  let cancelled = false;
  webview
    .listen<T>(eventName, (event) => {
      cb(event.payload);
    })
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

export function createTauriHost(opts: CreateTauriHostOptions = {}): NotebookHost {
  const transport = opts.transport ?? new TauriTransport();
  let reconnectInFlight: { promise: Promise<void>; force: boolean } | null = null;
  const startReconnect = (force: boolean): Promise<void> => {
    const promise = invoke<void>("reconnect_to_daemon", { force }).finally(() => {
      if (reconnectInFlight?.promise === promise) {
        reconnectInFlight = null;
      }
    });
    reconnectInFlight = { promise, force };
    return promise;
  };
  const reconnectDaemon = (force = false): Promise<void> => {
    const active = reconnectInFlight;
    if (!active) return startReconnect(force);
    if (!force || active.force) return active.promise;

    const escalated = active.promise.catch(() => undefined).then(() => startReconnect(true));
    reconnectInFlight = { promise: escalated, force: true };
    return escalated;
  };

  // The governor owns every automatic reconnect: `daemon:disconnected`
  // triggers it exactly once per event through the host-level listeners
  // below, so per-subscriber `onDisconnected` callbacks stay
  // notification-only and backoff/latch policy lives in one place.
  const reconnectGovernor = new ReconnectGovernor({
    reconnect: () => reconnectDaemon(true),
  });
  _lastReconnectGovernorDispose?.();
  const unlistenGovernorEvents = [
    listenWebview<void>("daemon:disconnected", () => reconnectGovernor.connectionLost()),
    listenWebview<DaemonReadyPayload>("daemon:ready", () =>
      reconnectGovernor.connectionEstablished(),
    ),
  ];
  _lastReconnectGovernorDispose = () => {
    for (const unlisten of unlistenGovernorEvents) unlisten();
    reconnectGovernor.dispose();
  };

  const daemon: HostDaemon = {
    async isConnected() {
      try {
        return await invoke<boolean>("is_daemon_connected");
      } catch {
        return false;
      }
    },
    async reconnect(options) {
      // Explicit user Retry only: drop any terminal latch and restart the
      // backoff schedule, then dial once. Automatic recovery paths must use
      // `autoReconnect.retryNow()` instead, this reset cancels the
      // governor's pending retry and replaces it with a single dial whose
      // failure schedules nothing.
      reconnectGovernor.reset();
      await reconnectDaemon(options?.force === true);
    },
    async getInfo() {
      return invoke<DaemonInfo | null>("get_daemon_info");
    },
    async getReadyInfo() {
      return invoke<DaemonReadyPayload | null>("get_daemon_ready_info");
    },
    autoReconnect: reconnectGovernor,
  };

  let blobResolver: HostBlobResolver | null = null;

  const blobHost: HostBlobs = {
    async port() {
      return (await blobHost.resolver()).port ?? invoke<number>("get_blob_port");
    },
    async resolver() {
      const port = await invoke<number>("get_blob_port");
      if (blobResolver?.port === port) return blobResolver;
      blobResolver = createHttpBlobResolver(port);
      return blobResolver;
    },
  };

  const trust: HostTrust = {
    async approve(options) {
      const response = (await transport.sendRequest({
        type: "approve_trust",
        ...(options?.observedHeads !== undefined ? { observed_heads: options.observedHeads } : {}),
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
  };

  const deps: HostDeps = {
    async checkTyposquats(packages) {
      return invoke<TyposquatWarning[]>("check_typosquats", { packages });
    },
  };

  const daemonEvents: HostDaemonEvents = {
    onReadyLive: (cb) => listenWebview<DaemonReadyPayload>("daemon:ready", cb),
    // `onReady` subscribes to future emissions AND backfills from the
    // Rust-side cache. Tauri webview events aren't sticky — if the Rust
    // sync task emitted `daemon:ready` before this listener was attached,
    // that specific event is lost. The cache (populated by
    // `setup_sync_receivers` before emit, and refreshed on path changes)
    // lets late subscribers catch up.
    //
    // Both IPCs are queued on the same channel: `webview.listen(...)`
    // issues `invoke("plugin:event|listen", ...)` which Rust processes
    // before the subsequent `get_daemon_ready_info`. By the time the
    // cached value reaches us, the listener is attached, so a live event
    // can't land in a gap and be dropped.
    onReady: (cb) => {
      // Track cancellation across both the live-event subscription and the
      // cache backfill. If the subscriber unmounts before either async
      // operation resolves, neither path invokes the callback on a dead
      // component. React StrictMode's double-mount exercises this path.
      let cancelled = false;
      const unlistenLive = listenWebview<DaemonReadyPayload>("daemon:ready", (p) => {
        if (!cancelled) cb(p);
      });
      invoke<DaemonReadyPayload | null>("get_daemon_ready_info")
        .then((info) => {
          if (!cancelled && info) cb(info);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        unlistenLive();
      };
    },
    onProgress: (cb) => listenWebview<DaemonProgressPayload>("daemon:progress", cb),
    // Notification-only: the reconnect governor's host-level listener owns
    // the automatic redial, so N subscribers never means N reconnect loops.
    onDisconnected: (cb) => listenWebview<void>("daemon:disconnected", () => cb()),
    onUnavailable: (cb) => listenWebview<DaemonUnavailablePayload>("daemon:unavailable", cb),
  };

  const relay: HostRelay = {
    requiresReadyGeneration: true,
    async prepareSync(generation?: number) {
      if (canSubscribeNotebookFrames(transport)) {
        await transport.subscribeNotebookFrames(generation);
      }
    },
    async notifySyncReady(generation?: number) {
      let frameChannelError: unknown;
      if (canSubscribeNotebookFrames(transport)) {
        try {
          await transport.subscribeNotebookFrames(generation);
        } catch (err) {
          frameChannelError = err;
        }
      }
      await invoke("notify_sync_ready", { generation });
      if (frameChannelError) {
        throw frameChannelError;
      }
    },
  };

  const notebook: HostNotebook = {
    async applyPathChanged(path) {
      await invoke("apply_path_changed", { path });
    },
    async getDefaultSaveDirectory() {
      return invoke<string>("get_default_save_directory");
    },
    async saveAs(path) {
      await invoke("save_notebook_as", { path });
    },
    async openInNewWindow(path) {
      await invoke("open_notebook_in_new_window", { path });
    },
    async openHostedInNewWindow(url) {
      await invoke("open_hosted_notebook_in_new_window", { url });
    },
    async cloneToEphemeral() {
      return invoke<string>("clone_notebook_to_ephemeral");
    },
  };

  const windowNs: HostWindow = {
    async getTitle() {
      return getCurrentWindow().title();
    },
    async setTitle(title) {
      await getCurrentWindow().setTitle(title);
    },
    async setTheme(theme) {
      await getCurrentWindow().setTheme(theme);
    },
    onFocusChange(cb) {
      let unlisten: Unlisten | null = null;
      let cancelled = false;
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          cb(focused);
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        if (unlisten) {
          unlisten();
          unlisten = null;
        }
      };
    },
  };

  const system: HostSystem = {
    async getGitInfo() {
      return invoke<GitInfo | null>("get_git_info");
    },
    async getUsername() {
      return invoke<string>("get_username");
    },
    async getFontFamilies() {
      return invoke<string[]>("list_font_families");
    },
  };

  const dialog: HostDialog = {
    async openFile(options) {
      const result = await pluginOpenDialog({
        multiple: false,
        filters: options?.filters,
        defaultPath: options?.defaultPath,
      });
      // `pluginOpenDialog` returns string | null for single-file mode.
      return typeof result === "string" ? result : null;
    },
    async saveFile(options) {
      const result = await pluginSaveDialog({
        filters: options?.filters,
        defaultPath: options?.defaultPath,
      });
      return result ?? null;
    },
  };

  const externalLinks: HostExternalLinks = {
    async open(url) {
      await pluginOpenShell(url);
    },
  };

  const CHECK_INTERVAL_MS = 30 * 60 * 1000;
  const INITIAL_CHECK_DELAY_MS = 5000;

  let updaterState: HostUpdaterState = {
    status: "idle",
    version: null,
    error: null,
  };
  const updaterSubscribers = new Set<() => void>();
  let updaterInitialTimer: ReturnType<typeof setTimeout> | null = null;
  let updaterInterval: ReturnType<typeof setInterval> | null = null;

  const emitUpdaterState = () => {
    for (const cb of updaterSubscribers) cb();
  };

  const setUpdaterState = (next: HostUpdaterState) => {
    updaterState = next;
    emitUpdaterState();
  };

  const checkForUpdate = async (): Promise<HostUpdaterState> => {
    setUpdaterState({ ...updaterState, status: "checking", error: null });
    try {
      // plugin-updater returns an `Update` with install methods, or null when
      // current. Install/relaunch stays behind `begin_upgrade`.
      const update = await pluginCheckUpdate();
      const next: HostUpdaterState = update
        ? { status: "available", version: update.version, error: null }
        : { status: "idle", version: null, error: null };
      setUpdaterState(next);
      return next;
    } catch (e) {
      const next: HostUpdaterState = {
        ...updaterState,
        status: "error",
        error: String(e),
      };
      setUpdaterState(next);
      throw e;
    }
  };

  const stopUpdaterPolling = () => {
    if (updaterInitialTimer !== null) {
      clearTimeout(updaterInitialTimer);
      updaterInitialTimer = null;
    }
    if (updaterInterval !== null) {
      clearInterval(updaterInterval);
      updaterInterval = null;
    }
  };

  const startUpdaterPolling = () => {
    if (updaterInitialTimer !== null || updaterInterval !== null) return;
    updaterInitialTimer = setTimeout(() => {
      updaterInitialTimer = null;
      checkForUpdate().catch(() => {});
    }, INITIAL_CHECK_DELAY_MS);
    updaterInterval = setInterval(() => {
      checkForUpdate().catch(() => {});
    }, CHECK_INTERVAL_MS);
  };

  const updater: HostUpdater = {
    getSnapshot() {
      return updaterState;
    },
    subscribe(cb) {
      updaterSubscribers.add(cb);
      startUpdaterPolling();
      return () => {
        updaterSubscribers.delete(cb);
        if (updaterSubscribers.size === 0) stopUpdaterPolling();
      };
    },
    async check() {
      return checkForUpdate();
    },
    async beginUpgrade() {
      await invoke("begin_upgrade");
    },
  };

  const settings: HostSettings = {
    async openWindow() {
      await invoke("open_settings_window");
    },
    async getSynced() {
      return invoke<HostSyncedSettings>("get_synced_settings");
    },
    async setSynced(key, value) {
      await invoke("set_synced_setting", { key, value });
    },
    async rotateInstallId() {
      return invoke<string>("rotate_install_id");
    },
    onChanged(cb) {
      return listenWebview<HostSyncedSettings>("settings:changed", cb);
    },
  };

  const commands = createCommandRegistry();

  // plugin-log always resolves; fire-and-forget so callers stay sync.
  const log: HostLog = {
    debug(message) {
      pluginDebug(message).catch(() => {});
    },
    info(message) {
      pluginInfo(message).catch(() => {});
    },
    warn(message) {
      pluginWarn(message).catch(() => {});
    },
    error(message) {
      pluginError(message).catch(() => {});
    },
  };
  // NOTE: the old `pluginAttachConsole()` mirror was removed because it
  // created a feedback loop with apps that wrap `console.error` to forward
  // back into plugin-log (our notebook app does this for panic visibility):
  //
  //   frontend error → wrapped console.error → logger.error → pluginError
  //     → Rust log bus → attachConsole listener → console.error (wrapped!)
  //     → logger.error → pluginError → … forever.
  //
  // Apps that want Rust logs in devtools should attach their own
  // `attachLogger(…)` listener at boot that calls the *original* console
  // methods captured before any wrapping. See `apps/notebook/src/main.tsx`.

  const host: NotebookHost = {
    name: "tauri",
    transport,
    daemon,
    daemonEvents,
    relay,
    blobs: blobHost,
    trust,
    deps,
    notebook,
    window: windowNs,
    system,
    dialog,
    externalLinks,
    updater,
    settings,
    commands,
    log,
  };

  // Wire Tauri menu events into the command registry. Stash the disposer
  // on the module so hot-reload / multi-host test teardown can reclaim
  // the listeners. For production single-session lifetime this is
  // unreachable, but dropping the disposer entirely leaks on any future
  // lifecycle change.
  _lastMenuBridgeDispose?.();
  _lastMenuBridgeDispose = wireTauriMenuBridge(host);

  return host;
}

/**
 * Internal: last menu-bridge disposer. If `createTauriHost()` is called
 * more than once (hot reload, tests), we dispose the previous bridge
 * before wiring a new one. Intentionally module-scoped — the host API
 * stays clean until we add a full `host.dispose()` lifecycle.
 */
let _lastMenuBridgeDispose: (() => void) | undefined;

/**
 * Internal: disposer for the previous host's reconnect governor and its
 * host-level daemon lifecycle listeners. Same lifecycle story as the menu
 * bridge above: one live governor per window, reclaimed when a new host is
 * constructed (hot reload, tests).
 */
let _lastReconnectGovernorDispose: (() => void) | undefined;

/** @internal Test helper — forget the most recent menu bridge disposer. */
export function _resetMenuBridgeForTests(): void {
  _lastMenuBridgeDispose?.();
  _lastMenuBridgeDispose = undefined;
  _lastReconnectGovernorDispose?.();
  _lastReconnectGovernorDispose = undefined;
}

export { TauriTransport } from "./transport";
