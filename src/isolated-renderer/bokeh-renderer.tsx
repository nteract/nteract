/**
 * Bokeh Renderer Plugin
 *
 * Bokeh's notebook protocol emits a custom MIME marker alongside sibling
 * text/html and application/javascript payloads. The marker selects this
 * plugin; the nteract payload remaps the sibling data into one object.
 */

import { useEffect, useRef, useState } from "react";
import type { RendererInstallContext, RendererProps } from "@/lib/renderer-registry";
import {
  BOKEHJS_EXEC_MIME_TYPE,
  BOKEHJS_LOAD_MIME_TYPE,
  isBokehSessionMimePayload,
  NTERACT_BOKEH_SESSION_MIME_TYPE,
  type BokehSessionResourceInline,
  type BokehSessionResourceUrl,
  type BokehSessionResources,
} from "@/components/outputs/bokeh-mime";
import type { NteractBokehSessionStatus } from "@/components/isolated/rpc-methods";
import { BokehSessionController, type BokehRuntime } from "./bokeh-session-controller";
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
      version?: string;
      require?: (name: string) => Record<string, unknown>;
      embed?: {
        kernels?: Record<string, unknown>;
      };
      index?: {
        get_by_id?: (id: string) => { model?: { document?: { clear?: () => void } } } | null;
        delete?: (view: unknown) => void;
      };
    };
    __nteractBokehLoadPromise__?: Promise<void>;
    __nteractBokehResourcePromises__?: Map<string, Promise<void>>;
    __nteractBokehInlineResources__?: Set<string>;
    __nteractBokehModulePromises__?: Map<string, Promise<unknown>>;
  }
}

let sessionHostBridge:
  | Pick<RendererInstallContext, "requestHost" | "subscribeHostNotification">
  | undefined;

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

function extractBokehVersion(script: string | null): string | null {
  if (!script) return null;
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

function nativeResourcePromises(): Map<string, Promise<void>> {
  return (window.__nteractBokehResourcePromises__ ??= new Map());
}

function inlineResources(): Set<string> {
  return (window.__nteractBokehInlineResources__ ??= new Set());
}

function loadNativeScript(resource: BokehSessionResourceUrl): Promise<void> {
  const key = `script:${resource.url}`;
  const existing = nativeResourcePromises().get(key);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = false;
    script.dataset.nteractBokehResource = resource.url;
    if (resource.integrity) {
      script.integrity = resource.integrity;
      script.crossOrigin = "anonymous";
    }
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load Bokeh resource: ${resource.url}`));
    script.src = resource.url;
    document.head.appendChild(script);
  }).catch((error) => {
    nativeResourcePromises().delete(key);
    throw error;
  });
  nativeResourcePromises().set(key, promise);
  return promise;
}

function installInlineScript(resource: BokehSessionResourceInline): void {
  const key = `script:${resource.code}`;
  if (inlineResources().has(key)) return;
  const script = document.createElement("script");
  script.dataset.nteractBokehInline = "true";
  script.textContent = resource.code;
  document.head.appendChild(script);
  inlineResources().add(key);
}

function loadNativeStylesheet(resource: BokehSessionResourceUrl): Promise<void> {
  const key = `style:${resource.url}`;
  const existing = nativeResourcePromises().get(key);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.dataset.nteractBokehResource = resource.url;
    if (resource.integrity) {
      link.integrity = resource.integrity;
      link.crossOrigin = "anonymous";
    }
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load Bokeh stylesheet: ${resource.url}`));
    link.href = resource.url;
    document.head.appendChild(link);
  }).catch((error) => {
    nativeResourcePromises().delete(key);
    throw error;
  });
  nativeResourcePromises().set(key, promise);
  return promise;
}

function installInlineStylesheet(resource: BokehSessionResourceInline): void {
  const key = `style:${resource.code}`;
  if (inlineResources().has(key)) return;
  const style = document.createElement("style");
  style.dataset.nteractBokehInline = "true";
  style.textContent = resource.code;
  document.head.appendChild(style);
  inlineResources().add(key);
}

function importModule(url: string): Promise<unknown> {
  const promises = (window.__nteractBokehModulePromises__ ??= new Map());
  const existing = promises.get(url);
  if (existing) return existing;
  const promise = import(/* @vite-ignore */ url).catch((error) => {
    promises.delete(url);
    throw error;
  });
  promises.set(url, promise);
  return promise;
}

async function loadNativeResources(resources: BokehSessionResources): Promise<void> {
  for (const stylesheet of resources.stylesheets) {
    if (stylesheet.kind === "url") await loadNativeStylesheet(stylesheet);
    else installInlineStylesheet(stylesheet);
  }
  for (const javascript of resources.javascript) {
    if (javascript.kind === "url") await loadNativeScript(javascript);
    else installInlineScript(javascript);
  }
  for (const module of resources.javascript_modules) {
    await importModule(module.url);
  }
  for (const [name, url] of Object.entries(resources.module_exports)) {
    const exports = (await importModule(url)) as Record<string, unknown>;
    (window as unknown as Record<string, unknown>)[name] = exports.default ?? exports;
  }
}

function nativeBokehRuntime(expectedVersion: string): BokehRuntime {
  const bokeh = window.Bokeh;
  if (!bokeh?.require) {
    throw new Error("Bokeh resources loaded without a module runtime");
  }
  if (bokeh.version !== expectedVersion) {
    throw new Error(`BokehJS ${bokeh.version ?? "unknown"} cannot render Bokeh ${expectedVersion}`);
  }
  const documentModule = bokeh.require("document") as {
    Document?: BokehRuntime["Document"];
  };
  const embedModule = bokeh.require("embed/standalone") as {
    add_document_standalone?: BokehRuntime["addDocumentStandalone"];
  };
  const serializationModule = bokeh.require("core/serialization") as {
    Buffer?: BokehRuntime["Buffer"];
  };
  if (
    !documentModule.Document ||
    !embedModule.add_document_standalone ||
    !serializationModule.Buffer
  ) {
    throw new Error("BokehJS document modules are incomplete");
  }
  return {
    Document: documentModule.Document,
    Buffer: serializationModule.Buffer,
    addDocumentStandalone: embedModule.add_document_standalone,
  };
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

function copyScript(source: HTMLScriptElement): HTMLScriptElement {
  const script = document.createElement("script");
  for (const attr of Array.from(source.attributes)) {
    script.setAttribute(attr.name, attr.value);
  }
  script.textContent = source.textContent ?? "";
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
  const execHtml =
    mimeType === BOKEHJS_EXEC_MIME_TYPE && !serverId ? normalizeText(payload["text/html"]) : null;
  const serverHtml =
    mimeType === BOKEHJS_EXEC_MIME_TYPE && serverId ? normalizeText(payload["text/html"]) : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setError(null);
    const appendedNodes: ChildNode[] = [];
    let cancelled = false;

    function trackNode<T extends ChildNode>(node: T): T {
      appendedNodes.push(node);
      return node;
    }

    async function renderBokeh() {
      if (mimeType === BOKEHJS_LOAD_MIME_TYPE) {
        if (!loadCode) return;
        trackNode(appendExecutableScript(container, loadCode));
        return;
      }

      if (mimeType !== BOKEHJS_EXEC_MIME_TYPE) return;

      if (serverId) {
        if (!serverHtml)
          throw new Error("Bokeh server output did not include text/html script data");
        const script = scriptFromServerHtml(serverHtml);
        container.appendChild(script);
        trackNode(script);
        requestHostResize();
        return;
      }

      if (!execHtml && !execCode) {
        throw new Error("Bokeh output did not include text/html or application/javascript data");
      }
      await ensureBokeh(extractBokehVersion(execCode ?? execHtml));
      if (cancelled) return;
      if (execHtml) {
        trackNode(appendHtmlWithExecutableScripts(container, execHtml));
      }
      if (execCode) {
        trackNode(appendExecutableScript(container, execCode));
      }
    }

    void renderBokeh().catch((renderError) => {
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
      cleanupBokehDocument(documentId);
    };
  }, [documentId, execCode, execHtml, loadCode, mimeType, serverHtml, serverId]);

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

function NativeBokehSessionRenderer({ data, outputId }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<BokehSessionController | null>(null);
  const [status, setStatus] = useState<NteractBokehSessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!isBokehSessionMimePayload(data)) {
      setStatus("error");
      setError("Invalid Bokeh document session payload");
      return;
    }
    if (!outputId) {
      setStatus("error");
      setError("Bokeh document session output is missing its stable output id");
      return;
    }
    if (!sessionHostBridge) {
      setStatus("error");
      setError("Bokeh document session host bridge is unavailable");
      return;
    }

    let cancelled = false;
    setStatus(null);
    setError(null);
    void (async () => {
      await loadNativeResources(data.resources);
      if (cancelled) return;
      const controller = new BokehSessionController({
        outputId,
        payload: data,
        container,
        runtime: nativeBokehRuntime(data.bokeh_version),
        requestHost: sessionHostBridge.requestHost,
        subscribeHostNotification: sessionHostBridge.subscribeHostNotification,
        onStatus: (nextStatus, nextError) => {
          if (cancelled) return;
          setStatus(nextStatus);
          setError(nextError ?? null);
        },
        onLayout: requestHostResize,
      });
      controllerRef.current = controller;
      await controller.start();
    })().catch((renderError) => {
      if (!cancelled) {
        setStatus("error");
        setError(renderError instanceof Error ? renderError.message : String(renderError));
      }
    });

    return () => {
      cancelled = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [data, outputId]);

  const disconnected = status !== null && status !== "connected";
  const statusLabel =
    status === "closed" ? "Session closed" : status === "error" ? "Session error" : "Disconnected";

  return (
    <div className="relative" data-slot="bokeh-session-output">
      <div ref={containerRef} />
      {disconnected && containerRef.current?.childNodes.length ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm font-medium text-foreground backdrop-blur-[1px]">
          <span title={error ?? undefined}>{statusLabel}</span>
        </div>
      ) : null}
      {error && !containerRef.current?.childNodes.length ? (
        <pre className="whitespace-pre-wrap rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

export function install(ctx: RendererInstallContext) {
  sessionHostBridge = {
    requestHost: ctx.requestHost,
    subscribeHostNotification: ctx.subscribeHostNotification,
  };
  ctx.register([BOKEHJS_LOAD_MIME_TYPE, BOKEHJS_EXEC_MIME_TYPE], BokehRenderer);
  ctx.register([NTERACT_BOKEH_SESSION_MIME_TYPE], NativeBokehSessionRenderer);
}
