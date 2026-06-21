import { NotebookHostProvider } from "@nteract/notebook-host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import { setErrorBoundarySink } from "@/lib/error-boundary";
import { setBlobPortHost } from "./lib/blob-port";
import { logger, setLoggerHost } from "./lib/logger";
import { setMetadataTransport } from "./lib/notebook-metadata";
import { setOpenUrlHost } from "./lib/open-url";
import { ensureNotebookWasmReady } from "./lib/runtimed-wasm";
import { createNotebookHost, isTauriRuntime } from "./host/create-notebook-host";

// Register built-in widget components
import "@/components/widgets/controls";
import "@/components/widgets/ipycanvas";

// Preload output components used in main bundle (via MediaRouter).
// Note: markdown-output, html-output, svg-output are isolated-only
// and bundled separately in src/isolated-renderer/ - no need to preload here.
// ansi-output is now a static import in media-router (also pulled in by
// OutputArea), so it's already part of the main bundle.
import("@/components/outputs/image-output");
import("@/components/outputs/json-output");

// Loader for isolated renderer bundle (uses existing Vite virtual module)
const loadRendererBundle = async () => {
  const { rendererCode, rendererCss } = await import("virtual:isolated-renderer");
  return { rendererCode, rendererCss };
};

// Capture original console methods BEFORE wrapping. The Rust-log mirror
// below uses these originals to avoid re-entering the `console.error`
// wrapper (which would immediately feed back into plugin-log → Rust →
// attachLogger → here → plugin-log → …, an infinite loop).
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleInfo = console.info.bind(console);
const originalConsoleDebug = console.debug.bind(console);
const originalConsoleLog = console.log.bind(console);

async function attachTauriDevLogMirror(): Promise<void> {
  if (!isTauriRuntime() || !import.meta.env.DEV) return;

  const { attachLogger, LogLevel } = await import("@tauri-apps/plugin-log");
  // Mirror Rust log entries into devtools during dev so plugin-log output is
  // visible alongside frontend logs. Uses `attachLogger` (not `attachConsole`,
  // which would route through the wrapped `console.error` below and loop) and
  // dispatches to the ORIGINAL console methods. The wrapped forwarder never
  // sees these writes, so no feedback cycle.
  attachLogger(({ level, message }) => {
    switch (level) {
      case LogLevel.Trace:
      case LogLevel.Debug:
        originalConsoleDebug(message);
        break;
      case LogLevel.Info:
        originalConsoleInfo(message);
        break;
      case LogLevel.Warn:
        originalConsoleWarn(message);
        break;
      case LogLevel.Error:
        originalConsoleError(message);
        break;
      default:
        originalConsoleLog(message);
    }
  }).catch(() => {
    // Plugin missing / IPC unavailable — dev mirror is a nice-to-have.
  });
}

async function boot() {
  // Host is constructed once at boot. Every host-platform side effect flows
  // through it (see @nteract/notebook-host types). Tauri and browser/dev hosts
  // provide the same transport surface to SyncEngine and NotebookClient.
  const host = await createNotebookHost();

  // Module-scope helpers that can't reach for useNotebookHost() — hand them
  // the references they need right after the host is constructed.
  setMetadataTransport(host.transport);
  setBlobPortHost(host);
  setLoggerHost(host);
  setOpenUrlHost(host);
  setErrorBoundarySink((error, componentStack) => {
    logger.error(
      "[ErrorBoundary] render error:",
      error,
      "component stack:",
      componentStack ?? "(unavailable)",
    );
  });

  // Forward `console.error` into the host logger so it lands in notebook.log in
  // packaged / CI builds, not just dev devtools. Specifically: WASM panics
  // routed via `console_error_panic_hook` become visible in `e2e-logs/app.log`
  // with file:line:message — without this, they disappear in production.
  // Preserves the original console behavior so devtools stays unchanged.
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    try {
      logger.error(...args);
    } catch {
      // Never let the forwarding path break the original error.
    }
  };

  void attachTauriDevLogMirror();
  try {
    await ensureNotebookWasmReady();
  } catch (error: unknown) {
    logger.warn(
      "[main] failed to initialize runtimed WASM during app boot; rendering app shell without preinitialized notebook WASM",
      error,
    );
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <NotebookHostProvider host={host}>
        <IsolatedRendererProvider loader={loadRendererBundle}>
          <App />
        </IsolatedRendererProvider>
      </NotebookHostProvider>
    </StrictMode>,
  );
}

void boot().catch((err) => {
  originalConsoleError("[main] failed to boot notebook app", err);
  const root = document.getElementById("root");
  if (root) {
    root.textContent = err instanceof Error ? err.message : String(err);
  }
});
