/**
 * Bokeh Renderer Plugin
 *
 * Bokeh's notebook protocol emits a custom MIME marker alongside sibling
 * text/html and application/javascript payloads. The marker selects this
 * plugin; the nteract payload remaps the sibling data into one object.
 */

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { RendererProps } from "@/lib/renderer-registry";
import { BOKEHJS_EXEC_MIME_TYPE, BOKEHJS_LOAD_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import { measureDocumentHeight } from "./layout-measure";

type BokehPayload = {
  [BOKEHJS_LOAD_MIME_TYPE]?: unknown;
  [BOKEHJS_EXEC_MIME_TYPE]?: unknown;
  "application/javascript"?: unknown;
  "text/html"?: unknown;
};

declare global {
  interface Window {
    Bokeh?: {
      embed?: {
        kernels?: Record<string, unknown>;
      };
      index?: {
        get_by_id?: (id: string) => { model?: { document?: { clear?: () => void } } } | null;
        delete?: (view: unknown) => void;
      };
    };
    __nteractBokehLoadPromise__?: Promise<void>;
  }
}

const BOKEH_RESOURCE_SUFFIXES = ["", "-gl", "-widgets", "-tables", "-mathjax"];

function normalizeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("");
  return null;
}

function asBokehPayload(value: unknown): BokehPayload {
  return value !== null && typeof value === "object" ? (value as BokehPayload) : {};
}

function bokehDocumentId(metadata?: Record<string, unknown>): string | null {
  const id = metadata?.id;
  return typeof id === "string" ? id : null;
}

function bokehServerId(metadata?: Record<string, unknown>): string | null {
  const serverId = metadata?.server_id;
  return typeof serverId === "string" ? serverId : null;
}

function extractBokehVersion(script: string): string | null {
  return script.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

function loadScript(src: string, required: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-nteract-bokeh-src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.async = false;
    script.dataset.nteractBokehSrc = src;
    script.onload = () => resolve();
    script.onerror = () => {
      const error = new Error(`Failed to load BokehJS resource: ${src}`);
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
  if (window.Bokeh !== undefined) return;
  if (window.__nteractBokehLoadPromise__) return window.__nteractBokehLoadPromise__;
  if (!version) {
    throw new Error("BokehJS is missing and no Bokeh document version was found");
  }

  window.__nteractBokehLoadPromise__ = (async () => {
    for (const [index, suffix] of BOKEH_RESOURCE_SUFFIXES.entries()) {
      const src = `https://cdn.bokeh.org/bokeh/release/bokeh${suffix}-${version}.min.js`;
      await loadScript(src, index === 0);
    }
    if (window.Bokeh === undefined) {
      throw new Error(`BokehJS ${version} loaded without defining window.Bokeh`);
    }
  })().catch((error) => {
    window.__nteractBokehLoadPromise__ = undefined;
    throw error;
  });

  return window.__nteractBokehLoadPromise__;
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

function appendExecutableScript(container: HTMLElement, code: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.textContent = code;
  container.appendChild(script);
  requestHostResize();
  return script;
}

function scriptFromServerHtml(html: string): HTMLScriptElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const source = wrapper.querySelector("script");
  const script = document.createElement("script");
  if (source) {
    for (const attr of Array.from(source.attributes)) {
      script.setAttribute(attr.name, attr.value);
    }
    script.textContent = source.textContent ?? "";
  } else {
    script.textContent = html;
  }
  return script;
}

function cleanupBokehDocument(documentId: string | null): void {
  if (!documentId || window.Bokeh?.index == null) return;
  const view = window.Bokeh.index.get_by_id?.(documentId);
  if (!view) return;
  view.model?.document?.clear?.();
  window.Bokeh.index.delete?.(view);
}

function BokehRenderer({ data: rawData, metadata, mimeType }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const payload = asBokehPayload(rawData);
  const documentId = bokehDocumentId(metadata);
  const serverId = bokehServerId(metadata);
  const loadCode =
    mimeType === BOKEHJS_LOAD_MIME_TYPE
      ? (normalizeText(payload[BOKEHJS_LOAD_MIME_TYPE]) ??
        normalizeText(payload["application/javascript"]))
      : null;
  const execCode =
    mimeType === BOKEHJS_EXEC_MIME_TYPE ? normalizeText(payload["application/javascript"]) : null;
  const serverHtml =
    mimeType === BOKEHJS_EXEC_MIME_TYPE && serverId ? normalizeText(payload["text/html"]) : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setError(null);
    let script: HTMLScriptElement | null = null;
    let cancelled = false;

    async function renderBokeh() {
      if (mimeType === BOKEHJS_LOAD_MIME_TYPE) {
        if (!loadCode) return;
        script = appendExecutableScript(container, loadCode);
        return;
      }

      if (mimeType !== BOKEHJS_EXEC_MIME_TYPE) return;

      if (serverId) {
        if (!serverHtml)
          throw new Error("Bokeh server output did not include text/html script data");
        script = scriptFromServerHtml(serverHtml);
        container.appendChild(script);
        requestHostResize();
        return;
      }

      if (!execCode) throw new Error("Bokeh output did not include application/javascript data");
      await ensureBokeh(extractBokehVersion(execCode));
      if (cancelled) return;
      script = appendExecutableScript(container, execCode);
    }

    void renderBokeh().catch((renderError) => {
      if (!cancelled) {
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    });

    return () => {
      cancelled = true;
      if (script?.parentElement === container) {
        container.removeChild(script);
      }
      cleanupBokehDocument(documentId);
    };
  }, [documentId, execCode, loadCode, mimeType, serverHtml, serverId]);

  return (
    <div data-slot="bokeh-output" ref={containerRef}>
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
  ctx.register([BOKEHJS_LOAD_MIME_TYPE, BOKEHJS_EXEC_MIME_TYPE], BokehRenderer);
}
