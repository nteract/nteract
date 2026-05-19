/**
 * Isolated Renderer Entry Point
 *
 * This module runs inside an isolated iframe and renders Jupyter outputs
 * using React and the existing output components. It receives render
 * commands from the parent via postMessage and displays them.
 *
 * Security: This code runs in a sandboxed iframe with an opaque origin.
 * It cannot access Tauri APIs, the parent DOM, or localStorage.
 */

import * as React from "react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";

// Import styles (Tailwind + theme variables)
import "./styles.css";

import { JsonRpcTransport } from "@/components/isolated/jsonrpc-transport";
import {
  NTERACT_CLEAR_OUTPUTS,
  NTERACT_DIAGNOSTIC,
  NTERACT_ERROR,
  NTERACT_INSTALL_RENDERER,
  NTERACT_INTERACTION_STATE,
  NTERACT_RENDER_BATCH,
  NTERACT_RENDER_COMPLETE,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
  NTERACT_RESIZE,
  NTERACT_THEME,
  type NteractDiagnosticParams,
  type NteractRenderOutputParams,
} from "@/components/isolated/rpc-methods";
// Import output components directly (not through MediaRouter's lazy loading)
// This ensures all components are bundled inline for the isolated iframe
import { AnsiErrorOutput, AnsiOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
import { AudioOutput } from "@/components/outputs/audio-output";
import { HtmlOutput } from "@/components/outputs/html-output";
import { ImageOutput } from "@/components/outputs/image-output";
import { JavaScriptOutput } from "@/components/outputs/javascript-output";
import { JsonOutput } from "@/components/outputs/json-output";
import { PdfOutput } from "@/components/outputs/pdf-output";
import { TracebackOutput } from "@/components/outputs/traceback-output";
import { VideoOutput } from "@/components/outputs/video-output";
import { SvgOutput } from "@/components/outputs/svg-output";
import { WidgetView } from "@/components/widgets/widget-view";
import { measureDocumentHeight } from "./layout-measure";
// Import widget support
import { IframeWidgetStoreProvider } from "./widget-provider";

// Import widget controls to register them in the widget registry
// This import has side effects that register all built-in widgets
import "@/components/widgets/controls";

// --- Renderer Plugin Registry ---
//
// On-demand renderer plugins register React components for specific MIME types.
// Plugins are CJS modules loaded via installRendererPlugin(). The custom
// require shim provides the shared React instance so hooks work correctly.
//
// The registry lives in @/lib/renderer-registry so that both OutputRenderer
// and MediaRouter (used by output widgets) can look up installed renderers.

import type { ComponentType } from "react";
import {
  type RendererProps,
  getRenderer,
  registerRenderer,
  registerRendererPattern,
} from "@/lib/renderer-registry";

/**
 * Load and install a renderer plugin.
 *
 * The plugin is a CJS module that exports an `install(ctx)` function.
 * We provide a custom `require` that maps "react" and "react/jsx-runtime"
 * to the already-loaded instances — no globals, just dependency injection.
 */
function installRendererPlugin(code: string, css?: string) {
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const customRequire = (name: string) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    throw new Error(`[renderer-plugin] Unknown module: ${name}`);
  };

  // eslint-disable-next-line no-new-func -- CJS loader pattern
  new Function("module", "exports", "require", code)(mod, mod.exports, customRequire);

  const install = mod.exports.install as
    | ((ctx: {
        register: (mimeTypes: string[], component: ComponentType<RendererProps>) => void;
        registerPattern: (
          test: (mime: string) => boolean,
          component: ComponentType<RendererProps>,
        ) => void;
      }) => void)
    | undefined;

  if (typeof install !== "function") {
    console.error("[renderer-plugin] Plugin does not export an install() function");
    return;
  }

  install({
    register: registerRenderer,
    registerPattern: registerRendererPattern,
  });

  if (css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
}

// --- Types ---

interface OutputEntry {
  id: string;
  payload: NteractRenderOutputParams;
}

interface RendererState {
  outputs: OutputEntry[];
  isDark: boolean;
  interactionActive: boolean;
}

// --- Theme Management ---

/**
 * Update the document theme so components can detect it via isDarkMode().
 * Sets class and data-theme on documentElement (html tag).
 */
function updateDocumentTheme(isDark: boolean, colorTheme?: string | null) {
  const root = document.documentElement;

  // Set class for Tailwind dark: variant detection
  if (isDark) {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
  }

  // Set data-theme for components that check this attribute
  root.setAttribute("data-theme", isDark ? "dark" : "light");

  // Set color theme for sift and other themed plugins
  if (colorTheme) {
    root.setAttribute("data-color-theme", colorTheme);
  } else if (colorTheme === null || colorTheme === "") {
    root.removeAttribute("data-color-theme");
  }

  // Set color-scheme to influence prefers-color-scheme media queries
  // Some widgets (like drawdata) use @media (prefers-color-scheme: dark)
  root.style.colorScheme = isDark ? "dark" : "light";

  // Update CSS variables for base styles (background kept transparent for cell focus colors to show through)
  const isCream = root.getAttribute("data-color-theme") === "cream";
  // Set --sift-bg to the notebook's background so the table container is
  // opaque (prevents focused-cell highlight from bleeding through the iframe).
  // Leave --sift-panel to sift's theme CSS — it needs to be brighter than
  // --sift-bg so rows have visible contrast.
  root.style.setProperty(
    "--sift-bg",
    isCream ? (isDark ? "#1a1816" : "#f5f2ec") : isDark ? "#0d1117" : "#ffffff",
  );
  if (isCream) {
    root.style.setProperty("--bg-primary", "transparent");
    root.style.setProperty("--bg-secondary", isDark ? "#242120" : "#f0ede7");
    root.style.setProperty("--text-primary", isDark ? "#e8e2dc" : "#1e1a18");
    root.style.setProperty("--text-secondary", isDark ? "#9a918a" : "#6e655f");
    root.style.setProperty("--foreground", isDark ? "#e8e2dc" : "#1e1a18");
  } else if (isDark) {
    root.style.setProperty("--bg-primary", "#0a0a0a");
    root.style.setProperty("--bg-secondary", "#1a1a1a");
    root.style.setProperty("--text-primary", "#e0e0e0");
    root.style.setProperty("--text-secondary", "#a0a0a0");
    root.style.setProperty("--foreground", "#e0e0e0");
  } else {
    root.style.setProperty("--bg-primary", "#ffffff");
    root.style.setProperty("--bg-secondary", "#f5f5f5");
    root.style.setProperty("--text-primary", "#1a1a1a");
    root.style.setProperty("--text-secondary", "#666666");
    root.style.setProperty("--foreground", "#1a1a1a");
  }
}

// --- Message Handling ---

// Global transport for JSON-RPC communication with host
let rpcTransport: JsonRpcTransport | null = null;

/** Get the shared transport instance (available after init()) */
export function getTransport(): JsonRpcTransport | null {
  return rpcTransport;
}

type MessageHandler = (type: string, payload: unknown) => void;

let messageHandler: MessageHandler | null = null;

const LAYOUT_PULSE_DELAYS_MS = [0, 160, 600];
let layoutPulseTimers: number[] = [];

function diagnosticDetailsForOutputs(outputs: OutputEntry[]): Record<string, unknown> {
  return {
    count: outputs.length,
    mimes: outputs.map((entry) => entry.payload.mimeType),
    outputIds: outputs.map((entry) => entry.payload.outputId ?? entry.id),
  };
}

function sendDiagnostic(
  level: NteractDiagnosticParams["level"],
  event: string,
  details?: Record<string, unknown>,
): void {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : level;
  console[method]("[isolated-renderer]", event, details ?? {});
  rpcTransport?.notify(NTERACT_DIAGNOSTIC, {
    source: "renderer",
    level,
    event,
    details,
  } satisfies NteractDiagnosticParams);
}

function postMeasuredHeight(method: typeof NTERACT_RESIZE | typeof NTERACT_RENDER_COMPLETE): void {
  rpcTransport?.notify(method, { height: measureDocumentHeight() });
}

function rootSnapshot(): Record<string, unknown> {
  const rootEl = document.getElementById("root");
  return {
    height: measureDocumentHeight(),
    bodyTextLength: document.body?.innerText?.length ?? 0,
    bodyChildCount: document.body?.childElementCount ?? 0,
    rootChildCount: rootEl?.childElementCount ?? 0,
    rootHtmlLength: rootEl?.innerHTML.length ?? 0,
  };
}

function reportRenderPaint(outputs: OutputEntry[], reason: "render" | "renderBatch" | "clear") {
  const height = measureDocumentHeight();
  rpcTransport?.notify(NTERACT_RENDER_COMPLETE, { height });

  if (outputs.length === 0 || height > 1) return;

  window.setTimeout(() => {
    const snapshot = rootSnapshot();
    if (typeof snapshot.height === "number" && snapshot.height > 1) return;
    sendDiagnostic("warn", "rendered-empty-after-paint", {
      reason,
      ...diagnosticDetailsForOutputs(outputs),
      ...snapshot,
    });
  }, 300);
}

function pulseRendererLayout(): void {
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  document.dispatchEvent(new Event("scroll"));
  document.body?.dispatchEvent(new Event("scroll"));
  postMeasuredHeight(NTERACT_RESIZE);
}

function scheduleRendererLayoutPulses(): void {
  for (const timer of layoutPulseTimers) {
    window.clearTimeout(timer);
  }
  layoutPulseTimers = [];
  for (const delay of LAYOUT_PULSE_DELAYS_MS) {
    const timer = window.setTimeout(() => {
      requestAnimationFrame(pulseRendererLayout);
    }, delay);
    layoutPulseTimers.push(timer);
  }
}

function setupMessageListener() {
  // Create JSON-RPC transport — handles nteract/* methods from the host
  rpcTransport = new JsonRpcTransport(window.parent, window.parent);

  // Route JSON-RPC notifications to the React message handler
  rpcTransport.onNotification(NTERACT_RENDER_OUTPUT, (params) => {
    const renderPayload = params as NteractRenderOutputParams;
    sendDiagnostic("debug", "render-output-received", {
      mimeType: renderPayload.mimeType,
      outputId: renderPayload.outputId,
      cellId: renderPayload.cellId,
      outputIndex: renderPayload.outputIndex,
    });
    messageHandler?.("render", params);
  });
  rpcTransport.onNotification(NTERACT_RENDER_BATCH, (params) => {
    const batch = params as { outputs?: NteractRenderOutputParams[] };
    sendDiagnostic("debug", "render-batch-received", {
      count: batch.outputs?.length ?? 0,
      mimes: batch.outputs?.map((output) => output.mimeType) ?? [],
      outputIds: batch.outputs?.map((output) => output.outputId ?? null) ?? [],
    });
    messageHandler?.("renderBatch", params);
  });
  rpcTransport.onNotification(NTERACT_CLEAR_OUTPUTS, () => {
    messageHandler?.("clear", undefined);
  });
  rpcTransport.onNotification(NTERACT_THEME, (params) => {
    messageHandler?.("theme", params);
  });
  rpcTransport.onNotification(NTERACT_INTERACTION_STATE, (params) => {
    messageHandler?.("interaction_state", params);
  });
  rpcTransport.onNotification(NTERACT_INSTALL_RENDERER, (params) => {
    const { code, css } = params as { code: string; css?: string };
    try {
      installRendererPlugin(code, css);
      sendDiagnostic("info", "renderer-plugin-installed", {
        codeBytes: code.length,
        hasCss: Boolean(css),
        cssBytes: css?.length ?? 0,
      });
    } catch (err) {
      console.error("[renderer-plugin] install failed:", err);
      sendDiagnostic("error", "renderer-plugin-install-failed", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  });
  rpcTransport.start();
  sendDiagnostic("info", "transport-started");
}

// --- React App ---

function IsolatedRendererApp() {
  const [state, setState] = useState<RendererState>({
    outputs: [],
    isDark: document.documentElement.classList.contains("dark"),
    interactionActive: false,
  });

  // Handle messages from parent
  const handleMessage = useCallback((type: string, payload: unknown) => {
    switch (type) {
      case "render": {
        const renderPayload = payload as NteractRenderOutputParams;

        // Prefer the daemon-stamped output_id when available — it is stable
        // across display_update, stream appends, and cell reorders, so
        // React reconciliation won't re-mount sibling outputs. Fall back
        // to cellId+outputIndex for render paths that don't carry one
        // (e.g. the markdown cell renders a single payload with no id).
        const id = renderPayload.outputId
          ? renderPayload.outputId
          : renderPayload.cellId
            ? `${renderPayload.cellId}-${renderPayload.outputIndex ?? 0}`
            : `output-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        setState((prev) => {
          if (renderPayload.replace) {
            // Replace all outputs with this single new output
            return { ...prev, outputs: [{ id, payload: renderPayload }] };
          }
          // Default: append to existing outputs
          return {
            ...prev,
            outputs: [...prev.outputs, { id, payload: renderPayload }],
          };
        });

        // Notify parent of render completion after next paint
        requestAnimationFrame(() => {
          reportRenderPaint([{ id, payload: renderPayload }], "render");
        });
        scheduleRendererLayoutPulses();
        break;
      }

      case "renderBatch": {
        const batchPayload = payload as { outputs: NteractRenderOutputParams[] };
        const entries: OutputEntry[] = (batchPayload.outputs ?? []).map((p, i) => ({
          // Prefer daemon-stamped output_id (stable across stream append /
          // display_update / reorder). Fall back to positional key only for
          // payloads without an id.
          id: p.outputId
            ? p.outputId
            : p.cellId
              ? `${p.cellId}-${p.outputIndex ?? i}`
              : `output-${i}`,
          payload: p,
        }));
        setState((prev) => ({ ...prev, outputs: entries }));

        requestAnimationFrame(() => {
          reportRenderPaint(entries, "renderBatch");
        });
        scheduleRendererLayoutPulses();
        break;
      }

      case "clear":
        setState((prev) => ({ ...prev, outputs: [] }));
        requestAnimationFrame(() => {
          reportRenderPaint([], "clear");
        });
        scheduleRendererLayoutPulses();
        break;

      case "theme": {
        const themePayload = payload as { isDark?: boolean; colorTheme?: string | null };
        if (themePayload?.isDark !== undefined || themePayload?.colorTheme !== undefined) {
          setState((prev) => ({
            ...prev,
            isDark: themePayload.isDark ?? prev.isDark,
          }));
          updateDocumentTheme(themePayload.isDark ?? state.isDark, themePayload.colorTheme);
        }
        break;
      }
      case "interaction_state": {
        const interactionPayload = payload as { active?: boolean };
        setState((prev) => ({
          ...prev,
          interactionActive: interactionPayload.active ?? false,
        }));
        break;
      }
    }
  }, []);

  // Register message handler and notify parent when ready
  useEffect(() => {
    messageHandler = handleMessage;

    // Notify parent that renderer is ready via JSON-RPC
    rpcTransport?.notify(NTERACT_RENDERER_READY, {});

    return () => {
      messageHandler = null;
    };
  }, [handleMessage]);

  return (
    <div className="isolated-renderer" data-theme={state.isDark ? "dark" : "light"}>
      {state.outputs.map((entry) => (
        <OutputRenderer
          key={entry.id}
          payload={entry.payload}
          interactionActive={state.interactionActive}
        />
      ))}
    </div>
  );
}

/**
 * Render a single output based on its MIME type.
 * Uses direct component imports (not lazy loading) for isolated iframe compatibility.
 */
function OutputRenderer({
  payload,
  interactionActive,
}: {
  payload: NteractRenderOutputParams;
  interactionActive: boolean;
}) {
  const { mimeType, data, metadata } = payload;
  const content = data;

  // Handle stream output (plain text with potential ANSI)
  if (mimeType === "text/plain" && metadata?.streamName) {
    return (
      <AnsiStreamOutput
        text={String(data)}
        streamName={metadata.streamName as "stdout" | "stderr"}
      />
    );
  }

  // Rich traceback MIME — take precedence over the text/plain error
  // fallback so cells that mix rich outputs with errors (e.g., display
  // HTML then raise) still get the rich render inside the iframe.
  if (mimeType === "application/vnd.nteract.traceback+json") {
    return <TracebackOutput data={data} />;
  }

  // Handle error output (classic ANSI path — fallback when no rich
  // sibling was available to promote above).
  if (mimeType === "text/plain" && metadata?.isError) {
    return (
      <AnsiErrorOutput
        ename={String(metadata.ename || "Error")}
        evalue={String(metadata.evalue || "")}
        traceback={
          Array.isArray(metadata.traceback) ? metadata.traceback.map(String) : [String(data)]
        }
      />
    );
  }

  // Route to appropriate component based on MIME type
  // (Direct rendering without MediaRouter's lazy loading)

  // Check renderer plugin registry first (exact match, then pattern matchers)
  const RegisteredRenderer = getRenderer(mimeType);
  if (RegisteredRenderer) {
    return (
      <RegisteredRenderer
        data={data}
        metadata={metadata}
        mimeType={mimeType}
        interactionActive={interactionActive}
      />
    );
  }

  // Widget view - render interactive Jupyter widget
  if (mimeType === "application/vnd.jupyter.widget-view+json") {
    const widgetData = data as { model_id: string };
    return <WidgetView modelId={widgetData.model_id} />;
  }

  // HTML
  if (mimeType === "text/html") {
    return <HtmlOutput content={String(content)} />;
  }

  // SVG
  if (mimeType === "image/svg+xml") {
    return <SvgOutput data={String(content)} />;
  }

  // Images (PNG, JPEG, GIF, WebP, BMP, etc.)
  if (mimeType.startsWith("image/")) {
    return (
      <ImageOutput
        data={String(content)}
        mediaType={mimeType}
        width={metadata?.width as number | undefined}
        height={metadata?.height as number | undefined}
      />
    );
  }

  // Audio
  if (mimeType.startsWith("audio/")) {
    return <AudioOutput data={String(content)} mediaType={mimeType} />;
  }

  // Video
  if (mimeType.startsWith("video/")) {
    return (
      <VideoOutput
        data={String(content)}
        mediaType={mimeType}
        width={metadata?.width as number | undefined}
        height={metadata?.height as number | undefined}
      />
    );
  }

  // PDF
  if (mimeType === "application/pdf") {
    return <PdfOutput data={String(content)} />;
  }

  // JavaScript
  if (mimeType === "application/javascript") {
    return <JavaScriptOutput code={String(content)} />;
  }

  // JSON
  if (mimeType === "application/json") {
    const jsonData = typeof content === "string" ? JSON.parse(content) : content;
    return <JsonOutput data={jsonData} />;
  }

  // Plain text / ANSI
  if (mimeType === "text/plain") {
    return <AnsiOutput>{String(content)}</AnsiOutput>;
  }

  // Fallback: render as plain text
  return (
    <pre style={{ whiteSpace: "pre-wrap", wordWrap: "break-word" }}>
      {typeof content === "string" ? content : JSON.stringify(content, null, 2)}
    </pre>
  );
}

// --- Bootstrap ---

let root: Root | null = null;

/**
 * Initialize the renderer. Called when the bundle is eval'd in the iframe.
 */
// Declare the global flag type for TypeScript
declare global {
  interface Window {
    __REACT_RENDERER_ACTIVE__?: boolean;
  }
}

export function init() {
  // Signal to the inline handler that React is taking over
  // This prevents the inline handler from processing render/theme/clear messages
  window.__REACT_RENDERER_ACTIVE__ = true;

  // Set up message listener
  setupMessageListener();
  sendDiagnostic("info", "init-started", {
    hasExistingRoot: Boolean(document.getElementById("root")),
  });

  // Theme is controlled by the parent's nteract/theme notification.
  // Don't set a default here to avoid flash when parent sends different theme

  // Create root element if needed
  let rootEl = document.getElementById("root");
  if (!rootEl) {
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
  }

  // Create React root and render with widget provider
  root = createRoot(rootEl);
  root.render(
    <StrictMode>
      <IframeWidgetStoreProvider>
        <IsolatedRendererApp />
      </IframeWidgetStoreProvider>
    </StrictMode>,
  );

  // Set up resize observer
  // Use rAF to collapse multiple resize callbacks per frame into one
  // postMessage (avoids "ResizeObserver loop completed with undelivered
  // notifications" errors when many iframes resize simultaneously).
  let resizeRafPending = false;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeRafPending) return;
    resizeRafPending = true;
    requestAnimationFrame(() => {
      resizeRafPending = false;
      postMeasuredHeight(NTERACT_RESIZE);
    });
  });
  resizeObserver.observe(document.body);
  resizeObserver.observe(rootEl);

  document.addEventListener("fullscreenchange", scheduleRendererLayoutPulses);
  document.addEventListener("webkitfullscreenchange", scheduleRendererLayoutPulses);

  window.addEventListener("error", (event) => {
    sendDiagnostic("error", "window-error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    sendDiagnostic("error", "unhandled-rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // Note: "renderer_ready" is sent from the React component's useEffect
  // to ensure the message handler is registered before parent sends messages
}

// Auto-init if this is the main module being eval'd
// The parent will send us via eval, so we auto-start
if (typeof window !== "undefined") {
  try {
    init();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[IsolatedRenderer] init() failed:", error);
    // Report error back to parent
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        method: NTERACT_ERROR,
        params: {
          message: `Renderer init failed: ${error.message}`,
          stack: error.stack,
        },
      },
      "*",
    );
  }
}
