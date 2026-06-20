/**
 * Panel / PyViz Renderer Plugin
 *
 * Panel's notebook protocol emits HoloViews/PyViz marker MIMEs alongside
 * text/html and sometimes application/javascript. The exec HTML contains
 * inert script tags when inserted through React/innerHTML, so this renderer
 * reparses those tags into executable script elements inside the sandbox.
 */

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { RendererProps } from "@/lib/renderer-registry";
import { PANEL_EXEC_MIME_TYPE, PANEL_LOAD_MIME_TYPE } from "@/components/outputs/panel-mime";
import { measureDocumentHeight } from "./layout-measure";
import { ensurePyVizCommManagerProxy, registerPyVizKernelProxy } from "./widget-bridge-client";

type PanelPayload = {
  [PANEL_LOAD_MIME_TYPE]?: unknown;
  [PANEL_EXEC_MIME_TYPE]?: unknown;
  "application/javascript"?: unknown;
  "text/html"?: unknown;
};

type PyVizGlobal = {
  comms?: Record<string, unknown>;
  comm_status?: Record<string, unknown>;
  kernels?: Record<string, unknown>;
  receivers?: Record<string, unknown>;
  plot_index?: Record<string, unknown>;
};

type BokehView = {
  model?: {
    document?: {
      clear?: () => void;
    };
  };
};

type BokehIndex = Record<string, unknown> & {
  get_by_id?: (id: string) => BokehView | null;
  delete?: (view: unknown) => void;
};

type PanelWindow = Window &
  typeof globalThis & {
    Bokeh?: {
      Panel?: unknown;
      version?: string;
      versions?: {
        get?: (version: string) => unknown;
        has?: (version: string) => boolean;
      };
      index?: BokehIndex;
      require?: (name: string) => unknown;
    };
    PyViz?: PyVizGlobal | HTMLElement;
    __nteractBokehLoadPromise__?: Promise<void>;
    __nteractPanelNotebookLoadStarted__?: boolean;
    __nteractPanelLoadPromises__?: Record<string, Promise<void>>;
    _bokeh_is_initializing?: boolean;
    _bokeh_is_loading?: number;
  };

const BOKEH_RESOURCE_SUFFIXES = ["", "-gl", "-widgets", "-tables", "-mathjax"];
const REQUIRED_BOKEH_MODULES = ["models/widgets/widget"];
const PANEL_DIST_BASE_RE = /https:\/\/cdn\.holoviz\.org\/panel\/[^/]+\/dist\//;

function panelWindow(): PanelWindow {
  return window as PanelWindow;
}

function normalizeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("");
  return null;
}

function asPanelPayload(value: unknown): PanelPayload {
  return value !== null && typeof value === "object" ? (value as PanelPayload) : {};
}

function panelDocumentId(metadata?: Record<string, unknown>): string | null {
  const id = metadata?.id;
  return typeof id === "string" ? id : null;
}

function extractPanelPlotIds(...values: Array<string | null>): string[] {
  const plotIds = new Set<string>();
  const plotIdPattern = /"plot_id"\s*:\s*"([^"]+)"/g;

  for (const value of values) {
    if (!value) continue;
    for (const match of value.matchAll(plotIdPattern)) {
      plotIds.add(match[1]);
    }
  }

  return Array.from(plotIds);
}

function panelServerId(metadata?: Record<string, unknown>): string | null {
  const serverId = metadata?.server_id;
  return typeof serverId === "string" ? serverId : null;
}

function extractBokehVersion(script: string | null): string | null {
  if (!script) return null;
  return script.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

function normalizeBokehVersion(version: string | null): string | null {
  return version?.replace("rc", "-rc.").replace(".dev", "-dev.") ?? null;
}

function extractPanelDistBase(html: string | null): string | null {
  if (!html) return null;
  return html.match(PANEL_DIST_BASE_RE)?.[0] ?? null;
}

function bokehVersionMatches(version: string | null): boolean {
  const bokeh = panelWindow().Bokeh;
  return (
    bokeh !== undefined && (!version || bokeh.version === version || bokeh.versions?.has?.(version))
  );
}

function hasRequiredBokehModules(): boolean {
  const bokeh = panelWindow().Bokeh;
  if (!bokehVersionMatches(null) || !bokeh?.require) return false;

  return REQUIRED_BOKEH_MODULES.every((moduleName) => {
    try {
      bokeh.require?.(moduleName);
      return true;
    } catch {
      return false;
    }
  });
}

function bokehAutoloadInProgress(): boolean {
  const target = panelWindow();
  return target._bokeh_is_initializing === true || (target._bokeh_is_loading ?? 0) > 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPanelNotebookAutoloadStart(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 250) {
    const target = panelWindow();
    if (
      target.Bokeh?.Panel !== undefined ||
      bokehAutoloadInProgress() ||
      hasRequiredBokehModules()
    ) {
      return;
    }
    await delay(25);
  }
}

function waitForBokehAutoload(): Promise<void> {
  if (!bokehAutoloadInProgress()) return Promise.resolve();

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      if (!bokehAutoloadInProgress() || Date.now() - startedAt > 30_000) {
        resolve();
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function ensurePyViz(): PyVizGlobal {
  const target = panelWindow();
  if (!target.PyViz || target.PyViz instanceof HTMLElement) {
    target.PyViz = {};
  }
  const pyviz = target.PyViz;
  pyviz.comms ??= {};
  pyviz.comm_status ??= {};
  pyviz.kernels ??= {};
  pyviz.receivers ??= {};
  pyviz.plot_index ??= {};
  return pyviz;
}

function requestHostResize(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.parent.postMessage(
        {
          type: "resize",
          payload: { height: measureDocumentHeight() },
        },
        "*",
      );
    });
  });
}

function copyScript(source: HTMLScriptElement): HTMLScriptElement {
  const script = document.createElement("script");
  for (const attr of Array.from(source.attributes)) {
    script.setAttribute(attr.name, attr.value);
  }
  script.textContent = source.textContent ?? "";
  return script;
}

function appendExecutableScript(container: HTMLElement, code: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.textContent = code;
  container.appendChild(script);
  requestHostResize();
  return script;
}

function appendHtmlWithExecutableScripts(container: HTMLElement, html: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  container.appendChild(wrapper);

  const inertScripts = Array.from(wrapper.querySelectorAll("script"));
  for (const inertScript of inertScripts) {
    inertScript.replaceWith(copyScript(inertScript));
  }

  requestHostResize();
  return wrapper;
}

function findExistingScript(src: string): HTMLScriptElement | null {
  for (const script of Array.from(document.scripts)) {
    if (script.dataset.nteractPanelSrc === src || script.src === src) return script;
  }
  return null;
}

function waitForReadiness(
  readiness: (() => boolean) | undefined,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (!readiness || readiness()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for Panel/BokehJS resource readiness: ${label}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function loadScript(src: string, required: boolean, readiness?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (readiness?.()) {
      resolve();
      return;
    }

    const existing = findExistingScript(src);
    if (existing) {
      void waitForReadiness(readiness, 30_000, src).then(resolve, (error) => {
        if (required) reject(error);
        else resolve();
      });
      return;
    }

    const script = document.createElement("script");
    script.async = false;
    script.dataset.nteractPanelSrc = src;
    script.onload = () => {
      void waitForReadiness(readiness, 30_000, src).then(resolve, (error) => {
        if (required) reject(error);
        else resolve();
      });
    };
    script.onerror = () => {
      const error = new Error(`Failed to load Panel/BokehJS resource: ${src}`);
      if (required) reject(error);
      else {
        console.warn(error.message);
        resolve();
      }
    };
    script.src = src;
    document.head.appendChild(script);
  });
}

async function ensureBokeh(version: string | null): Promise<void> {
  const target = panelWindow();
  const normalizedVersion = normalizeBokehVersion(version);
  if (bokehVersionMatches(normalizedVersion) && hasRequiredBokehModules()) {
    return;
  }
  if (bokehAutoloadInProgress()) {
    await waitForBokehAutoload();
    if (bokehVersionMatches(normalizedVersion) && hasRequiredBokehModules()) {
      return;
    }
  }
  if (target.__nteractBokehLoadPromise__) return target.__nteractBokehLoadPromise__;
  if (!normalizedVersion) {
    throw new Error("BokehJS is missing and no Bokeh document version was found");
  }

  target.__nteractBokehLoadPromise__ = (async () => {
    for (const [index, suffix] of BOKEH_RESOURCE_SUFFIXES.entries()) {
      const src = `https://cdn.bokeh.org/bokeh/release/bokeh${suffix}-${normalizedVersion}.min.js`;
      const readiness =
        suffix === ""
          ? () => bokehVersionMatches(normalizedVersion)
          : suffix === "-widgets"
            ? hasRequiredBokehModules
            : undefined;
      await loadScript(src, index === 0 || suffix === "-widgets", readiness);
    }
    if (panelWindow().Bokeh === undefined) {
      throw new Error(`BokehJS ${normalizedVersion} loaded without defining window.Bokeh`);
    }
    if (!hasRequiredBokehModules()) {
      throw new Error(`BokehJS ${normalizedVersion} loaded without required widget modules`);
    }
  })().catch((error) => {
    target.__nteractBokehLoadPromise__ = undefined;
    throw error;
  });

  return target.__nteractBokehLoadPromise__;
}

async function ensurePanelRuntime(html: string | null, code: string | null): Promise<void> {
  const target = panelWindow();
  const version = extractBokehVersion(code ?? html);
  await waitForPanelNotebookAutoloadStart();
  await ensureBokeh(version);

  if (target.Bokeh?.Panel !== undefined) return;

  const panelDistBase = extractPanelDistBase(html ?? code);
  if (!panelDistBase) return;

  target.__nteractPanelLoadPromises__ ??= {};
  const panelSrc = `${panelDistBase}panel.min.js`;
  target.__nteractPanelLoadPromises__[panelSrc] ??= loadScript(
    panelSrc,
    true,
    () => target.Bokeh?.Panel !== undefined,
  ).catch((error) => {
    delete target.__nteractPanelLoadPromises__?.[panelSrc];
    throw error;
  });
  await target.__nteractPanelLoadPromises__[panelSrc];
}

function scriptFromServerHtml(html: string): HTMLScriptElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const source = wrapper.querySelector("script");
  if (!source) {
    const script = document.createElement("script");
    script.textContent = html;
    return script;
  }
  return copyScript(source);
}

function bokehViewForDocument(documentId: string): BokehView | null {
  const index = panelWindow().Bokeh?.index;
  if (!index) return null;
  const byId = index.get_by_id?.(documentId);
  if (byId) return byId;
  const legacy = index[documentId];
  return legacy && typeof legacy === "object" ? (legacy as BokehView) : null;
}

function rememberPanelPlot(documentId: string | null): void {
  if (!documentId) return;
  const view = bokehViewForDocument(documentId);
  if (view) {
    ensurePyViz().plot_index![documentId] = view;
  }
}

function cleanupPanelDocument(documentId: string | null): void {
  if (!documentId) return;
  const target = panelWindow();
  const pyviz = target.PyViz instanceof HTMLElement ? undefined : target.PyViz;
  delete pyviz?.plot_index?.[documentId];

  const index = target.Bokeh?.index;
  const view = bokehViewForDocument(documentId);
  view?.model?.document?.clear?.();
  if (view) index?.delete?.(view);
  if (index && Object.prototype.hasOwnProperty.call(index, documentId)) {
    delete index[documentId];
  }
}

function PanelRenderer({ data: rawData, metadata, mimeType }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setError(null);
    const payload = asPanelPayload(rawData);
    const documentId = panelDocumentId(metadata);
    const appendedNodes: ChildNode[] = [];
    const registeredPlotIds = new Set<string>();
    const unregisterPyVizKernels: Array<() => void> = [];
    let cancelled = false;

    function trackNode<T extends ChildNode>(node: T): T {
      appendedNodes.push(node);
      return node;
    }

    function registerPanelPlotId(plotId: string | null): void {
      if (!plotId || registeredPlotIds.has(plotId)) return;
      registeredPlotIds.add(plotId);
      unregisterPyVizKernels.push(registerPyVizKernelProxy(plotId));
    }

    async function renderPanel() {
      if (mimeType === PANEL_LOAD_MIME_TYPE) {
        const code =
          normalizeText(payload[PANEL_LOAD_MIME_TYPE]) ??
          normalizeText(payload["application/javascript"]);
        if (!code) return;
        panelWindow().__nteractPanelNotebookLoadStarted__ = true;
        trackNode(appendExecutableScript(container, code));
        ensurePyVizCommManagerProxy();
        return;
      }

      if (mimeType !== PANEL_EXEC_MIME_TYPE) return;

      ensurePyViz();
      const serverId = panelServerId(metadata);
      if (serverId) {
        const html = normalizeText(payload["text/html"]);
        if (!html) throw new Error("Panel server output did not include text/html script data");
        const script = scriptFromServerHtml(html);
        container.appendChild(script);
        trackNode(script);
        requestHostResize();
        return;
      }

      const html = normalizeText(payload["text/html"]);
      const code = normalizeText(payload["application/javascript"]);
      if (!html && !code) {
        throw new Error("Panel output did not include text/html or application/javascript data");
      }

      registerPanelPlotId(documentId);
      for (const plotId of extractPanelPlotIds(html, code)) {
        registerPanelPlotId(plotId);
      }

      if (!documentId) {
        if (html) {
          trackNode(appendHtmlWithExecutableScripts(container, html));
        }
        if (code) {
          trackNode(appendExecutableScript(container, code));
        }
        return;
      }

      if (html) {
        await ensurePanelRuntime(html, code);
        if (cancelled) return;
        ensurePyVizCommManagerProxy();
        trackNode(appendHtmlWithExecutableScripts(container, html));
      } else if (code) {
        await ensurePanelRuntime(null, code);
        if (cancelled) return;
        ensurePyVizCommManagerProxy();
      }
      if (code) {
        trackNode(appendExecutableScript(container, code));
      }

      rememberPanelPlot(documentId);
      requestAnimationFrame(() => {
        if (!cancelled) rememberPanelPlot(documentId);
      });
    }

    void renderPanel().catch((renderError) => {
      if (!cancelled) {
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    });

    return () => {
      cancelled = true;
      for (const node of appendedNodes) {
        if (node.parentNode === container) {
          container.removeChild(node);
        }
      }
      cleanupPanelDocument(documentId);
      for (const unregisterPyVizKernel of unregisterPyVizKernels) {
        unregisterPyVizKernel();
      }
    };
  }, [rawData, metadata, mimeType]);

  return (
    <div data-slot="panel-output" ref={containerRef}>
      {error ? (
        <pre className="whitespace-pre-wrap rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

export function install(ctx: {
  register: (mimeTypes: string[], component: ComponentType<RendererProps>) => void;
}) {
  ctx.register([PANEL_LOAD_MIME_TYPE, PANEL_EXEC_MIME_TYPE], PanelRenderer);
}
