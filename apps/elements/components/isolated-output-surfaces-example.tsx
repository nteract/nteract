"use client";

import {
  ArrowDownToLine,
  Boxes,
  Frame,
  Gauge,
  Layers3,
  LockKeyhole,
  Palette,
  ShieldCheck,
} from "lucide-react";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
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
import { outputFrameDisplayHeight } from "@/components/isolated/output-frame-sizing";

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
  if (lane === "static-frame") return "static frame";
  return "interactive frame";
}

function documentPreview(document: ReturnType<typeof createIsolatedFrameDocument>) {
  if (document.kind === "src") return document.url;
  return `srcdoc frame shell (${document.html.length.toLocaleString()} chars)`;
}

export function IsolatedOutputSurfacesExample() {
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
