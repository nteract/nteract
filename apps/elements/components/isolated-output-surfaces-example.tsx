"use client";

import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Boxes,
  Frame,
  Gauge,
  Layers3,
  LockKeyhole,
  MonitorPlay,
  Palette,
  PlugZap,
  ShieldCheck,
} from "lucide-react";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  createDaemonRendererPluginLoader,
  daemonOutputFrameUrl,
  daemonRendererAssetsBaseUrl,
} from "@/components/isolated/daemon-renderer-assets";
import { IsolatedFrame, outputSegmentLane, selectedOutputMimeType } from "@/components/isolated";
import type { RenderPayload } from "@/components/isolated";
import {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
} from "./isolated/frame-config-adapter";
import {
  createNteractEmbedHostContext,
  createNteractThemeVariables,
  mcpAppHostContextToNteractEmbedPatch,
  mergeNteractEmbedHostContext,
} from "@/components/isolated/host-context";
import {
  mcpAppCellHasRichOutput,
  mcpAppCellPreviewText,
  mcpAppStructuredContentToSharedOutputInputs,
  type McpAppStructuredContent,
} from "@/components/isolated/mcp-app-structured-content";
import { McpAppOutputFrame, type McpAppCellData } from "@/components/isolated/mcp-app-output-frame";
import { outputFrameDisplayHeight } from "@/components/isolated/output-frame-sizing";
import {
  needsRendererPlugin,
  rendererPluginInfoForMime,
  rendererPluginNameForMime,
} from "@/components/isolated/renderer-plugin-info";

const laneOutputs: JupyterOutput[] = [
  {
    output_id: "stdout-1",
    output_type: "stream",
    name: "stdout",
    text: "downloaded 56 parquet fragments",
  },
  {
    output_id: "png-1",
    output_type: "display_data",
    data: {
      "image/png":
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEklEQVR4nGNgaGBgYAAAAAQAARV7J8EAAAAASUVORK5CYII=",
      "text/plain": "<chart thumbnail>",
    },
  },
  {
    output_id: "html-1",
    output_type: "display_data",
    data: {
      "text/html": "<section><strong>trusted by iframe policy only</strong></section>",
      "text/plain": "HTML preview",
    },
  },
  {
    output_id: "widget-1",
    output_type: "display_data",
    data: {
      "application/vnd.jupyter.widget-view+json": { model_id: "widget-slider" },
      "text/llm+plain": "IntSlider(value=7, min=0, max=10)",
      "text/plain": "IntSlider(value=7)",
    },
  },
  {
    output_id: "sift-1",
    output_type: "display_data",
    data: {
      "application/vnd.nteract.arrow-stream-manifest+json": {
        schema: "sample_schema",
        chunks: [{ blob: "arrow-chunk-0", byteLength: 8192 }],
      },
      "text/plain": "Arrow stream manifest",
    },
  },
];

const structuredContent: McpAppStructuredContent = {
  blob_base_url: "https://outputs.example.test/artifacts",
  cells: [
    {
      cell_id: "cell-forecast",
      cell_type: "code",
      source: "display(forecast_chart)\ncontrols = widgets.IntSlider(value=7)",
      execution_count: 12,
      status: "idle",
      outputs: [
        {
          output_id: "forecast-stream",
          output_type: "stream",
          name: "stdout",
          text: "loaded 56/56 fragments",
        },
        {
          output_id: "forecast-html",
          output_type: "display_data",
          data: {
            "text/html": '<div class="metric">MAPE 6.8%</div>',
            "text/plain": "MAPE 6.8%",
          },
          llm_preview: { head: "MAPE 6.8%" },
        },
        {
          output_id: "forecast-image",
          output_type: "display_data",
          data: {
            "image/png": "https://outputs.example.test/artifacts/blob/forecast-chart-png",
            "text/plain": "<forecast chart>",
          },
        },
        {
          output_id: "forecast-widget",
          output_type: "display_data",
          data: {
            "application/vnd.jupyter.widget-view+json": { model_id: "widget-slider" },
            "text/llm+plain": "IntSlider(value=7, min=0, max=10)",
            "text/plain": "IntSlider(value=7)",
          },
        },
      ],
    },
  ],
};

const mcpFrameCell: McpAppCellData = {
  cell_id: "cell-mcp-frame",
  cell_type: "code",
  source: "display(report_card)",
  execution_count: 4,
  status: "idle",
  outputs: [
    {
      output_id: "mcp-frame-html",
      output_type: "display_data",
      data: {
        "text/html": [
          '<section style="font: 14px system-ui; padding: 14px; border: 1px solid #d4d4d8; border-radius: 8px;">',
          '<div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: .04em;">MCP App Output</div>',
          '<strong style="display: block; margin-top: 6px; font-size: 18px;">Hosted frame handoff</strong>',
          '<p style="margin: 8px 0 0; color: #52525b;">Structured cell output resolves into the shared iframe embed API.</p>',
          "</section>",
        ].join(""),
        "text/plain": "Hosted frame handoff",
      },
      llm_preview: { head: "Hosted frame handoff" },
    },
  ],
};

const docsOutputFrameRendererBundle = {
  rendererCode: `
    (function () {
      if (window.__NTERACT_ELEMENTS_RENDERER__) return;
      window.__NTERACT_ELEMENTS_RENDERER__ = true;
      var root = document.getElementById("root");

      function send(method, params) {
        window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
      }

      function renderOne(payload) {
        var output = document.createElement("div");
        var mimeType = payload && payload.mimeType;
        var data = payload && payload.data;

        if (mimeType === "text/html") {
          output.innerHTML = String(data || "");
        } else {
          var pre = document.createElement("pre");
          pre.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
          output.appendChild(pre);
        }

        return output;
      }

      function complete() {
        var height = Math.max(
          1,
          Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 1),
        );
        send("nteract/renderComplete", { height: height });
        send("ui/notifications/size-changed", { height: height });
      }

      function scheduleComplete() {
        complete();
        requestAnimationFrame(complete);
        window.setTimeout(complete, 0);
      }

      window.addEventListener("message", function (event) {
        if (event.source && event.source !== window.parent) return;

        var message = event.data || {};
        if (message.jsonrpc !== "2.0") return;

        if (message.method === "nteract/renderOutput") {
          root.replaceChildren(renderOne(message.params || {}));
          scheduleComplete();
        }

        if (message.method === "nteract/renderBatch") {
          root.replaceChildren();
          ((message.params && message.params.outputs) || []).forEach(function (payload) {
            root.appendChild(renderOne(payload));
          });
          scheduleComplete();
        }
      });

      send("nteract/rendererReady");
      window.parent.postMessage({ type: "renderer_ready", payload: null }, "*");
    })();
  `,
  rendererCss: "",
};

const framePayloads: RenderPayload[] = [
  {
    outputId: "html-frame",
    mimeType: "text/html",
    data: "<article><h3>Hosted HTML</h3><p>Rendered by the isolated document shell.</p></article>",
  },
  {
    outputId: "sift-frame",
    mimeType: "application/vnd.nteract.arrow-stream-manifest+json",
    data: {
      chunks: [{ url: "https://outputs.example.test/artifacts/blob/arrow-chunk-0" }],
      rowCount: 22767,
    },
  },
];

const daemonBlobBaseUrl = "https://outputs.example.test/artifacts/";
const docsRendererPluginBaseUrl = "/fixtures/daemon-assets";

const daemonRendererAssetRows = [
  "text/markdown",
  "text/latex",
  "application/vnd.plotly.v1+json",
  "application/vnd.vegalite.v6+json",
  "application/geo+json",
  "application/vnd.apache.parquet",
  "application/vnd.nteract.arrow-stream-manifest+json",
  "text/plain",
].map((mime) => {
  const plugin = rendererPluginInfoForMime(mime);
  return {
    mime,
    plugin: rendererPluginNameForMime(mime) ?? "core",
    css: plugin?.hasCss ?? false,
    needsPlugin: needsRendererPlugin(mime),
  };
});

const daemonRendererAssetCspSamples = [
  {
    label: "allowed daemon frame",
    value: daemonOutputFrameUrl(daemonBlobBaseUrl, {
      frameDomains: ["https://outputs.example.test", "http://localhost:*"],
    }),
  },
  {
    label: "blocked by CSP",
    value: daemonOutputFrameUrl(daemonBlobBaseUrl, {
      frameDomains: ["https://other-renderer.example.test"],
    }),
  },
  {
    label: "plugin asset base",
    value: daemonRendererAssetsBaseUrl(daemonBlobBaseUrl),
  },
];

const productionOutputFrameUrl = daemonOutputFrameUrl(daemonBlobBaseUrl, {
  frameDomains: ["https://outputs.example.test", "http://localhost:*"],
});

const outputFrameBoundaryRows = [
  {
    surface: "Catalog static preview",
    catalogPath: "docs IsolatedFrame adapter",
    productionPath: "createNteractOutputEmbed iframe runtime",
    trigger:
      "The catalog renders payload shape in React so output examples stay deterministic and do not execute untrusted renderer code.",
  },
  {
    surface: "Default frame document",
    catalogPath: "srcdoc frame shell fixture",
    productionPath: "desktop frame.html / nteract-frame URL",
    trigger:
      "Used when the app runtime owns the iframe document and the host does not provide an allowed daemon frame origin.",
  },
  {
    surface: "MCP hosted frame",
    catalogPath: "daemonOutputFrameUrl preview",
    productionPath: "daemon /output-frame document",
    trigger:
      "Enabled only when hostCapabilities.sandbox.csp.frameDomains allows the daemon blob origin.",
  },
  {
    surface: "Renderer plugin assets",
    catalogPath: "docs-served renderer fixture files",
    productionPath: "daemon renderer-plugin routes",
    trigger:
      "Markdown, Plotly, Sift, and other plugin renderers resolve through the same MIME metadata without fetching daemon artifacts in docs.",
  },
];

const daemonRendererPluginLoadMimes = [
  "text/markdown",
  "application/vnd.plotly.v1+json",
  "application/vnd.nteract.arrow-stream-manifest+json",
  "text/plain",
];

type PluginLoadState = {
  mime: string;
  status: "pending" | "loaded" | "core" | "error";
  pluginId: string;
  codeBytes?: number;
  cssBytes?: number;
};

const sizingSamples = [
  { contentHeight: 18, autoHeight: true, maxHeight: 400, minHeight: 24 },
  { contentHeight: 720, autoHeight: false, maxHeight: 420, minHeight: 24 },
  { contentHeight: 1680, autoHeight: false, maxHeight: 900, minHeight: 24 },
];

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function outputKind(output: JupyterOutput) {
  return selectedOutputMimeType(output) ?? output.output_type;
}

function outputIsolationLabel(output: JupyterOutput) {
  const lane = outputSegmentLane(output);
  if (lane === "dom") return "main DOM";
  if (lane === "sift-frame") return "sift frame";
  if (lane === "vega-frame") return "vega frame";
  if (lane === "static-frame") return "static frame";
  return "interactive frame";
}

function documentPreview(document: ReturnType<typeof createIsolatedFrameDocument>) {
  if (document.kind === "src") return document.url;
  return `srcdoc frame shell (${document.html.length.toLocaleString()} chars)`;
}

export function IsolatedOutputSurfacesExample() {
  const [mcpFrameEvents, setMcpFrameEvents] = useState<string[]>([]);
  const [pluginLoadStates, setPluginLoadStates] = useState<PluginLoadState[]>(
    daemonRendererPluginLoadMimes.map((mime) => ({
      mime,
      status: "pending",
      pluginId: rendererPluginNameForMime(mime) ?? "core",
    })),
  );
  const baseContext = createNteractEmbedHostContext({
    isDark: false,
    colorTheme: "cream",
    containerDimensions: { width: 960, maxHeight: 640 },
    locale: "en-US",
    timeZone: "America/Los_Angeles",
    userAgent: "nteract-elements-fixture",
    platform: "desktop",
    deviceCapabilities: { hover: true, touch: false },
  });
  const mcpPatch = mcpAppHostContextToNteractEmbedPatch(
    {
      theme: "dark",
      styles: {
        variables: {
          "--mcp-accent": "#38bdf8",
          "--ignored-number": 12,
        },
        css: {
          fonts: "@font-face { font-family: nteract-fixture; src: local(system-ui); }",
        },
      },
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen", "unsupported"],
      containerDimensions: { width: 1280, height: "invalid", maxHeight: 780 },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      userAgent: "mcp-host-fixture",
      platform: "desktop",
      deviceCapabilities: { hover: true },
      safeAreaInsets: { bottom: 12 },
    },
    {
      includeContainerDimensions: true,
      rendererAssetsBaseUrl: "/renderer-assets",
      outputDocumentUrl: "/output-document.html",
    },
  );
  const mergedContext = mergeNteractEmbedHostContext(baseContext, mcpPatch);
  const themeVariables = createNteractThemeVariables(false, "cream");
  const sharedOutputInputs = mcpAppStructuredContentToSharedOutputInputs(structuredContent);
  const sharedOutputs = sharedOutputInputs.outputs;
  const blobPreviewUrl = sharedOutputInputs.resolveOptions.blobResolver?.url({
    blob: "forecast-chart-png",
  });
  const documents = [
    {
      label: "Desktop runtime",
      document: createIsolatedFrameDocument({ isTauriRuntime: true }),
    },
    {
      label: "Browser docs",
      document: createIsolatedFrameDocument({ isTauriRuntime: false }),
    },
    {
      label: "Hosted output origin",
      document: createIsolatedFrameDocument({
        isTauriRuntime: false,
        outputDocumentUrl: "/output-document.html",
        themeSeed: { theme: "dark", colorTheme: "cream" },
      }),
    },
  ];

  useEffect(() => {
    const loader = createDaemonRendererPluginLoader(docsRendererPluginBaseUrl);
    let cancelled = false;

    async function loadPlugins() {
      const loaded = await Promise.all(
        daemonRendererPluginLoadMimes.map(async (mime): Promise<PluginLoadState> => {
          try {
            const plugin = await loader?.(mime);
            if (!plugin) {
              return {
                mime,
                status: "core",
                pluginId: rendererPluginNameForMime(mime) ?? "core",
              };
            }
            return {
              mime,
              status: "loaded",
              pluginId: plugin.id ?? rendererPluginNameForMime(mime) ?? mime,
              codeBytes: plugin.code.length,
              cssBytes: plugin.css?.length ?? 0,
            };
          } catch {
            return {
              mime,
              status: "error",
              pluginId: rendererPluginNameForMime(mime) ?? mime,
            };
          }
        }),
      );
      if (!cancelled) setPluginLoadStates(loaded);
    }

    void loadPlugins();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="not-prose space-y-8" data-testid="isolated-output-surfaces">
      <section className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <ShieldCheck className="mb-3 size-5 text-emerald-600 dark:text-emerald-300" />
          <h2 className="text-sm font-semibold">Sandbox contract</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The docs adapter mirrors the production frame policy without importing the raw frame
            HTML bundle, relaxing the sandbox, or booting renderer scripts.
          </p>
          <div className="mt-4 space-y-2">
            {ISOLATED_FRAME_SANDBOX_ATTRS.split(" ").map((token) => (
              <div
                key={token}
                className="rounded-md border border-fd-border bg-fd-background px-3 py-2"
              >
                <code className="text-xs">{token}</code>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md border border-fd-border bg-fd-background px-3 py-2">
            <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">allow</div>
            <code className="text-xs">{ISOLATED_FRAME_ALLOW_ATTR}</code>
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <Frame className="mb-3 size-5 text-fd-muted-foreground" />
          <h2 className="text-sm font-semibold">Frame document selection</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Desktop, browser, and hosted deployments choose different frame documents through the
            same adapter shape.
          </p>
          <div className="mt-4 space-y-3">
            {documents.map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-fd-border bg-fd-background p-3"
              >
                <div className="text-xs font-semibold">{item.label}</div>
                <div className="mt-1 break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
                  {item.document.kind}: {documentPreview(item.document)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <Palette className="mb-3 size-5 text-fd-muted-foreground" />
          <h2 className="text-sm font-semibold">Host context merge</h2>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            MCP host context becomes a nteract embed patch, then merges with notebook theme tokens
            and renderer asset URLs.
          </p>
          <dl className="mt-4 grid gap-2 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-fd-muted-foreground">theme</dt>
              <dd className="font-mono">{mergedContext.theme}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fd-muted-foreground">flavor</dt>
              <dd className="font-mono">{mergedContext.nteract?.colorTheme}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fd-muted-foreground">output document</dt>
              <dd className="font-mono">{mergedContext.nteract?.outputDocumentUrl}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fd-muted-foreground">assets base</dt>
              <dd className="font-mono">{mergedContext.nteract?.rendererAssetsBaseUrl}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fd-muted-foreground">safe bottom</dt>
              <dd className="font-mono">{mergedContext.safeAreaInsets?.bottom}px</dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        className="min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card"
        data-testid="daemon-renderer-assets-surface"
      >
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <PlugZap className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">Daemon renderer asset handoff</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The catalog uses the production daemon asset helpers with docs-served fixture bundles.
            This covers MIME-to-plugin routing, output-frame CSP checks, plugin asset URLs, and the
            renderer plugin loader without daemon state or generated renderer artifacts.
          </p>
        </div>
        <div className="border-b border-fd-border p-4">
          <h3 className="text-xs font-semibold uppercase text-fd-muted-foreground">
            Output frame boundary map
          </h3>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The catalog can preview the same decision points, but it does not serve the daemon
            output document. Production MCP hosts only switch to the daemon{" "}
            <code className="rounded bg-fd-muted px-1 py-0.5">/output-frame</code> path after the
            host advertises the daemon blob origin in{" "}
            <code className="rounded bg-fd-muted px-1 py-0.5">frameDomains</code>.
          </p>
          <div className="mt-4 overflow-hidden rounded-md border border-fd-border">
            <div className="hidden grid-cols-[170px_210px_230px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:grid">
              <span>Surface</span>
              <span>Catalog path</span>
              <span>Production path</span>
              <span>Trigger</span>
            </div>
            {outputFrameBoundaryRows.map((row) => (
              <div
                key={row.surface}
                className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 2xl:grid-cols-[170px_210px_230px_minmax(0,1fr)] 2xl:gap-3"
              >
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    Surface
                  </div>
                  <div className="font-semibold">{row.surface}</div>
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    Catalog path
                  </div>
                  <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                    {row.catalogPath}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    Production path
                  </div>
                  <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                    {row.productionPath}
                  </div>
                </div>
                <p className="leading-5 text-fd-muted-foreground">{row.trigger}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="grid min-w-0 gap-4 p-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="min-w-0 space-y-3">
            {daemonRendererAssetCspSamples.map((sample) => (
              <div
                key={sample.label}
                className="rounded-md border border-fd-border bg-fd-background p-3"
              >
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                  {sample.label}
                </div>
                <div className="mt-1 break-words font-mono text-xs [overflow-wrap:anywhere]">
                  {sample.value ?? "null"}
                </div>
              </div>
            ))}
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                docs fixture base
              </div>
              <div className="mt-1 break-words font-mono text-xs [overflow-wrap:anywhere]">
                {docsRendererPluginBaseUrl}/renderer-plugins
              </div>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <div className="text-[11px] font-medium uppercase text-emerald-700 dark:text-emerald-300">
                production hosted frame
              </div>
              <p className="mt-2 text-xs leading-5">
                If the host CSP lists the daemon blob origin in{" "}
                <code className="rounded bg-emerald-100 px-1 py-0.5 dark:bg-emerald-950">
                  frameDomains
                </code>
                , the app passes this URL as the isolated output document instead of depending on
                inline{" "}
                <code className="rounded bg-emerald-100 px-1 py-0.5 dark:bg-emerald-950">
                  srcdoc
                </code>
                .
              </p>
              <div className="mt-2 break-words font-mono text-xs [overflow-wrap:anywhere]">
                {productionOutputFrameUrl ?? "null"}
              </div>
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <div className="hidden grid-cols-[minmax(0,1.2fr)_120px_90px_90px] gap-3 border-b border-fd-border px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:grid">
              <span>MIME</span>
              <span>plugin</span>
              <span>CSS</span>
              <span>route</span>
            </div>
            {daemonRendererAssetRows.map((row) => (
              <div
                key={row.mime}
                className="grid min-w-0 gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 2xl:grid-cols-[minmax(0,1.2fr)_120px_90px_90px] 2xl:gap-3 2xl:py-2"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    MIME
                  </div>
                  <span className="min-w-0 break-words font-mono [overflow-wrap:anywhere]">
                    {row.mime}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    plugin
                  </div>
                  <span className="font-mono">{row.plugin}</span>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    CSS
                  </div>
                  <span>{row.css ? "yes" : "no"}</span>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase text-fd-muted-foreground 2xl:hidden">
                    route
                  </div>
                  <span>{row.needsPlugin ? "plugin" : "core"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid min-w-0 gap-3 border-t border-fd-border p-4 md:grid-cols-2 xl:grid-cols-4">
          {pluginLoadStates.map((state) => (
            <div
              key={state.mime}
              className="min-w-0 rounded-md border border-fd-border bg-fd-background p-3"
            >
              <div className="break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
                {state.mime}
              </div>
              <div className="mt-2 text-sm font-semibold">{state.status}</div>
              <div className="mt-1 text-xs text-fd-muted-foreground">
                {state.pluginId}
                {typeof state.codeBytes === "number"
                  ? ` · ${state.codeBytes} JS bytes · ${state.cssBytes ?? 0} CSS bytes`
                  : ""}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Layers3 className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">Output lane policy</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The catalog uses the same policy helpers that decide whether notebook outputs stay in
            the main DOM, move to a static iframe, require an interactive iframe, or route through
            Sift.
          </p>
        </div>
        <div className="divide-y divide-fd-border">
          {laneOutputs.map((output) => (
            <div
              key={output.output_id}
              className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_160px_160px]"
              data-output-lane={outputSegmentLane(output)}
            >
              <div className="min-w-0">
                <div className="font-mono text-xs text-fd-muted-foreground">{output.output_id}</div>
                <div className="mt-1 break-words text-sm font-semibold [overflow-wrap:anywhere]">
                  {outputKind(output)}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                  lane
                </div>
                <div className="mt-1 text-sm">{outputIsolationLabel(output)}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                  selected MIME
                </div>
                <div className="mt-1 break-words font-mono text-xs [overflow-wrap:anywhere]">
                  {selectedOutputMimeType(output) ?? "none"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <ArrowDownToLine className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">MCP output mapping</h2>
          </div>
          <p className="text-xs leading-5 text-fd-muted-foreground">
            Structured MCP cell output is converted to shared nteract manifests before the iframe
            runtime resolves inline, blob, or URL-backed content.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                manifests
              </div>
              <div className="mt-1 text-2xl font-semibold">{sharedOutputs.length}</div>
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                rich output
              </div>
              <div className="mt-1 text-2xl font-semibold">
                {mcpAppCellHasRichOutput(structuredContent.cells![0]) ? "yes" : "no"}
              </div>
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                preview
              </div>
              <div className="mt-1 truncate text-sm font-semibold">
                {mcpAppCellPreviewText(structuredContent.cells![0])}
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-md border border-fd-border bg-fd-background p-3">
            <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
              blob URL handoff
            </div>
            <div className="mt-1 break-words font-mono text-xs [overflow-wrap:anywhere]">
              {blobPreviewUrl}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <Boxes className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">Shared manifest preview</h2>
          </div>
          <div className="max-h-80 overflow-auto rounded-md border border-fd-border bg-fd-background p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-fd-muted-foreground">
              {formatJson(sharedOutputs)}
            </pre>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <MonitorPlay className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">MCP App output frame</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            This surface mounts the production McpAppOutputFrame and createNteractOutputEmbed path
            with a fixture renderer bundle that handles resolved HTML/text payloads. The sandboxed
            frame renders one resolved HTML output without daemon state or Vite virtual renderer
            artifacts.
          </p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="min-h-[180px] rounded-md border border-fd-border bg-fd-background p-3">
            <McpAppOutputFrame
              cell={mcpFrameCell}
              hostContext={{
                theme: mergedContext.theme,
                displayMode: "inline",
                containerDimensions: { width: 720, maxHeight: 320 },
                styles: {
                  variables: {
                    "--mcp-accent": "#0ea5e9",
                  },
                },
              }}
              rendererBundle={docsOutputFrameRendererBundle}
              rendererAssetsBaseUrl="/renderer-assets"
              autoHeight={false}
              maxHeight={320}
              className="overflow-hidden rounded-md"
              onDiagnostic={(phase) => {
                setMcpFrameEvents((events) => [...events.slice(-5), phase]);
              }}
              onError={(error) =>
                setMcpFrameEvents((events) => [...events.slice(-5), `error: ${error.message}`])
              }
            />
          </div>
          <div className="rounded-md border border-fd-border bg-fd-background p-3">
            <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
              frame cell fixture
            </div>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-fd-muted-foreground">
              {formatJson(mcpFrameCell)}
            </pre>
            <div className="mt-3 border-t border-fd-border pt-3">
              <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
                embed events
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(mcpFrameEvents.length > 0 ? mcpFrameEvents : ["waiting"]).map((event, index) => (
                  <span
                    key={`${index}-${event}`}
                    className="font-mono text-[11px] text-fd-muted-foreground"
                  >
                    {event}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <Gauge className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">Frame sizing policy</h2>
          </div>
          <div className="divide-y divide-fd-border rounded-md border border-fd-border bg-fd-background">
            {sizingSamples.map((sample) => (
              <div
                key={`${sample.contentHeight}-${sample.maxHeight}`}
                className="grid grid-cols-3 gap-3 p-3 text-xs"
              >
                <div>
                  <div className="text-fd-muted-foreground">content</div>
                  <div className="mt-1 font-mono">{sample.contentHeight}px</div>
                </div>
                <div>
                  <div className="text-fd-muted-foreground">policy</div>
                  <div className="mt-1 font-mono">
                    {sample.autoHeight ? "auto" : `max ${sample.maxHeight}px`}
                  </div>
                </div>
                <div>
                  <div className="text-fd-muted-foreground">display</div>
                  <div className="mt-1 font-mono">
                    {outputFrameDisplayHeight(sample.contentHeight, sample)}px
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-fd-border bg-fd-background p-3">
            <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
              sample theme variables
            </div>
            <div className="mt-1 grid gap-1 font-mono text-[11px] text-fd-muted-foreground">
              <span>--sift-bg: {themeVariables["--sift-bg"]}</span>
              <span>--output-document-font: {themeVariables["--output-document-font"]}</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <LockKeyhole className="size-4 text-fd-muted-foreground" />
            <h2 className="text-sm font-semibold">Docs isolated-frame adapter</h2>
          </div>
          <p className="mb-4 text-xs leading-5 text-fd-muted-foreground">
            This renders through the docs adapter for `IsolatedFrame`, so the surface can show host
            context and payload shape without loading production iframe scripts.
          </p>
          <div className="grid gap-3">
            {framePayloads.map((payload) => (
              <IsolatedFrame
                key={payload.outputId}
                name={payload.outputId}
                initialContent={payload}
                darkMode={mergedContext.theme === "dark"}
                colorTheme={mergedContext.nteract?.colorTheme ?? undefined}
                hostContext={mergedContext}
                minHeight={96}
                maxHeight={220}
                className="rounded-md border border-fd-border bg-fd-background p-3"
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
