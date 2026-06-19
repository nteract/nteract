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
      index?: BokehIndex;
    };
    PyViz?: PyVizGlobal | HTMLElement;
  };

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

function panelServerId(metadata?: Record<string, unknown>): string | null {
  const serverId = metadata?.server_id;
  return typeof serverId === "string" ? serverId : null;
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
  delete pyviz?.kernels?.[documentId];
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
    let cancelled = false;

    function trackNode<T extends ChildNode>(node: T): T {
      appendedNodes.push(node);
      return node;
    }

    async function renderPanel() {
      if (mimeType === PANEL_LOAD_MIME_TYPE) {
        const code =
          normalizeText(payload[PANEL_LOAD_MIME_TYPE]) ??
          normalizeText(payload["application/javascript"]);
        if (!code) return;
        trackNode(appendExecutableScript(container, code));
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

      if (html) {
        trackNode(appendHtmlWithExecutableScripts(container, html));
      }
      if (code) {
        trackNode(appendExecutableScript(container, code));
      }

      rememberPanelPlot(documentId);
      requestAnimationFrame(() => {
        rememberPanelPlot(documentId);
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
