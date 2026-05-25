import {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
} from "./frame-config";
import type { IframeToParentMessage, RenderPayload } from "./frame-bridge";
import {
  createNteractEmbedHostContext,
  mergeNteractEmbedHostContext,
  type NteractEmbedContainerDimensions,
  type NteractEmbedHostContext,
  type NteractEmbedHostContextPatch,
} from "./host-context";
import { injectPluginsForMimes, needsPlugin } from "./iframe-libraries";
import {
  IsolatedFrameRuntime,
  type IsolatedFrameRendererBundle,
  type IsolatedFrameRuntimeDiagnosticLevel,
} from "./isolated-frame-runtime";
import {
  resolveEmbeddableOutputs,
  type NteractEmbeddableOutput,
  type ResolveEmbeddableOutputsOptions,
} from "./embeddable-output";
import type { OutputBlobResolver } from "./output-manifest";

export type NteractOutputRendererBundleProvider =
  | IsolatedFrameRendererBundle
  | (() => Promise<IsolatedFrameRendererBundle>);

export type NteractOutputEmbedDiagnosticHandler = (
  phase: string,
  details?: Record<string, unknown>,
  level?: IsolatedFrameRuntimeDiagnosticLevel,
  source?: "isolated-frame" | "isolated-renderer" | "iframe-libraries",
) => void;

export interface NteractOutputEmbedOptions {
  target: HTMLElement;
  output?: NteractEmbeddableOutput | readonly NteractEmbeddableOutput[];
  rendererBundle: NteractOutputRendererBundleProvider;
  hostContext?: NteractEmbedHostContextPatch;
  outputDocumentUrl?: string | null;
  blobResolver?: OutputBlobResolver;
  autoHeight?: boolean;
  maxHeight?: number;
  onSizeChanged?: (size: { width?: number; height?: number }) => void;
  onDiagnostic?: NteractOutputEmbedDiagnosticHandler;
  onMessage?: (message: unknown) => void;
  onError?: (error: { message: string; stack?: string }) => void;
}

export interface NteractOutputEmbedHandle {
  iframe: HTMLIFrameElement;
  render(output: NteractEmbeddableOutput): Promise<void>;
  renderBatch(outputs: readonly NteractEmbeddableOutput[]): Promise<void>;
  renderResolved(payloads: readonly RenderPayload[]): Promise<void>;
  setHostContext(patch: NteractEmbedHostContextPatch): void;
  setRendererBundle(bundle: IsolatedFrameRendererBundle): void;
  dispose(): void;
}

const DEFAULT_MAX_HEIGHT = 2000;
let frameCounter = 0;

function clampHeight(height: number, autoHeight: boolean, maxHeight: number): number {
  const rounded = Math.max(1, Math.ceil(height));
  return autoHeight ? rounded : Math.min(maxHeight, rounded);
}

function containerDimensions(
  iframe: HTMLIFrameElement,
  autoHeight: boolean,
  maxHeight: number,
): NteractEmbedContainerDimensions {
  const rect = iframe.getBoundingClientRect();
  const dimensions: NteractEmbedContainerDimensions = {};
  if (rect.width > 0) dimensions.width = Math.round(rect.width);
  if (!autoHeight && Number.isFinite(maxHeight)) dimensions.maxHeight = maxHeight;
  return dimensions;
}

function isBundleProvider(
  provider: NteractOutputRendererBundleProvider,
): provider is () => Promise<IsolatedFrameRendererBundle> {
  return typeof provider === "function";
}

export function createNteractOutputEmbed(
  options: NteractOutputEmbedOptions,
): NteractOutputEmbedHandle {
  const autoHeight = options.autoHeight ?? true;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const iframe = document.createElement("iframe");
  const documentSource = createIsolatedFrameDocument({
    outputDocumentUrl: options.outputDocumentUrl ?? options.hostContext?.nteract?.outputDocumentUrl,
  });
  const injectedPlugins = new Set<string>();
  let disposed = false;
  let hostContextPatch: NteractEmbedHostContextPatch = options.hostContext ?? {};
  let provider = options.rendererBundle;
  let providerPromise: Promise<IsolatedFrameRendererBundle> | null = null;
  let renderGeneration = 0;
  let lastHeight = 1;

  iframe.name = `nteract-output-${++frameCounter}`;
  iframe.title = "";
  iframe.setAttribute("sandbox", ISOLATED_FRAME_SANDBOX_ATTRS);
  iframe.setAttribute("allow", ISOLATED_FRAME_ALLOW_ATTR);
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("data-slot", "isolated-frame");
  iframe.style.width = "100%";
  iframe.style.height = "1px";
  iframe.style.opacity = "1";
  iframe.style.border = "none";
  iframe.style.display = "block";
  iframe.style.background = "transparent";
  iframe.style.userSelect = "none";
  iframe.style.setProperty("-webkit-user-select", "none");

  if (documentSource.kind === "src") {
    iframe.src = documentSource.url;
  } else {
    iframe.srcdoc = documentSource.html;
  }

  const callbacks = {
    onBootstrapReady: () => {
      notifyHostContext();
      loadAndInjectRendererBundle();
    },
    onRendererReady: () => {
      notifyHostContext();
    },
    onResize: (height: number) => applyHeight(height),
    onRenderComplete: (height: number) => applyHeight(height),
    onLinkClick: (url: string, newTab: boolean) =>
      options.onMessage?.({ type: "link_click", payload: { url, newTab } }),
    onMouseDown: () => options.onMessage?.({ type: "mousedown" }),
    onDoubleClick: () => options.onMessage?.({ type: "dblclick" }),
    onWheelBoundary: (params: { deltaY?: number }) =>
      options.onMessage?.({ type: "wheel_boundary", payload: params }),
    onWidgetUpdate: (commId: string, state: Record<string, unknown>) =>
      options.onMessage?.({ type: "widget_update", payload: { commId, state } }),
    onError: (error: { message: string; stack?: string }) => {
      options.onError?.(error);
      options.onDiagnostic?.("renderer-error", error, "error", "isolated-frame");
    },
    onMessage: (message: IframeToParentMessage) => options.onMessage?.(message),
    onDiagnostic: options.onDiagnostic ?? (() => {}),
  };

  const runtime = new IsolatedFrameRuntime({
    getFrameWindow: () => iframe.contentWindow,
    rendererBundle: isBundleProvider(provider) ? undefined : provider,
    callbacks,
  });
  runtime.activate();

  function applyHeight(height: number) {
    const nextHeight = clampHeight(height, autoHeight, maxHeight);
    if (nextHeight === lastHeight) return;
    lastHeight = nextHeight;
    iframe.style.height = `${nextHeight}px`;
    options.onSizeChanged?.({ height: nextHeight });
  }

  function currentHostContext(): NteractEmbedHostContext {
    const isDark = hostContextPatch.theme === "dark";
    return mergeNteractEmbedHostContext(
      createNteractEmbedHostContext({
        isDark,
        colorTheme: hostContextPatch.nteract?.colorTheme,
        containerDimensions: containerDimensions(iframe, autoHeight, maxHeight),
      }),
      hostContextPatch,
    );
  }

  function notifyHostContext() {
    const context = currentHostContext();
    iframe.style.colorScheme = context.theme === "dark" ? "dark" : "light";
    runtime.setTheme(context.theme === "dark", context.nteract?.colorTheme);
    runtime.notifyHostContext(context);
    options.onSizeChanged?.(context.containerDimensions ?? {});
  }

  async function ensureRendererBundle(): Promise<IsolatedFrameRendererBundle> {
    if (!isBundleProvider(provider)) {
      runtime.setRendererBundle(provider);
      return provider;
    }
    providerPromise ??= provider().then((bundle) => {
      runtime.setRendererBundle(bundle);
      return bundle;
    });
    return providerPromise;
  }

  function reportRendererBundleError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    options.onDiagnostic?.(
      "renderer-bundle-provider-error",
      { message },
      "error",
      "isolated-frame",
    );
    options.onError?.({ message });
  }

  function reportOutputResolutionError(error: unknown) {
    const details =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };
    options.onDiagnostic?.("output-resolution-error", details, "error", "isolated-frame");
    options.onError?.(details);
  }

  function loadAndInjectRendererBundle() {
    void ensureRendererBundle()
      .then(() => {
        if (!disposed && runtime.isIframeReady) runtime.injectRendererBundle();
      })
      .catch(reportRendererBundleError);
  }

  async function installRequiredPlugins(payloads: readonly RenderPayload[]): Promise<void> {
    const mimes = payloads.map((payload) => payload.mimeType).filter((mime) => needsPlugin(mime));
    if (mimes.length === 0) return;
    await injectPluginsForMimes(runtime, mimes, injectedPlugins);
  }

  async function renderResolved(payloads: readonly RenderPayload[]): Promise<void> {
    const generation = ++renderGeneration;
    await installRequiredPlugins(payloads);
    if (disposed || generation !== renderGeneration) return;
    if (payloads.length === 1) {
      runtime.render(payloads[0]);
    } else {
      runtime.renderBatch([...payloads]);
    }
  }

  async function resolveAndRender(
    output: NteractEmbeddableOutput | readonly NteractEmbeddableOutput[],
    resolveOptions: ResolveEmbeddableOutputsOptions = {},
  ) {
    const payloads = await resolveEmbeddableOutputs(output, {
      blobResolver: options.blobResolver,
      ...resolveOptions,
    });
    await renderResolved(payloads);
  }

  const handleMessage = (event: MessageEvent) => {
    runtime.handleWindowMessage(event);
  };
  window.addEventListener("message", handleMessage);

  const handleWindowResize = () => notifyHostContext();
  window.addEventListener("resize", handleWindowResize);

  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => notifyHostContext()) : null;

  options.target.appendChild(iframe);
  resizeObserver?.observe(iframe);
  notifyHostContext();
  loadAndInjectRendererBundle();
  if (options.output) {
    void resolveAndRender(options.output).catch(reportOutputResolutionError);
  }

  return {
    iframe,
    render(output) {
      return resolveAndRender(output);
    },
    renderBatch(outputs) {
      return resolveAndRender(outputs);
    },
    renderResolved(payloads) {
      return renderResolved(payloads);
    },
    setHostContext(patch) {
      hostContextPatch = mergeNteractEmbedHostContext(hostContextPatch, patch);
      notifyHostContext();
    },
    setRendererBundle(bundle) {
      provider = bundle;
      providerPromise = null;
      runtime.setRendererBundle(bundle);
      if (runtime.isIframeReady) runtime.injectRendererBundle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("resize", handleWindowResize);
      runtime.dispose();
      iframe.remove();
    },
  };
}
