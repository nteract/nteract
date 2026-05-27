import type { BlobResolver } from "runtimed";
import type { ReadOnlyNotebookCellData } from "../../../../src/components/cell/ReadOnlyNotebook";
import type { SupportedLanguage } from "../../../../src/components/editor/languages";
import type { NteractEmbedHostContextPatch } from "../../../../src/components/isolated/host-context";
import { resolveCell, type RenderCell, type ResolvedCell } from "../../viewer/render-resolution.ts";

const ARROW_BLOB_HASH = "sha256:10bda18795f19e46bee92a2bb34606f89f089868c6b121b7f0526761c913b77f";

const ONE_BY_ONE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export const cloudOutputParityRenderCells: readonly RenderCell[] = [
  {
    id: "markdown-intro",
    cell_type: "markdown",
    source: [
      "# Cloud renderer parity",
      "",
      "Markdown **source** should flow through the shared read-only notebook renderer.",
    ].join("\n"),
  },
  {
    id: "code-streams",
    cell_type: "code",
    source: "print('stdout marker')\nprint('stderr marker')",
    execution_count: 1,
    metadata: { language: "python" },
    outputs: [
      {
        output_id: "stream-stdout",
        output_type: "stream",
        name: "stdout",
        text: "stdout marker\n",
      },
      {
        output_id: "stream-stderr",
        output_type: "stream",
        name: "stderr",
        text: "stderr marker\n",
      },
    ],
  },
  {
    id: "traceback-cell",
    cell_type: "code",
    source: "def summarize_value(df):\n    return df['wrong_column']\n\nsummarize_value(df)",
    execution_count: 2,
    metadata: { language: "python" },
    outputs: [
      {
        output_id: "traceback-output",
        output_type: "error",
        ename: "ColumnNotFoundError",
        evalue: "wrong_column",
        traceback: [
          "Traceback (most recent call last):",
          '  File "<cell>", line 4, in <module>',
          '  File "<cell>", line 2, in summarize_value',
          "ColumnNotFoundError: wrong_column",
        ],
      },
    ],
  },
  {
    id: "html-output",
    cell_type: "code",
    source: "display(HTML('<strong>Cloud HTML marker</strong>'))",
    execution_count: 3,
    outputs: [
      {
        output_id: "html-output-display",
        output_type: "display_data",
        data: {
          "text/html": {
            inline:
              '<section id="cloud-html-marker"><strong>Cloud HTML output marker</strong></section>',
          },
          "text/plain": { inline: "Cloud HTML output marker" },
        },
        metadata: {},
      },
    ],
  },
  {
    id: "svg-output",
    cell_type: "code",
    source: "display(SVG(...))",
    execution_count: 4,
    outputs: [
      {
        output_id: "svg-output-display",
        output_type: "display_data",
        data: {
          "image/svg+xml": {
            inline: [
              '<svg role="img" aria-label="Cloud SVG marker" viewBox="0 0 220 80" xmlns="http://www.w3.org/2000/svg">',
              '<rect width="220" height="80" rx="8" fill="#f8fafc" stroke="#0f766e" />',
              '<text x="16" y="46" fill="#0f766e" font-size="20">Cloud SVG marker</text>',
              "</svg>",
            ].join(""),
          },
          "text/plain": { inline: "Cloud SVG marker" },
        },
        metadata: {},
      },
    ],
  },
  {
    id: "image-json-output",
    cell_type: "code",
    source: "display(image); display(config)",
    execution_count: 5,
    outputs: [
      {
        output_id: "image-output-display",
        output_type: "display_data",
        data: {
          "image/png": { inline: ONE_BY_ONE_PNG },
        },
        metadata: {
          "image/png": { width: 18, height: 18 },
        },
      },
      {
        output_id: "json-output-display",
        output_type: "display_data",
        data: {
          "application/json": {
            inline: JSON.stringify({
              renderer: "cloud",
              marker: "Cloud JSON marker",
              nested: { stable: true },
            }),
          },
        },
        metadata: {},
      },
    ],
  },
  {
    id: "rich-mime-fallback",
    cell_type: "code",
    source: "display(custom_json)",
    execution_count: 6,
    outputs: [
      {
        output_id: "rich-mime-fallback-display",
        output_type: "display_data",
        data: {
          "application/vnd.nteract.unknown+json": {
            inline: JSON.stringify({ marker: "Unknown JSON MIME marker" }),
          },
          "text/plain": { inline: "Plain text fallback marker" },
        },
        metadata: {},
      },
    ],
  },
  {
    id: "sift-arrow-output",
    cell_type: "code",
    source: [
      "import polars as pl",
      "# df contains utf8-view columns and is published as Arrow IPC",
      "df",
    ].join("\n"),
    execution_count: 7,
    outputs: [
      {
        output_id: "sift-arrow-stdout",
        output_type: "stream",
        name: "stdout",
        text: "Preparing Cloud Sift Arrow fixture\n",
      },
      {
        output_id: "sift-arrow-widget-progress",
        output_type: "display_data",
        data: {
          "application/vnd.jupyter.widget-view+json": { model_id: "cloud-sift-progress" },
          "text/plain": "Cloud Sift widget progress marker",
        },
        metadata: {},
      },
      {
        output_id: "sift-arrow-display",
        output_type: "display_data",
        data: {
          "application/vnd.nteract.arrow-stream-manifest+json": {
            inline: JSON.stringify({
              chunks: [{ hash: ARROW_BLOB_HASH, size: 9352, row_count: 96 }],
              complete: true,
            }),
          },
          "text/plain": { inline: "Cloud Sift Arrow marker" },
        },
        metadata: {},
      },
    ],
  },
  {
    id: "mixed-interactive-sift-output",
    cell_type: "code",
    source: [
      "display(plotly_figure)",
      "display(df)",
      "# Plotly and Sift should not share one isolated frame.",
    ].join("\n"),
    execution_count: 8,
    outputs: [
      {
        output_id: "mixed-output-stream",
        output_type: "stream",
        name: "stdout",
        text: "Cloud mixed stream marker\n",
      },
      {
        output_id: "mixed-output-plotly",
        output_type: "display_data",
        data: {
          "application/vnd.plotly.v1+json": {
            inline: JSON.stringify({
              data: [
                {
                  x: [1, 2, 3, 4],
                  y: [2, 1, 4, 3],
                  type: "scatter",
                  mode: "lines+markers",
                  name: "Cloud Plotly segment",
                  marker: { color: "#0f766e" },
                },
              ],
              layout: {
                title: "Cloud Plotly segment marker",
                width: 520,
                height: 300,
                margin: { t: 48, r: 16, b: 40, l: 48 },
              },
              config: { staticPlot: true, displayModeBar: false },
            }),
          },
          "text/plain": { inline: "Cloud Plotly fallback marker" },
        },
        metadata: {},
      },
      {
        output_id: "mixed-output-sift",
        output_type: "display_data",
        data: {
          "application/vnd.nteract.arrow-stream-manifest+json": {
            inline: JSON.stringify({
              chunks: [{ hash: ARROW_BLOB_HASH, size: 9352, row_count: 96 }],
              complete: true,
            }),
          },
          "text/plain": { inline: "Cloud mixed Sift Arrow marker" },
        },
        metadata: {},
      },
    ],
  },
];

export const cloudOutputParityExpectedMarkers = {
  markdown: "Cloud renderer parity",
  stdout: "stdout marker",
  stderr: "stderr marker",
  traceback: "ColumnNotFoundError",
  html: "Cloud HTML output marker",
  svg: "Cloud SVG marker",
  json: "Cloud JSON marker",
  fallback: "Plain text fallback marker",
  siftStream: "Preparing Cloud Sift Arrow fixture",
  siftColumn: "score",
  mixedStream: "Cloud mixed stream marker",
} as const;

export function cloudOutputParityBlobResolver(): BlobResolver {
  return {
    url(ref) {
      if (ref.blob === ARROW_BLOB_HASH) return absoluteFixtureUrl("/fixture-blobs/sift.arrow");
      return absoluteFixtureUrl(`/fixture-blobs/${encodeURIComponent(ref.blob)}`);
    },
    async fetch(ref) {
      if (ref.blob === ARROW_BLOB_HASH) {
        return fetch("/fixture-blobs/sift.arrow");
      }
      return new Response("missing cloud output parity fixture blob", { status: 404 });
    },
  };
}

export function cloudOutputParityHostContext(): NteractEmbedHostContextPatch {
  return {
    nteract: {
      rendererAssetsBaseUrl: "/renderer-assets/",
      outputDocumentUrl: "/output-document/frame.html",
    },
    platform: "web",
  };
}

function absoluteFixtureUrl(path: string): string {
  return new URL(path, globalThis.location?.href ?? "http://127.0.0.1:5182/").href;
}

export async function resolveCloudOutputParityCells(): Promise<ReadOnlyNotebookCellData[]> {
  const blobResolver = cloudOutputParityBlobResolver();
  const cells = await Promise.all(
    cloudOutputParityRenderCells.map((cell, index) =>
      resolveCell(cell, blobResolver, index, "python"),
    ),
  );
  return cells.map(toReadOnlyNotebookCell);
}

function toReadOnlyNotebookCell(cell: ResolvedCell): ReadOnlyNotebookCellData {
  return {
    ...cell,
    language: supportedLanguage(cell.language),
  };
}

function supportedLanguage(language: string | null): SupportedLanguage | null {
  switch (language) {
    case "python":
    case "ipython":
    case "markdown":
    case "sql":
    case "html":
    case "javascript":
    case "typescript":
    case "json":
    case "yaml":
    case "toml":
    case "plain":
      return language;
    case null:
      return null;
    default:
      return "plain";
  }
}
