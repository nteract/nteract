/**
 * Host-platform abstraction for the notebook frontend.
 *
 * `NotebookHost` is the single surface the notebook UI uses for every
 * side-effecting call that depends on where it's running — reading the
 * daemon connection, opening files, showing dialogs, listening for
 * window events, etc. In the Tauri desktop app the implementation
 * routes through `@tauri-apps/api` + plugins; in the (coming) Electron
 * host it routes through `window.electronHost` exposed by the preload
 * contextBridge; in the future a WASM-only / browser-served host could
 * implement a subset of this API and no-op the rest.
 *
 * The notebook frontend itself should never import `@tauri-apps/*`
 * directly. Every call site goes through `useNotebookHost()` or a
 * non-React helper that takes a host instance. That constraint is what
 * lets us re-host the frontend cleanly.
 *
 * ## Design notes
 *
 * - Methods return promises even when the underlying implementation is
 *   synchronous, because some hosts (notably Electron's renderer
 *   talking to main) are async and we want one signature everywhere.
 * - Event methods take a callback and return an `unlisten` function.
 *   This matches Tauri's `webview.listen()` shape.
 * - For PR 1 / PR 2 / PR 3 the interface commits to "Tauri and Electron
 *   both implement every namespace end-to-end." If a future browser or
 *   viewer host needs partial implementations, we'll introduce explicit
 *   capability flags or mark individual namespaces optional at that
 *   point — not pre-optional now, to keep the contract honest.
 */

import type { BlobRef, BlobResolver, NotebookTransport } from "runtimed";
import type { CommandRegistry } from "./commands";

// ── Shared types ─────────────────────────────────────────────────────────

export interface GitInfo {
  branch: string;
  commit: string;
  description: string | null;
}

export interface DaemonInfo {
  version: string;
  socket_path: string;
  is_dev_mode: boolean;
}

export interface TrustInfo {
  status: "trusted" | "untrusted" | "no_dependencies";
  uv_dependencies: string[];
  approved_uv_dependencies: string[];
  conda_dependencies: string[];
  approved_conda_dependencies: string[];
  conda_channels: string[];
  approved_conda_channels: string[];
  pixi_dependencies: string[];
  approved_pixi_dependencies: string[];
  pixi_pypi_dependencies: string[];
  approved_pixi_pypi_dependencies: string[];
  pixi_channels: string[];
  approved_pixi_channels: string[];
}

export interface TyposquatWarning {
  package: string;
  similar_to: string;
  distance: number;
}

export interface DaemonReadyPayload {
  notebook_id?: string;
  /**
   * Tauri relay bootstrap epoch used to acknowledge the matching frontend
   * WASM reset. This is transport bookkeeping, not an Automerge sync counter.
   */
  relay_generation?: number;
  cell_count?: number;
  needs_trust_approval?: boolean;
  /** In-memory-only notebook (no on-disk path). Drives the always-dirty asterisk. */
  ephemeral?: boolean;
  /** On-disk path if the notebook is file-backed. Derives the titlebar filename. */
  notebook_path?: string | null;
  runtime?: string;
  /** Authenticated actor label to use for Automerge writes on this connection. */
  actor_label?: string;
  /** Server-enforced connection scope for this room connection. */
  connection_scope?: string;
  /** Daemon-authoritative CommentsDoc identity for this room. */
  comments_doc_id?: string | null;
  /** Daemon-authoritative notebook reference stored inside the CommentsDoc. */
  comments_notebook_ref?: CommentsNotebookRef | null;
}

export type CommentsNotebookRef =
  | { kind: "hosted_room"; room_locator: string }
  | { kind: "local_path"; canonical_path: string }
  | { kind: "local_room"; room_id: string };

export interface DaemonProgressPayload {
  status: "checking" | "ready" | "failed" | string;
  error?: string;
  [key: string]: unknown;
}

export interface DaemonUnavailablePayload {
  reason: string;
  message: string;
  guidance: string;
}

export type Unlisten = () => void;

// ── Namespaces ───────────────────────────────────────────────────────────

/** Daemon connection state + diagnostics. */
export interface HostDaemon {
  /** Fast synchronous-ish check; returns false when the daemon socket is down. */
  isConnected(): Promise<boolean>;
  /** Forces a reconnect; resolves when the relay task has a fresh socket. */
  reconnect(): Promise<void>;
  /** Daemon diagnostics for banners / debug UI. */
  getInfo(): Promise<DaemonInfo | null>;
  /**
   * Pull the most-recent `daemon:ready` payload for this window, or null if
   * one hasn't landed yet. Used by late-mounted consumers to backfill state
   * that was emitted before any JS listener was attached — Tauri webview
   * events aren't sticky, so the event-based path can miss the first fire.
   */
  getReadyInfo(): Promise<DaemonReadyPayload | null>;
}

export type HostBlobRef = BlobRef;
export type HostBlobResolver = BlobResolver;

/** Blob store — host-owned access to daemon blob content. */
export interface HostBlobs {
  /** Current blob server port. Implementations handle their own retry/caching. */
  port(): Promise<number>;

  /** Current blob resolver. Implementations handle their own retry/caching. */
  resolver(): Promise<HostBlobResolver>;
}

/**
 * Notebook trust approval.
 *
 * Trust *status* is read from `RuntimeStateDoc.trust` via
 * `useRuntimeState()`; the daemon is the sole writer. This namespace
 * exists only for the explicit user action: asking the daemon to sign
 * current dependency metadata and apply the CRDT mutation.
 */
export interface HostTrust {
  approve(options?: { observedHeads?: string[] }): Promise<void>;
}

/**
 * Dependency-validation surface.
 *
 * This namespace will grow as we migrate dep-edit flows
 * (useDependencies, useCondaDependencies, usePixiDetection,
 * useDenoConfig) off direct `invoke(...)`. `checkTyposquats`
 * lives here and not in `HostTrust` because it validates package
 * names, not notebook attestation.
 */
export interface HostDeps {
  checkTyposquats(packages: string[]): Promise<TyposquatWarning[]>;
}

/**
 * Subscribe-only daemon lifecycle events. These historically came
 * through `webview.listen(...)`. Return an `Unlisten` from each
 * subscription; outgoing signals belong on `HostRelay`, not here.
 */
export interface HostDaemonEvents {
  /** Subscribe only to future daemon-ready events. */
  onReadyLive(cb: (payload: DaemonReadyPayload) => void): Unlisten;
  /** Subscribe to future daemon-ready events and backfill the latest cached payload. */
  onReady(cb: (payload: DaemonReadyPayload) => void): Unlisten;
  onProgress(cb: (payload: DaemonProgressPayload) => void): Unlisten;
  onDisconnected(cb: () => void): Unlisten;
  onUnavailable(cb: (payload: DaemonUnavailablePayload) => void): Unlisten;
}

/**
 * Outbound signals the frontend sends up to the host for sync
 * bookkeeping. Separate from `HostDaemonEvents` because these are
 * commands, not subscriptions.
 */
export interface HostRelay {
  /**
   * Whether `notifySyncReady` must carry the daemon's current relay generation.
   *
   * Tauri buffers frames behind a generation-specific gate so a stale webview
   * cannot release frames for a newer daemon session. The browser dev relay has
   * only a per-WebSocket local queue; its ready payload has no generation and
   * the ack simply releases frames after the frontend bootstrap path is wired.
   */
  readonly requiresReadyGeneration: boolean;

  /**
   * Attach the host frame listener for the current relay generation before
   * the frontend sends its bootstrap sync frame. Hosts that do not buffer
   * frames can omit this.
   */
  prepareSync?(generation?: number): Promise<void>;

  /**
   * Signal that the JS frame listener is attached and the Tauri-side
   * relay may replay any buffered frames. Matches the existing
   * `notify_sync_ready` Tauri command. No-op in hosts where the main
   * process doesn't buffer (e.g., a browser-served host).
   */
  notifySyncReady(generation?: number): Promise<void>;
}

/**
 * Notebook-scoped state transitions the UI announces to the host.
 *
 * `applyPathChanged` is the only survivor of this contract. The frontend
 * reads `RuntimeStateDoc.path` (frame `0x05`) and forwards it here so the
 * Tauri-side `WindowNotebookRegistry` (which the window title setter reads
 * from) stays in sync. The previous `markClean` companion is gone — the
 * dirty concept lives only as Tauri-side bookkeeping for the
 * list-notebooks / save-all-on-quit flow now and will be cleaned up in a
 * follow-up.
 */
export interface HostNotebook {
  /** Daemon's path for this room changed (save / save-as); flushed to window state. */
  applyPathChanged(path: string): Promise<void>;
  /** Default directory for untitled notebook save-as flows. */
  getDefaultSaveDirectory(): Promise<string>;
  /** Save the current notebook to a specific path and run host-side save-as bookkeeping. */
  saveAs(path: string): Promise<void>;
  /** Open an existing notebook path in a new host window. */
  openInNewWindow(path: string): Promise<void>;
  /** Fork the current notebook into a new in-memory room and open it in a new host window. */
  cloneToEphemeral(): Promise<string>;
}

/**
 * OS window chrome. Read/write the title (for the dirty asterisk) and
 * subscribe to focus changes (for keyboard-input-context restoration on
 * WKWebView reactivation).
 *
 * `onFocusChange` is the host-level / OS-attributed focus signal. The
 * frontend also listens to the DOM-level `window.addEventListener("focus")`
 * for a fast path; these are belt-and-suspenders layers.
 */
export interface HostWindow {
  getTitle(): Promise<string>;
  setTitle(title: string): Promise<void>;
  /** Set native window theme when the host supports it. `null` follows the OS. */
  setTheme(theme: HostNativeTheme): Promise<void>;
  onFocusChange(cb: (focused: boolean) => void): Unlisten;
}

/** Non-specific system metadata. */
export interface HostSystem {
  getGitInfo(): Promise<GitInfo | null>;
  getUsername(): Promise<string>;
}

/** File picker. Returned paths are platform-native strings, or null if cancelled. */
export interface HostDialog {
  /** Open an existing file; returns the selected path or null on cancel. */
  openFile(options?: HostDialogOpenOptions): Promise<string | null>;
  /** Open a save-as dialog; returns the chosen path or null on cancel. */
  saveFile(options?: HostDialogSaveOptions): Promise<string | null>;
}

/** Filter for file pickers. Matches Tauri's shape for drop-in compatibility. */
export interface HostDialogFilter {
  name: string;
  extensions: string[];
}

export interface HostDialogOpenOptions {
  filters?: HostDialogFilter[];
  defaultPath?: string;
  multiple?: false;
}

export interface HostDialogSaveOptions {
  filters?: HostDialogFilter[];
  defaultPath?: string;
}

/**
 * Open a URL in the user's default browser or handler app.
 *
 * Named "externalLinks" (not "shell") on purpose — the Tauri `plugin-shell`
 * exposes a generic shell-command surface that we deliberately don't want
 * to advertise through the host interface. URL-opening is the only subset
 * the notebook frontend uses.
 */
export interface HostExternalLinks {
  open(url: string): Promise<void>;
}

/**
 * Auto-update information for the host app itself.
 *
 * Update policy is host-specific: Tauri polls the native updater, Electron can
 * use its own updater semantics, and a web host can expose "reload available"
 * state. The notebook frontend subscribes to host-owned state and asks for
 * explicit checks; it does not own background polling.
 */
export interface HostUpdater {
  /** Current update state, suitable for `useSyncExternalStore`. */
  getSnapshot(): HostUpdaterState;
  /** Subscribe to update state changes. */
  subscribe(cb: () => void): Unlisten;
  /** Trigger an immediate host-owned update check. */
  check(): Promise<HostUpdaterState>;
  /** Begin the host-owned upgrade flow. */
  beginUpgrade(): Promise<void>;
}

export interface HostUpdateInfo {
  version: string;
}

export type HostUpdateStatus = "idle" | "checking" | "available" | "error";

export interface HostUpdaterState {
  status: HostUpdateStatus;
  version: string | null;
  error: string | null;
}

/**
 * Structured-log pipe shared across the frontend. Keeps shared UI code from
 * coupling directly to host-specific sinks such as `@tauri-apps/plugin-log`.
 *
 * Messages arrive pre-formatted (single string); callers serialize their
 * arguments in a way that matters to them. The Tauri impl forwards each
 * level to plugin-log; an Electron impl can pipe to the main process log
 * file; a browser impl can use `console.*` or a remote sink.
 */
export interface HostLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type HostNativeTheme = "light" | "dark" | null;

/**
 * Structural snapshot of host-owned synced settings.
 *
 * The canonical Rust schema is exported into `src/bindings`. The host package
 * intentionally keeps a structural shape so it does not import app-level
 * generated bindings back into the host boundary.
 */
export interface HostSyncedSettings {
  theme?: unknown;
  color_theme?: unknown;
  default_runtime?: unknown;
  default_python_env?: unknown;
  uv?: { default_packages?: unknown };
  conda?: { default_packages?: unknown };
  pixi?: { default_packages?: unknown };
  keep_alive_secs?: unknown;
  install_default_data_packages?: unknown;
  disable_nteract_launcher?: unknown;
  enable_comments?: unknown;
  disable_auto_format?: unknown;
  redact_env_values_in_outputs?: unknown;
  import_shell_environment?: unknown;
  install_id?: unknown;
  telemetry_enabled?: unknown;
  telemetry_consent_recorded?: unknown;
  telemetry_last_daemon_ping_at?: unknown;
  telemetry_last_app_ping_at?: unknown;
  telemetry_last_mcp_ping_at?: unknown;
  [key: string]: unknown;
}

/** Host-owned settings window and synced-settings IPC. */
export interface HostSettings {
  openWindow(): Promise<void>;
  getSynced(): Promise<HostSyncedSettings>;
  setSynced(key: string, value: unknown): Promise<void>;
  rotateInstallId(): Promise<string>;
  onChanged(cb: (settings: HostSyncedSettings) => void): Unlisten;
}

// ── Host ──────────────────────────────────────────────────────────────────

/**
 * The top-level interface every host implementation provides.
 *
 * Transport is not optional: the notebook frontend can't run without it.
 * Everything else is grouped by concern so future PRs can add a namespace
 * without expanding the root surface.
 */
export interface NotebookHost {
  readonly name: "tauri" | "electron" | "browser" | (string & {});
  readonly transport: NotebookTransport;
  readonly daemon: HostDaemon;
  readonly daemonEvents: HostDaemonEvents;
  readonly relay: HostRelay;
  readonly blobs: HostBlobs;
  readonly trust: HostTrust;
  readonly deps: HostDeps;
  readonly notebook: HostNotebook;
  readonly window: HostWindow;
  readonly system: HostSystem;
  readonly dialog: HostDialog;
  readonly externalLinks: HostExternalLinks;
  readonly updater: HostUpdater;
  readonly settings: HostSettings;
  /**
   * Typed action bus shared between host UI surfaces (menus, keyboard,
   * future palette) and the app. Host-side wiring calls `run(id, payload)`;
   * the app registers handlers via `register(id, fn)`. See `./commands.ts`
   * for the command map.
   */
  readonly commands: CommandRegistry;
  /**
   * Structured logging pipe. Tauri routes through plugin-log so entries
   * appear in notebook.log alongside Rust-side log::* entries; other hosts
   * pick their own sink.
   */
  readonly log: HostLog;
  // Future namespaces (add in dedicated PRs):
  //   env:        HostEnv         (detect_pyproject, detect_pixi_toml, …)
  //   deps (ext): dependency *edit* APIs — this PR only has validation
  //   dialog:     HostDialog      (plugin-dialog: open/save file pickers)
  //   externalLinks: HostExternalLinks (plugin-shell.open — opening URLs,
  //                                     NOT a shell surface)
  //   updater?:   HostUpdater     (optional; not all hosts auto-update)
  //   window:     HostWindow      (onFocus, setTitle, …)
  //   log:        HostLog         (plugin-log pipe — host.log.debug/info/…)
}
