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
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";

// Import styles (Tailwind + theme variables)
import "./styles.css";

import type { RenderPayload } from "@/components/isolated/frame-bridge";
import {
  logIsolatedDiagnostic,
  type IsolatedDiagnosticLevel,
} from "@/components/isolated/diagnostics";
import type {
  NteractEmbedHostContext,
  NteractEmbedHostContextPatch,
} from "@/components/isolated/host-context";
import { mergeNteractEmbedHostContext } from "@/components/isolated/host-context";
import { JsonRpcTransport } from "@/components/isolated/jsonrpc-transport";
import {
  MCP_NOTIFICATIONS_MESSAGE,
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  MCP_UI_SIZE_CHANGED,
  NTERACT_CLEAR_OUTPUTS,
  NTERACT_DIAGNOSTIC,
  NTERACT_INSTALL_RENDERER,
  NTERACT_MEASURE_ELEMENT,
  NTERACT_RENDER_BATCH,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
  NTERACT_THEME,
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
import {
  TracebackOutput,
  type TracebackCellTarget,
  type TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { VideoOutput } from "@/components/outputs/video-output";
import { SvgOutput } from "@/components/outputs/svg-output";
import { WidgetView } from "@/components/widgets/widget-view";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import { dispatchHostOutsideInteractionOnRelease } from "./host-interaction";
import { measureDocumentHeight } from "./layout-measure";
import { outputEntryIdForPayload } from "./output-identity";
// Import widget support
import { IframeWidgetStoreProvider } from "./widget-provider";

// Import widget controls to register them in the widget registry
// This import has side effects that register all built-in widgets
import "@/components/widgets/controls";
import "@/components/widgets/matplotlib";

// --- Renderer Plugin Registry ---
//
// On-demand renderer plugins register React components for specific MIME types.
// Plugins are CJS modules loaded via installRendererPlugin(). The custom
// require shim provides the shared React instance so hooks work correctly.
//
// The registry lives in @/lib/renderer-registry so that both OutputRenderer
// and MediaRouter (used by output widgets) can look up installed renderers.

import {
  type RendererInstallContext,
  getRenderer,
  registerRenderer,
  registerRendererPattern,
} from "@/lib/renderer-registry";

const rendererPluginHostContextListeners = new Set<(context: NteractEmbedHostContext) => void>();

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

  const install = mod.exports.install as ((ctx: RendererInstallContext) => void) | undefined;

  if (typeof install !== "function") {
    throw new Error("[renderer-plugin] Plugin does not export an install() function");
  }

  install({
    register: registerRenderer,
    registerPattern: registerRendererPattern,
    getHostContext: () => currentHostContext,
    subscribeHostContext: (listener) => {
      rendererPluginHostContextListeners.add(listener);
      return () => rendererPluginHostContextListeners.delete(listener);
    },
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
  payload: RenderPayload;
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

let currentHostContext: NteractEmbedHostContext = {};
let hostFontStyle: HTMLStyleElement | null = null;

function applyHostContext(contextPatch: NteractEmbedHostContextPatch) {
  currentHostContext = mergeNteractEmbedHostContext(currentHostContext, contextPatch);

  const isDark =
    currentHostContext.theme === "dark"
      ? true
      : currentHostContext.theme === "light"
        ? false
        : undefined;
  const colorTheme = currentHostContext.nteract?.colorTheme;
  if (isDark !== undefined || colorTheme !== undefined) {
    updateDocumentTheme(isDark ?? document.documentElement.classList.contains("dark"), colorTheme);
  }

  const root = document.documentElement;
  const variables = currentHostContext.styles?.variables;
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      root.style.setProperty(key, value);
    }
  }

  const fonts = currentHostContext.styles?.css?.fonts;
  // Keep font-style handling in sync with the bootstrap implementation in
  // src/components/isolated/frame.html for pre-React renderer delivery.
  if (fonts && fonts.length > 0) {
    if (!hostFontStyle) {
      hostFontStyle = document.createElement("style");
      hostFontStyle.setAttribute("data-nteract-host-fonts", "true");
      document.head.appendChild(hostFontStyle);
    }
    hostFontStyle.textContent = fonts;
  } else if (fonts === "" && hostFontStyle) {
    hostFontStyle.remove();
    hostFontStyle = null;
  }

  const dimensions = currentHostContext.containerDimensions;
  if (dimensions?.width) {
    root.style.setProperty("--nteract-host-width", `${dimensions.width}px`);
  }
  if (dimensions?.maxWidth) {
    root.style.setProperty("--nteract-host-max-width", `${dimensions.maxWidth}px`);
  }
  if (dimensions?.height) {
    root.style.setProperty("--nteract-host-height", `${dimensions.height}px`);
  }
  if (dimensions?.maxHeight) {
    root.style.setProperty("--nteract-host-max-height", `${dimensions.maxHeight}px`);
  }

  // Renderer plugins may size themselves from host-context CSS variables.
  // Parent-side height and width guards are load-bearing: this resize must not
  // create an unbounded host-context <-> size-changed feedback loop.
  window.dispatchEvent(new Event("resize"));
  for (const listener of rendererPluginHostContextListeners) {
    listener(currentHostContext);
  }
}

// --- Message Handling ---

// Global transport for JSON-RPC communication with host
let rpcTransport: JsonRpcTransport | null = null;

function emitRendererDiagnostic(
  phase: string,
  details: Record<string, unknown> = {},
  level: IsolatedDiagnosticLevel = "debug",
) {
  if (rpcTransport) {
    if (level === "warn" || level === "error") {
      rpcTransport.notify(MCP_NOTIFICATIONS_MESSAGE, {
        level: level === "warn" ? "warning" : "error",
        logger: "nteract.isolated-renderer",
        data: {
          source: "isolated-renderer",
          phase,
          details,
        },
      });
      return;
    }

    rpcTransport.notify(NTERACT_DIAGNOSTIC, {
      source: "isolated-renderer",
      phase,
      level,
      details,
    });
    return;
  }

  logIsolatedDiagnostic({
    source: "isolated-renderer",
    phase,
    level,
    details,
  });
}

/** Get the shared transport instance (available after init()) */
export function getTransport(): JsonRpcTransport | null {
  return rpcTransport;
}

type MessageHandler = (type: string, payload: unknown) => void;

let messageHandler: MessageHandler | null = null;

const LAYOUT_PULSE_DELAYS_MS = [0, 160, 600];
let layoutPulseTimers: number[] = [];

function renderedRootDetails(expectedOutputCount?: number): Record<string, unknown> {
  const rootEl = document.getElementById("root");
  return {
    expectedOutputCount: expectedOutputCount ?? null,
    rootChildCount: rootEl?.childElementCount ?? 0,
    rootHtmlLength: rootEl?.innerHTML.length ?? 0,
    measuredHeight: measureDocumentHeight(),
  };
}

function measureDocumentWidth(): number {
  const doc = document.documentElement;
  const body = document.body;
  return Math.ceil(
    Math.max(
      body ? body.scrollWidth : 0,
      body ? body.offsetWidth : 0,
      doc ? doc.scrollWidth : 0,
      doc ? doc.offsetWidth : 0,
    ),
  );
}

function emitPostPaintRenderDiagnostic(expectedOutputCount?: number): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const details = renderedRootDetails(expectedOutputCount);
      const expectedCount = expectedOutputCount ?? 0;
      const rootChildCount = Number(details.rootChildCount);
      const measuredHeight = Number(details.measuredHeight);
      if (expectedCount > 0 && (rootChildCount <= 0 || measuredHeight <= 1)) {
        emitRendererDiagnostic("rendered-empty-after-paint", details, "warn");
      } else {
        emitRendererDiagnostic("rendered-after-paint", details);
      }
    });
  });
}

function postMeasuredHeight(
  type: "resize" | "render_complete",
  expectedOutputCount?: number,
): void {
  const height = measureDocumentHeight();
  window.parent.postMessage(
    {
      type,
      payload: { height },
    },
    "*",
  );
  rpcTransport?.notify(MCP_UI_SIZE_CHANGED, {
    width: measureDocumentWidth(),
    height,
  });
  if (type === "render_complete") {
    emitPostPaintRenderDiagnostic(expectedOutputCount);
  }
}

function pulseRendererLayout(): void {
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("scroll"));
  document.dispatchEvent(new Event("scroll"));
  document.body?.dispatchEvent(new Event("scroll"));
  postMeasuredHeight("resize");
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
    messageHandler?.("render", params);
  });
  rpcTransport.onNotification(NTERACT_RENDER_BATCH, (params) => {
    messageHandler?.("renderBatch", params);
  });
  rpcTransport.onNotification(NTERACT_CLEAR_OUTPUTS, () => {
    messageHandler?.("clear", undefined);
  });
  rpcTransport.onNotification(NTERACT_THEME, (params) => {
    messageHandler?.("theme", params);
  });
  rpcTransport.onNotification(MCP_UI_HOST_CONTEXT_CHANGED, (params) => {
    messageHandler?.("hostContext", params);
  });
  rpcTransport.onRequest(MCP_UI_RESOURCE_TEARDOWN, (params) => {
    const reason =
      typeof params === "object" && params && "reason" in params
        ? String((params as { reason?: unknown }).reason ?? "unknown")
        : "unknown";
    emitRendererDiagnostic("resource-teardown", { reason, protocol: "mcp-ui" });
    for (const timer of layoutPulseTimers) {
      window.clearTimeout(timer);
    }
    layoutPulseTimers = [];
    return {};
  });
  rpcTransport.onRequest(NTERACT_MEASURE_ELEMENT, (params) => {
    const anchorId =
      typeof params === "object" && params && "anchorId" in params
        ? String((params as { anchorId?: unknown }).anchorId ?? "")
        : "";
    const element = anchorId
      ? (document.getElementById(anchorId) ??
        Array.from(document.querySelectorAll("[data-nteract-heading-anchor]")).find(
          (candidate) => candidate.getAttribute("data-nteract-heading-anchor") === anchorId,
        ))
      : null;

    if (!(element instanceof HTMLElement)) {
      return { found: false };
    }

    const rect = element.getBoundingClientRect();
    return {
      found: true,
      top: rect.top + window.scrollY,
      height: rect.height,
    };
  });
  rpcTransport.onNotification(NTERACT_INSTALL_RENDERER, (params) => {
    const { code, css } = params as { code: string; css?: string };
    emitRendererDiagnostic("renderer-plugin-install-start", {
      codeLength: code.length,
      hasCss: css !== undefined,
      cssLength: css?.length ?? 0,
    });
    try {
      installRendererPlugin(code, css);
      emitRendererDiagnostic("renderer-plugin-install-success", {
        codeLength: code.length,
        hasCss: css !== undefined,
        cssLength: css?.length ?? 0,
      });
    } catch (err) {
      console.error("[renderer-plugin] install failed:", err);
      emitRendererDiagnostic(
        "renderer-plugin-install-failed",
        { message: err instanceof Error ? err.message : String(err) },
        "error",
      );
    }
  });
  rpcTransport.start();
  emitRendererDiagnostic("renderer-transport-ready");

  // Legacy listener for any { type, payload } messages that arrive
  // (e.g., during bootstrap before transport is set up on host side)
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;

    const data = event.data;
    // Skip JSON-RPC messages — the transport handles them
    if (data?.jsonrpc === "2.0") return;

    const { type, payload } = data || {};
    // Handle install_renderer directly (doesn't need React message handler)
    if (type === "install_renderer" && payload?.code) {
      emitRendererDiagnostic("renderer-plugin-install-start", {
        codeLength: String(payload.code).length,
        hasCss: payload.css !== undefined,
        cssLength: typeof payload.css === "string" ? payload.css.length : 0,
        legacy: true,
      });
      try {
        installRendererPlugin(payload.code, payload.css);
        emitRendererDiagnostic("renderer-plugin-install-success", { legacy: true });
      } catch (err) {
        console.error("[renderer-plugin] install failed:", err);
        emitRendererDiagnostic(
          "renderer-plugin-install-failed",
          { legacy: true, message: err instanceof Error ? err.message : String(err) },
          "error",
        );
      }
      return;
    }
    if (type === "host_context") {
      messageHandler?.("hostContext", payload);
      return;
    }
    if (messageHandler) {
      messageHandler(type, payload);
    }
  });
}

// --- React App ---

function IsolatedRendererApp() {
  const [state, setState] = useState<RendererState>({
    outputs: [],
    isDark: document.documentElement.classList.contains("dark"),
    interactionActive: false,
  });
  const interactionActiveRef = useRef(false);

  // Handle messages from parent
  const handleMessage = useCallback((type: string, payload: unknown) => {
    switch (type) {
      case "render": {
        try {
          const renderPayload = payload as RenderPayload;
          const id = outputEntryIdForPayload(renderPayload);

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
            postMeasuredHeight("render_complete", 1);
          });
          scheduleRendererLayoutPulses();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[isolated-renderer] invalid render payload:", error);
          emitRendererDiagnostic("invalid-render-payload", { message }, "error");
        }
        break;
      }

      case "renderBatch": {
        try {
          const batchPayload = payload as { outputs: RenderPayload[] };
          const entries: OutputEntry[] = (batchPayload.outputs ?? []).map((p) => ({
            id: outputEntryIdForPayload(p),
            payload: p,
          }));
          setState((prev) => ({ ...prev, outputs: entries }));
          emitRendererDiagnostic("render-batch-received", {
            outputCount: entries.length,
            mimes: entries.map((entry) => entry.payload.mimeType),
          });

          requestAnimationFrame(() => {
            postMeasuredHeight("render_complete", entries.length);
          });
          scheduleRendererLayoutPulses();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[isolated-renderer] invalid render batch payload:", error);
          emitRendererDiagnostic("invalid-render-batch-payload", { message }, "error");
        }
        break;
      }

      case "clear":
        setState((prev) => ({ ...prev, outputs: [] }));
        requestAnimationFrame(() => {
          postMeasuredHeight("render_complete", 0);
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
          updateDocumentTheme(
            themePayload.isDark ?? document.documentElement.classList.contains("dark"),
            themePayload.colorTheme,
          );
        }
        break;
      }
      case "hostContext": {
        const hostContext = payload as NteractEmbedHostContextPatch;
        applyHostContext(hostContext);
        if (hostContext.theme === "light" || hostContext.theme === "dark") {
          setState((prev) => ({
            ...prev,
            isDark: hostContext.theme === "dark",
          }));
        }
        break;
      }
      case "interaction_state": {
        const interactionPayload = payload as { active?: boolean };
        const active = interactionPayload.active ?? false;
        dispatchHostOutsideInteractionOnRelease(interactionActiveRef.current, active);
        interactionActiveRef.current = active;
        setState((prev) => ({
          ...prev,
          interactionActive: active,
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

interface TracebackExecutionTargetEntry {
  execution_id: string;
  source_hash?: string;
  target: TracebackCellTarget;
}

function tracebackTargetKey(executionId: string, sourceHash?: string): string {
  return `${executionId}\u0000${sourceHash ?? ""}`;
}

function tracebackExecutionResolver(
  metadata: RenderPayload["metadata"],
): TracebackExecutionResolver | undefined {
  const entries = metadata?.tracebackExecutionTargets;
  if (!Array.isArray(entries)) return undefined;

  const targets = new Map<string, TracebackCellTarget>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Partial<TracebackExecutionTargetEntry>;
    if (typeof record.execution_id !== "string") continue;
    if (record.source_hash != null && typeof record.source_hash !== "string") continue;
    const target = record.target;
    if (typeof target !== "object" || target === null || typeof target.cellId !== "string") {
      continue;
    }
    targets.set(tracebackTargetKey(record.execution_id, record.source_hash), target);
  }

  if (targets.size === 0) return undefined;

  return (executionId, sourceHash) =>
    targets.get(tracebackTargetKey(executionId, sourceHash)) ??
    targets.get(tracebackTargetKey(executionId)) ??
    null;
}

function postTracebackNavigation(target: TracebackCellTarget): void {
  window.parent.postMessage(
    {
      type: "traceback_navigate",
      payload: { target },
    },
    "*",
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
  payload: RenderPayload;
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
    return (
      <TracebackOutput
        data={data}
        resolveExecutionTarget={tracebackExecutionResolver(metadata)}
        onNavigateToCell={postTracebackNavigation}
      />
    );
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
  if (mimeType === WIDGET_VIEW_MIME) {
    const modelId = parseWidgetViewModelId(data);
    if (!modelId) return null;
    const metadataHint =
      metadata?.nteractWidgetMissingState === "stale" ||
      typeof metadata?.nteractWidgetSummary === "string"
        ? {
            missingState:
              metadata?.nteractWidgetMissingState === "stale" ? ("stale" as const) : undefined,
            summary:
              typeof metadata?.nteractWidgetSummary === "string"
                ? metadata.nteractWidgetSummary
                : undefined,
          }
        : undefined;
    return (
      <WidgetView modelId={modelId} widgetStateHint={payload.widgetStateHint ?? metadataHint} />
    );
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
  emitRendererDiagnostic("renderer-init-start");
  // Signal to the inline handler that React is taking over
  // This prevents the inline handler from processing render/theme/clear messages
  window.__REACT_RENDERER_ACTIVE__ = true;

  // Set up message listener
  setupMessageListener();

  // Theme is controlled by parent's theme message (sent when iframe is ready)
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
      postMeasuredHeight("resize");
    });
  });
  resizeObserver.observe(document.body);
  resizeObserver.observe(rootEl);

  document.addEventListener("fullscreenchange", scheduleRendererLayoutPulses);
  document.addEventListener("webkitfullscreenchange", scheduleRendererLayoutPulses);
  emitRendererDiagnostic("renderer-init-complete");

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
        type: "error",
        payload: {
          message: `Renderer init failed: ${error.message}`,
          stack: error.stack,
        },
      },
      "*",
    );
  }
}
