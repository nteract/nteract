"use client";

import {
  setWasmUrl,
  SiftTable,
  type SiftTableProps,
  type TableData,
  type TableEngineState,
} from "@nteract/sift";
import {
  AlertTriangle,
  Braces,
  Database,
  FileAudio,
  FileImage,
  FileText,
  FileWarning,
  ListFilter,
  Palette,
  SlidersHorizontal,
  Table2,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnsiErrorOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
import { AudioOutput } from "@/components/outputs/audio-output";
import { ImageOutput } from "@/components/outputs/image-output";
import { JavaScriptOutput } from "@/components/outputs/javascript-output";
import { GeoJsonOutput } from "@/components/outputs/geojson-output";
import { JsonOutput } from "@/components/outputs/json-output";
import { MathOutput } from "@/components/outputs/math-output";
import { PdfOutput } from "@/components/outputs/pdf-output";
import { PlotlyOutput } from "@/components/outputs/plotly-output";
import { selectMimeType } from "@/components/outputs/mime-priority";
import { isSafeForMainDom } from "@/components/outputs/safe-mime-types";
import { SvgOutput } from "@/components/outputs/svg-output";
import { TracebackOutput } from "@/components/outputs/traceback-output";
import { VegaOutput } from "@/components/outputs/vega-output";
import { VideoOutput } from "@/components/outputs/video-output";
import { OutputArea } from "@/components/cell/OutputArea";
import { getElementsNotebookScenario } from "@/components/notebook-scenarios";
import "@/components/widgets/controls";
import { WidgetStoreContext } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";

setWasmUrl("/wasm/sift_wasm_bg.wasm");

type SiftLoadMilestone = Parameters<NonNullable<SiftTableProps["onLoadMilestone"]>>[0];

const outputRendererScenario = getElementsNotebookScenario("desktop-local-owner");
const outputFixtures = outputRendererScenario.outputState;
const { siftParquetUrl, siftParquetRows, siftArrowStreamChunkUrl, siftArrowStreamManifest } =
  outputFixtures;

const svgFigure = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180">
  <rect width="420" height="180" rx="16" fill="#f8fafc"/>
  <path d="M42 128 C92 88 116 98 158 66 C204 32 242 78 284 50 C318 28 356 42 380 30" fill="none" stroke="#2563eb" stroke-width="8" stroke-linecap="round"/>
  <path d="M42 144 H382" stroke="#94a3b8" stroke-width="2"/>
  <path d="M42 144 V32" stroke="#94a3b8" stroke-width="2"/>
  <circle cx="158" cy="66" r="7" fill="#16a34a"/>
  <circle cx="284" cy="50" r="7" fill="#f97316"/>
  <text x="42" y="24" fill="#334155" font-family="ui-sans-serif, system-ui" font-size="16" font-weight="700">fixture metric</text>
  <text x="312" y="160" fill="#64748b" font-family="ui-sans-serif, system-ui" font-size="12">ImageOutput</text>
</svg>`;

const imageDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svgFigure)}`;

const svgOutputFixture = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180">
  <rect width="420" height="180" rx="16" fill="#eef2ff"/>
  <circle cx="92" cy="92" r="36" fill="#3b82f6" opacity="0.85"/>
  <circle cx="174" cy="72" r="44" fill="#10b981" opacity="0.82"/>
  <circle cx="280" cy="98" r="52" fill="#f59e0b" opacity="0.78"/>
  <path d="M56 142 H360" stroke="#475569" stroke-width="3" stroke-linecap="round"/>
  <text x="56" y="38" fill="#1e293b" font-family="ui-sans-serif, system-ui" font-size="16" font-weight="700">svg-output fixture</text>
</svg>`;

const silentAudioDataUrl =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const plotlyFixture = {
  data: [
    {
      type: "bar",
      x: ["baseline", "promo", "weather"],
      y: [8.42, 6.8, 7.14],
      marker: { color: ["#2563eb", "#0f766e", "#f97316"] },
      name: "MAE",
    },
  ],
  layout: {
    title: { text: "Forecast error by feature group" },
    yaxis: { title: { text: "MAE" } },
  },
};

const vegaFixture = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  title: "Weekly forecast lift",
  data: {
    values: [
      { week: "W01", lift: 0.12 },
      { week: "W02", lift: 0.18 },
      { week: "W03", lift: 0.09 },
      { week: "W04", lift: 0.22 },
    ],
  },
  mark: "line",
  encoding: {
    x: { field: "week", type: "ordinal" },
    y: { field: "lift", type: "quantitative" },
  },
};

const geoJsonFixture = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "North hub" },
      geometry: { type: "Point", coordinates: [-122.4194, 37.7749] },
    },
    {
      type: "Feature",
      properties: { name: "South hub" },
      geometry: { type: "Point", coordinates: [-118.2437, 34.0522] },
    },
  ],
};

const pdfDataUrl =
  "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjIwIDUwIFRkCihudGVyYWN0IGZpeHR1cmUpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnRyYWlsZXIKPDwgL1Jvb3QgMSAwIFIgPj4KJSVFT0Y=";

const videoDataUrl = "data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=";

const siftRows: unknown[][] = [
  [
    "08m4",
    335,
    true,
    "JBMO",
    "Geometry > Plane Geometry > Quadrilaterals",
    "Let ABCD be a parallelogram with AC > BD...",
  ],
  [
    "0e2o",
    452,
    true,
    "National Math Olympiad",
    "Geometry > Triangle centers",
    "Let H be the orthocentre of the acute triangle ABC...",
  ],
  [
    "1d7p",
    188,
    false,
    "IMO Shortlist",
    "Algebra > Inequalities",
    "Find all positive real triples satisfying the system...",
  ],
  [
    "2k9a",
    276,
    false,
    "USAMO",
    "Number Theory > Modular arithmetic",
    "Prove there are infinitely many integers n such that...",
  ],
  [
    "39rf",
    514,
    true,
    "Balkan MO",
    "Combinatorics > Graphs",
    "A tournament on 2026 vertices has the following property...",
  ],
  [
    "5zqx",
    241,
    false,
    "China TST",
    "Algebra > Polynomials",
    "Let P be a polynomial with integer coefficients...",
  ],
  [
    "7c1n",
    397,
    true,
    "Romania",
    "Geometry > Circles",
    "Two circles meet at A and B. A line through A...",
  ],
  [
    "9p0s",
    318,
    false,
    "Putnam",
    "Combinatorics > Counting",
    "How many subsets satisfy the parity condition...",
  ],
];

const siftData: TableData = {
  columns: [
    {
      key: "id",
      label: "ID",
      width: 92,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
    {
      key: "problem_length",
      label: "Problem length",
      width: 180,
      sortable: true,
      numeric: true,
      columnType: "numeric",
    },
    {
      key: "has_images",
      label: "Has images",
      width: 130,
      sortable: true,
      numeric: false,
      columnType: "boolean",
    },
    {
      key: "competition",
      label: "Competition",
      width: 220,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
    {
      key: "topic",
      label: "Topic",
      width: 300,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
    {
      key: "problem_markdown",
      label: "Problem markdown",
      width: 360,
      sortable: false,
      numeric: false,
      columnType: "categorical",
    },
  ],
  rowCount: siftRows.length,
  getCell: (row, col) => {
    const value = siftRows[row]?.[col];
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value ?? "");
  },
  getCellRaw: (row, col) => siftRows[row]?.[col],
  columnSummaries: [
    {
      kind: "categorical",
      uniqueCount: 8,
      topCategories: [
        { label: "08m4", count: 1, pct: 12.5 },
        { label: "0e2o", count: 1, pct: 12.5 },
        { label: "1d7p", count: 1, pct: 12.5 },
      ],
      othersCount: 5,
      othersPct: 62.5,
      allCategories: siftRows.map((row) => ({ label: String(row[0]), count: 1, pct: 12.5 })),
      medianTextLength: 4,
    },
    {
      kind: "numeric",
      min: 188,
      max: 514,
      bins: [
        { x0: 180, x1: 260, count: 2 },
        { x0: 260, x1: 340, count: 3 },
        { x0: 340, x1: 420, count: 1 },
        { x0: 420, x1: 500, count: 1 },
        { x0: 500, x1: 580, count: 1 },
      ],
      uniqueCount: 8,
    },
    {
      kind: "boolean",
      trueCount: 4,
      falseCount: 4,
      nullCount: 0,
      total: 8,
    },
    {
      kind: "categorical",
      uniqueCount: 8,
      topCategories: [
        { label: "JBMO", count: 1, pct: 12.5 },
        { label: "IMO Shortlist", count: 1, pct: 12.5 },
        { label: "USAMO", count: 1, pct: 12.5 },
      ],
      othersCount: 5,
      othersPct: 62.5,
      allCategories: siftRows.map((row) => ({ label: String(row[3]), count: 1, pct: 12.5 })),
      medianTextLength: 10,
    },
    {
      kind: "categorical",
      uniqueCount: 8,
      topCategories: [
        { label: "Geometry", count: 3, pct: 37.5 },
        { label: "Algebra", count: 2, pct: 25 },
        { label: "Combinatorics", count: 2, pct: 25 },
      ],
      othersCount: 1,
      othersPct: 12.5,
      allCategories: siftRows.map((row) => ({ label: String(row[4]), count: 1, pct: 12.5 })),
      medianTextLength: 30,
    },
    null,
  ],
};

const expectedSiftUrlMilestones = [
  {
    phase: "URL",
    value: "mstz/heart_failure - death/train/0000.parquet",
  },
  {
    phase: "Fetch",
    value: "12 KB parquet source from HuggingFace",
  },
  {
    phase: "Decode",
    value: "docs-served sift-wasm load_parquet_row_group",
  },
  {
    phase: "Render",
    value: "SiftTable source.kind = url",
  },
];

const expectedSiftManifestMilestones = [
  {
    phase: "Manifest",
    value: "1 Arrow IPC chunk from docs fixtures",
  },
  {
    phase: "Fetch",
    value: siftArrowStreamChunkUrl.replace("/fixtures/", ""),
  },
  {
    phase: "Append",
    value: "create_arrow_stream_store + append_arrow_stream_chunk",
  },
  {
    phase: "Render",
    value: "SiftTable source.kind = arrow-stream-manifest",
  },
];

function visibleSiftMilestones(
  milestones: SiftLoadMilestone[],
  expected: Array<{ phase: string; value: string }>,
) {
  if (milestones.length === 0) {
    return expected.map((milestone, index) => ({
      key: `expected-${index}-${milestone.phase}`,
      ...milestone,
    }));
  }

  const visible = milestones.slice(-4);
  const visibleStartIndex = milestones.length - visible.length;

  return visible.map((milestone, index) => ({
    key: [
      visibleStartIndex + index,
      milestone.phase,
      milestone.format,
      milestone.chunkIndex,
      milestone.chunkCount,
      milestone.rowCount,
      milestone.byteLength,
      milestone.elapsedMs,
    ].join(":"),
    phase: milestone.phase,
    value: [
      milestone.format,
      typeof milestone.chunkIndex === "number" && typeof milestone.chunkCount === "number"
        ? `chunk ${milestone.chunkIndex + 1}/${milestone.chunkCount}`
        : typeof milestone.chunkCount === "number"
          ? `${milestone.chunkCount} chunk${milestone.chunkCount === 1 ? "" : "s"}`
          : null,
      typeof milestone.rowCount === "number" ? `${milestone.rowCount} rows` : null,
      typeof milestone.byteLength === "number"
        ? `${Math.round(milestone.byteLength / 1024)} KB`
        : null,
      `${milestone.elapsedMs} ms`,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

type PlotlyFixture = {
  newPlot: (element: HTMLElement, payload: { data?: unknown[] }) => void;
  relayout: (element: HTMLElement) => void;
  purge: (element: HTMLElement) => void;
  Plots: { resize: (element: HTMLElement) => void };
};

type VegaFixtureView = {
  finalize: () => void;
  background: (color: string | null) => void;
};

type VegaEmbedFixture = (
  element: HTMLElement,
  spec: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<{ view: VegaFixtureView }>;

type LeafletFixtureLayer = {
  _url?: string;
  addTo: (map: LeafletFixtureMap) => LeafletFixtureLayer;
  remove: () => void;
};

type LeafletFixtureMap = {
  layers: LeafletFixtureLayer[];
  eachLayer: (callback: (layer: LeafletFixtureLayer) => void) => void;
  fitBounds: () => void;
  invalidateSize: () => void;
  remove: () => void;
  renderGeoJson: (data: unknown) => void;
  setView: () => void;
};

type LeafletFixture = {
  map: (element: HTMLElement) => LeafletFixtureMap;
  tileLayer: (url: string) => LeafletFixtureLayer;
  geoJSON: (data: unknown) => LeafletFixtureLayer & {
    getBounds: () => { isValid: () => boolean };
    setStyle: () => void;
  };
  circleMarker: () => Record<string, never>;
};

type RendererFixtureWindow = Window & {
  Plotly?: PlotlyFixture;
  vegaEmbed?: VegaEmbedFixture;
  L?: LeafletFixture;
};

function featureCount(data: unknown): number {
  if (!data || typeof data !== "object" || !("features" in data)) return 0;
  const features = (data as { features?: unknown }).features;
  return Array.isArray(features) ? features.length : 0;
}

function renderFixturePanel(element: HTMLElement, title: string, detail: string, rows: string[]) {
  const wrapper = document.createElement("div");
  wrapper.className =
    "rounded-md border border-fd-border bg-fd-background p-3 text-sm text-fd-foreground";
  wrapper.dataset.elementsRendererFixture = title;

  const heading = document.createElement("div");
  heading.className = "font-semibold";
  heading.textContent = title;
  wrapper.appendChild(heading);

  const description = document.createElement("div");
  description.className = "mt-1 text-xs leading-5 text-fd-muted-foreground";
  description.textContent = detail;
  wrapper.appendChild(description);

  const grid = document.createElement("div");
  grid.className = "mt-3 grid grid-cols-4 gap-2";
  rows.forEach((row, index) => {
    const bar = document.createElement("div");
    bar.className = "rounded bg-sky-500/20 p-2 text-center text-[11px] text-sky-900";
    bar.style.minHeight = `${32 + index * 12}px`;
    bar.textContent = row;
    grid.appendChild(bar);
  });
  wrapper.appendChild(grid);

  element.replaceChildren(wrapper);
}

function createPlotlyFixture(): PlotlyFixture {
  return {
    newPlot(element, payload) {
      renderFixturePanel(
        element,
        "Plotly fixture adapter",
        `${payload.data?.length ?? 0} trace rendered through PlotlyOutput without loading plotly.js`,
        ["baseline", "promo", "weather", "holdout"],
      );
    },
    relayout() {},
    purge(element) {
      element.replaceChildren();
    },
    Plots: { resize() {} },
  };
}

function createVegaEmbedFixture(): VegaEmbedFixture {
  return async (element, spec) => {
    renderFixturePanel(
      element,
      "Vega fixture adapter",
      `${String(spec.title ?? "Vega-Lite spec")} rendered through VegaOutput with injected vegaEmbed`,
      ["W01", "W02", "W03", "W04"],
    );
    return {
      view: {
        finalize: () => element.replaceChildren(),
        background: () => {},
      },
    };
  };
}

function createLeafletFixture(): LeafletFixture {
  return {
    map(element) {
      renderFixturePanel(
        element,
        "Leaflet fixture adapter",
        "Map shell created through GeoJsonOutput with injected Leaflet APIs",
        ["tile", "bounds", "zoom", "theme"],
      );
      const map: LeafletFixtureMap = {
        layers: [],
        eachLayer(callback) {
          this.layers.forEach(callback);
        },
        fitBounds() {},
        invalidateSize() {},
        remove() {
          element.replaceChildren();
        },
        renderGeoJson(data) {
          renderFixturePanel(
            element,
            "GeoJSON fixture adapter",
            `${featureCount(data)} feature(s) rendered through GeoJsonOutput without fetching map tiles`,
            ["north", "south", "route", "bounds"],
          );
        },
        setView() {},
      };
      return map;
    },
    tileLayer(url) {
      const layer: LeafletFixtureLayer = {
        _url: url,
        addTo(map) {
          map.layers.push(layer);
          return layer;
        },
        remove() {},
      };
      return layer;
    },
    geoJSON(data) {
      const layer = {
        addTo(map: LeafletFixtureMap) {
          map.layers.push(layer);
          map.renderGeoJson(data);
          return layer;
        },
        getBounds: () => ({ isValid: () => true }),
        remove() {},
        setStyle() {},
      };
      return layer;
    },
    circleMarker() {
      return {};
    },
  };
}

function RendererLibraryFixtureProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const fixtureWindow = window as RendererFixtureWindow;
    const hadPlotly = "Plotly" in fixtureWindow;
    const hadVegaEmbed = "vegaEmbed" in fixtureWindow;
    const hadLeaflet = "L" in fixtureWindow;
    const previousPlotly = fixtureWindow.Plotly;
    const previousVegaEmbed = fixtureWindow.vegaEmbed;
    const previousLeaflet = fixtureWindow.L;

    fixtureWindow.Plotly ??= createPlotlyFixture();
    fixtureWindow.vegaEmbed ??= createVegaEmbedFixture();
    fixtureWindow.L ??= createLeafletFixture();
    setReady(true);

    return () => {
      if (hadPlotly) fixtureWindow.Plotly = previousPlotly;
      else delete fixtureWindow.Plotly;
      if (hadVegaEmbed) fixtureWindow.vegaEmbed = previousVegaEmbed;
      else delete fixtureWindow.vegaEmbed;
      if (hadLeaflet) fixtureWindow.L = previousLeaflet;
      else delete fixtureWindow.L;
    };
  }, []);

  if (!ready) {
    return (
      <div className="rounded-md border border-fd-border bg-fd-background p-3 text-sm text-fd-muted-foreground">
        Loading fixture renderer adapters...
      </div>
    );
  }

  return <>{children}</>;
}

const renderedPieces = [
  {
    name: "OutputArea",
    source: "src/components/cell/OutputArea.tsx",
    note: "Notebook output lane composition, collapse control, DOM-vs-isolated segmentation, widget-view MIME handoff, and search count plumbing rendered with static outputs.",
  },
  {
    name: "AnsiStreamOutput",
    source: "src/components/outputs/ansi-output.tsx",
    note: "stdout/stderr stream rendering, long-output preview, and ANSI color classes.",
  },
  {
    name: "AnsiErrorOutput",
    source: "src/components/outputs/ansi-output.tsx",
    note: "Classic error traceback fallback for nbformat error outputs.",
  },
  {
    name: "JsonOutput",
    source: "src/components/outputs/json-output.tsx",
    note: "Expandable notebook JSON tree using the current collapsible tree behavior.",
  },
  {
    name: "ImageOutput",
    source: "src/components/outputs/image-output.tsx",
    note: "Notebook media frame with data URL and preload handling.",
  },
  {
    name: "MathOutput",
    source: "src/components/outputs/math-output.tsx",
    note: "KaTeX-backed text/latex rendering that is safe in the main output lane; its KaTeX stylesheet is owned by the output component, not the docs app shell.",
  },
  {
    name: "SvgOutput",
    source: "src/components/outputs/svg-output.tsx",
    note: "SVG insertion and responsive sizing for vector notebook figures.",
  },
  {
    name: "AudioOutput",
    source: "src/components/outputs/audio-output.tsx",
    note: "Notebook audio player for data URLs, blob URLs, and base64 payloads.",
  },
  {
    name: "JavaScriptOutput",
    source: "src/components/outputs/javascript-output.tsx",
    note: "Main-DOM safety fallback for JavaScript output; execution remains isolated only.",
  },
  {
    name: "TracebackOutput",
    source: "src/components/outputs/traceback-output.tsx",
    note: "nteract-owned structured traceback renderer with source context and copy affordance.",
  },
  {
    name: "PlotlyOutput",
    source: "src/components/outputs/plotly-output.tsx",
    note: "Plotly component path rendered with a docs-local Plotly fixture adapter instead of loading plotly.js into the catalog bundle.",
  },
  {
    name: "VegaOutput",
    source: "src/components/outputs/vega-output.tsx",
    note: "Vega/Vega-Lite component path rendered with an injected vegaEmbed fixture.",
  },
  {
    name: "GeoJsonOutput",
    source: "src/components/outputs/geojson-output.tsx",
    note: "Leaflet-backed GeoJSON component path rendered with a deterministic map-library fixture.",
  },
  {
    name: "PdfOutput",
    source: "src/components/outputs/pdf-output.tsx",
    note: "PDF wrapper exercised with a data URL fixture and download affordance.",
  },
  {
    name: "VideoOutput",
    source: "src/components/outputs/video-output.tsx",
    note: "Video wrapper exercised with a data URL fixture so media chrome remains catalog-visible.",
  },
  {
    name: "SiftTable",
    source: "packages/sift/src/react.tsx",
    note: "nteract-owned Arrow/parquet table UI rendered here with static TableData, a live HuggingFace parquet URL, and an Arrow stream manifest decoded by the docs-served Sift WASM asset.",
  },
];

const adapterBoundaries = [
  {
    name: "IsolatedFrame",
    reason:
      "Required in production for HTML, markdown with raw HTML, executable JavaScript, widget bridge bootstrap, and renderer library bootstrap. This page uses deterministic fixture globals and a docs widget adapter for visible component paths.",
  },
  {
    name: "Output widget comm replay",
    reason:
      "Top-level widget-view MIME renders through OutputArea with fixture comm state. The widget catalog also covers OutputModel nested widget-view routing through MediaProvider; live comm replay remains outside this runtime-free page.",
  },
  {
    name: "Sift renderer frame wiring",
    reason:
      "The HuggingFace parquet URL and Arrow stream manifest paths now run through SiftTable and docs-served sift-wasm. Production isolated-frame asset loading remains a separate adapter slice.",
  },
];

const rendererBoundaryRows = [
  {
    surface: "Main DOM outputs",
    catalogPath: "direct component render",
    productionBoundary: "none",
    detail:
      "ANSI, JSON, image, math, SVG, audio, PDF, video, and traceback examples render through the current output components with static nbformat-like fixtures. MathOutput brings its own KaTeX stylesheet with the component import.",
  },
  {
    surface: "JavaScript output",
    catalogPath: "JavaScriptOutput fallback",
    productionBoundary: "isolated execution frame",
    detail:
      "The catalog shows the safe placeholder path only. It does not evaluate notebook JavaScript in the docs app.",
  },
  {
    surface: "Plotly, Vega, and GeoJSON",
    catalogPath: "docs fixture globals",
    productionBoundary: "renderer plugin execution",
    detail:
      "The component wrappers run against tiny deterministic Plotly, vegaEmbed, and Leaflet fixtures. Production renderer library loading remains an isolated-frame concern.",
  },
  {
    surface: "Sift parquet and Arrow",
    catalogPath: "docs-served WASM and fixture assets",
    productionBoundary: "daemon blobs and frame bootstrap",
    detail:
      "The visible SiftTable path is real, including the HuggingFace URL and Arrow stream manifest loaders; daemon blob URL signing stays outside this runtime-free page.",
  },
  {
    surface: "Widget-view outputs",
    catalogPath: "fixture WidgetStore",
    productionBoundary: "live comm capture and replay",
    detail:
      "OutputArea resolves widget-view MIME against local widget state. RuntimeStateDoc capture, comm replay, and shell transport are handled by the widget catalog boundary.",
  },
];

const stylesheetBoundaryRows = [
  {
    surface: "text/latex in main DOM",
    catalogPath: "MathOutput import",
    productionPath: "MathOutput import",
    detail:
      "The catalog imports the production component directly, so KaTeX markup and KaTeX CSS travel together. This keeps plain math output independent from global app or docs CSS.",
  },
  {
    surface: "markdown math in iframe",
    catalogPath: "docs IsolatedFrame adapter",
    productionPath: "MarkdownOutput inside isolated frame",
    detail:
      "MarkdownOutput also imports KaTeX CSS, but it must render inside a sandboxed output frame because markdown may include raw HTML.",
  },
  {
    surface: "renderer plugin CSS",
    catalogPath: "docs fixture CSS bytes",
    productionPath: "daemon renderer-plugin CSS route",
    detail:
      "The isolated output catalog covers plugin CSS fetch and install with fixture files. Production fetches CSS beside renderer plugin JavaScript from daemon asset routes.",
  },
];

function RendererCard({
  title,
  source,
  icon: Icon,
  children,
}: {
  title: string;
  source: string;
  icon: typeof Terminal;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-fd-border bg-fd-card">
      <div className="flex items-start justify-between gap-3 border-b border-fd-border p-4">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
              {source}
            </div>
          </div>
        </div>
        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
          rendered
        </span>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function seedOutputWidgetStore(store: WidgetStore) {
  for (const model of outputFixtures.widgetModels) {
    store.createModel(model.id, model.state);
  }
}

function OutputWidgetFixtureProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<WidgetStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createWidgetStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    seedOutputWidgetStore(store);
  }, [store]);

  const sendUpdate = useCallback(
    async (commId: string, state: Record<string, unknown>) => {
      store.updateModel(commId, state);
    },
    [store],
  );

  const sendCustom = useCallback(() => {}, []);

  const closeComm = useCallback(
    (commId: string) => {
      store.deleteModel(commId);
    },
    [store],
  );

  const contextValue = useMemo(
    () => ({
      store,
      sendUpdate,
      sendCustom,
      closeComm,
    }),
    [closeComm, sendCustom, sendUpdate, store],
  );

  return <WidgetStoreContext.Provider value={contextValue}>{children}</WidgetStoreContext.Provider>;
}

export function OutputRenderersExample() {
  const [siftState, setSiftState] = useState<TableEngineState | null>(null);
  const [siftUrlState, setSiftUrlState] = useState<TableEngineState | null>(null);
  const [siftManifestState, setSiftManifestState] = useState<TableEngineState | null>(null);
  const [siftUrlLoadMilestones, setSiftUrlLoadMilestones] = useState<SiftLoadMilestone[]>([]);
  const [siftManifestLoadMilestones, setSiftManifestLoadMilestones] = useState<SiftLoadMilestone[]>(
    [],
  );
  const [outputAreaMatchCount, setOutputAreaMatchCount] = useState(0);
  const handleSiftUrlLoadMilestone = useCallback((milestone: SiftLoadMilestone) => {
    setSiftUrlLoadMilestones((current) => [...current.slice(-7), milestone]);
  }, []);
  const handleSiftManifestLoadMilestone = useCallback((milestone: SiftLoadMilestone) => {
    setSiftManifestLoadMilestones((current) => [...current.slice(-7), milestone]);
  }, []);
  const visibleSiftUrlMilestones = visibleSiftMilestones(
    siftUrlLoadMilestones,
    expectedSiftUrlMilestones,
  );
  const visibleSiftManifestMilestones = visibleSiftMilestones(
    siftManifestLoadMilestones,
    expectedSiftManifestMilestones,
  );

  return (
    <div className="not-prose space-y-6" data-testid="output-renderers-example">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-100">
        <div className="flex items-start gap-3">
          <ListFilter className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Output fixture adapter</h2>
            <p className="mt-1 text-xs leading-5">
              These examples render current output components with static nbformat-like fixtures.
              OutputArea uses the docs isolated-frame adapter for iframe lanes, while widget comms,
              plugin injection, and production frame bootstrapping stay explicit adapter boundaries.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <RendererCard
          title="ANSI stream"
          source="src/components/outputs/ansi-output.tsx"
          icon={Terminal}
        >
          <AnsiStreamOutput
            streamName="stdout"
            text={[
              "\u001b[32mtraining\u001b[0m fold=01 mae=8.91",
              "\u001b[33mvalidating\u001b[0m fold=02 mae=8.42",
              "\u001b[34mexported\u001b[0m forecast.parquet",
            ].join("\n")}
          />
        </RendererCard>

        <RendererCard
          title="JSON tree"
          source="src/components/outputs/json-output.tsx"
          icon={Braces}
        >
          <JsonOutput data={outputFixtures.json} collapsed={2} />
        </RendererCard>

        <RendererCard
          title="Image output"
          source="src/components/outputs/image-output.tsx"
          icon={FileImage}
        >
          <ImageOutput data={imageDataUrl} mediaType="image/svg+xml" alt="Fixture line chart" />
        </RendererCard>

        <RendererCard
          title="Math output"
          source="src/components/outputs/math-output.tsx"
          icon={Braces}
        >
          <div className="rounded-md border border-fd-border bg-fd-background p-3">
            <MathOutput
              content={String.raw`$$\operatorname{MAE}=\frac{1}{n}\sum_{i=1}^{n}|y_i-\hat{y}_i|=8.42$$`}
            />
          </div>
        </RendererCard>

        <RendererCard
          title="SVG output"
          source="src/components/outputs/svg-output.tsx"
          icon={FileImage}
        >
          <div className="rounded-md border border-fd-border bg-fd-background p-3">
            <SvgOutput data={svgOutputFixture} />
          </div>
        </RendererCard>

        <RendererCard
          title="Audio output"
          source="src/components/outputs/audio-output.tsx"
          icon={FileAudio}
        >
          <div className="rounded-md border border-fd-border bg-fd-background p-3">
            <AudioOutput data={silentAudioDataUrl} mediaType="audio/wav" />
          </div>
        </RendererCard>

        <RendererCard
          title="JavaScript output boundary"
          source="src/components/outputs/javascript-output.tsx"
          icon={FileText}
        >
          <JavaScriptOutput code="element.textContent = 'executed in isolated iframe only';" />
        </RendererCard>

        <RendererCard
          title="Error fallback"
          source="src/components/outputs/ansi-output.tsx"
          icon={AlertTriangle}
        >
          <AnsiErrorOutput
            ename="RuntimeError"
            evalue="kernel interrupted while fitting model"
            traceback={[
              "\u001b[31mRuntimeError\u001b[0m: kernel interrupted while fitting model",
              '  File "cell://forecast-model", line 2, in <module>',
              "    model.fit(features[columns], target)",
            ]}
          />
        </RendererCard>
      </section>

      <RendererCard
        title="Plugin renderer fixtures"
        source="src/components/outputs/{plotly,vega,geojson,pdf,video}-output.tsx"
        icon={Database}
      >
        <RendererLibraryFixtureProvider>
          <div className="grid gap-3 lg:grid-cols-2" data-testid="plugin-renderer-surfaces">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="mb-2 text-xs font-semibold text-fd-muted-foreground">Plotly</div>
              <PlotlyOutput data={plotlyFixture} />
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="mb-2 text-xs font-semibold text-fd-muted-foreground">Vega-Lite</div>
              <VegaOutput data={vegaFixture} />
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3 lg:col-span-2">
              <div className="mb-2 text-xs font-semibold text-fd-muted-foreground">GeoJSON</div>
              <GeoJsonOutput data={geoJsonFixture} />
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="mb-2 text-xs font-semibold text-fd-muted-foreground">PDF</div>
              <PdfOutput data={pdfDataUrl} />
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="mb-2 text-xs font-semibold text-fd-muted-foreground">Video</div>
              <VideoOutput data={videoDataUrl} mediaType="video/mp4" />
            </div>
          </div>
        </RendererLibraryFixtureProvider>
      </RendererCard>

      <RendererCard
        title="Output area lanes"
        source="src/components/cell/OutputArea.tsx"
        icon={ListFilter}
      >
        <div className="space-y-3" data-testid="output-area-lanes-surface">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">
                Static output sequence
              </div>
              <div className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                Stream output stays in the document lane. HTML and parquet split into the docs
                isolated-frame adapter, matching the production lane policy without loading a
                runtime iframe bundle.
              </div>
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">Search fixture</div>
              <div className="mt-2 font-mono text-xs text-fd-foreground">
                query=fold · matches={outputAreaMatchCount}
              </div>
              <div className="mt-3 text-xs leading-5 text-fd-muted-foreground">
                Output hiding is a notebook-cell metadata state. The shared output lane stays
                expanded so renderer boundaries and search counts remain stable.
              </div>
            </div>
          </div>
          <div className="rounded-md border border-fd-border bg-background py-3">
            <OutputArea
              outputs={[...outputFixtures.outputAreaOutputs]}
              cellId="elements-output-area"
              executionCount={12}
              searchQuery="fold"
              onSearchMatchCount={setOutputAreaMatchCount}
              hostContext={{
                nteract: {
                  colorTheme: "classic",
                },
              }}
            />
          </div>
        </div>
      </RendererCard>

      <RendererCard
        title="Rich traceback"
        source="src/components/outputs/traceback-output.tsx"
        icon={FileWarning}
      >
        <TracebackOutput data={outputFixtures.traceback} />
      </RendererCard>

      <RendererCard
        title="Widget display output"
        source="apps/notebook/src/App.tsx + src/components/cell/OutputArea.tsx"
        icon={SlidersHorizontal}
      >
        <OutputWidgetFixtureProvider>
          <div className="space-y-3" data-testid="output-widget-view-surface">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">
                application/vnd.jupyter.widget-view+json
              </div>
              <div className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                The docs isolated-frame adapter receives the same payload shape that OutputArea
                sends to the production renderer frame, then resolves the model from a local
                WidgetStore fixture.
              </div>
            </div>
            <div className="rounded-md border border-fd-border bg-background py-3">
              <OutputArea
                outputs={[...outputFixtures.widgetOutputs]}
                cellId="elements-widget-output"
                executionCount={18}
                hostContext={{
                  nteract: {
                    colorTheme: "classic",
                  },
                }}
              />
            </div>
          </div>
        </OutputWidgetFixtureProvider>
      </RendererCard>

      <RendererCard title="Sift table renderer" source="packages/sift/src/react.tsx" icon={Table2}>
        <div className="space-y-3">
          <div className="h-[380px] min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <SiftTable data={siftData} onChange={setSiftState} />
          </div>
          <div className="grid gap-2 text-xs text-fd-muted-foreground md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              Static TableData mirrors the renderer handoff after parquet/Arrow bytes have been
              decoded.
            </div>
            <div className="font-mono">
              {siftState
                ? `${siftState.filteredCount}/${siftState.totalCount} rows`
                : `${siftParquetRows}/${siftParquetRows} rows`}
            </div>
          </div>
        </div>
      </RendererCard>

      <RendererCard title="Sift parquet URL" source="packages/sift/src/react.tsx" icon={Database}>
        <div className="space-y-4" data-testid="sift-parquet-url-surface">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">
                HuggingFace parquet source
              </div>
              <a
                href={siftParquetUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block break-words font-mono text-xs leading-5 text-fd-foreground [overflow-wrap:anywhere]"
              >
                {siftParquetUrl}
              </a>
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">Catalog source</div>
              <div className="mt-2 font-mono text-xs text-fd-foreground">source.kind = url</div>
              <div className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                The docs app serves Sift WASM as a static catalog asset, then lets the current
                SiftTable URL loader fetch and decode the Parquet file.
              </div>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            {visibleSiftUrlMilestones.map((milestone) => (
              <div
                key={milestone.key}
                className="rounded-md border border-fd-border bg-fd-background p-3"
              >
                <div className="text-xs font-semibold">{milestone.phase}</div>
                <div className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                  {milestone.value}
                </div>
              </div>
            ))}
          </div>

          <div className="h-[320px] min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <SiftTable
              source={{ kind: "url", url: siftParquetUrl }}
              onChange={setSiftUrlState}
              onLoadMilestone={handleSiftUrlLoadMilestone}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fd-muted-foreground">
            <span>
              This keeps the visible renderer on the Sift URL path while keeping daemon blob
              resolution and isolated-frame production bootstrapping outside the docs runtime.
            </span>
            <span className="font-mono">
              {siftUrlState
                ? `${siftUrlState.filteredCount}/${siftUrlState.totalCount} rows`
                : `${siftParquetRows}/${siftParquetRows} rows`}
            </span>
          </div>
        </div>
      </RendererCard>

      <RendererCard
        title="Sift Arrow stream manifest"
        source="packages/sift/src/react.tsx"
        icon={Database}
      >
        <div className="space-y-4" data-testid="sift-arrow-stream-manifest-surface">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">
                Arrow stream manifest
              </div>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fd-foreground">
                {JSON.stringify(siftArrowStreamManifest, null, 2)}
              </pre>
            </div>
            <div className="rounded-md border border-fd-border bg-fd-background p-3">
              <div className="text-xs font-medium text-fd-muted-foreground">Catalog source</div>
              <div className="mt-2 font-mono text-xs text-fd-foreground">
                source.kind = arrow-stream-manifest
              </div>
              <div className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                The manifest points at a docs-served Arrow IPC chunk and exercises SiftTable's
                appendable WASM store without daemon blob resolution.
              </div>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            {visibleSiftManifestMilestones.map((milestone) => (
              <div
                key={milestone.key}
                className="rounded-md border border-fd-border bg-fd-background p-3"
              >
                <div className="text-xs font-semibold">{milestone.phase}</div>
                <div className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                  {milestone.value}
                </div>
              </div>
            ))}
          </div>

          <div className="h-[320px] min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <SiftTable
              source={{ kind: "arrow-stream-manifest", manifest: siftArrowStreamManifest }}
              onChange={setSiftManifestState}
              onLoadMilestone={handleSiftManifestLoadMilestone}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fd-muted-foreground">
            <span>
              This covers the nteract Arrow stream manifest handoff while leaving production blob
              URL signing and isolated-frame asset bootstrapping outside the docs runtime.
            </span>
            <span className="font-mono">
              {siftManifestState
                ? `${siftManifestState.filteredCount}/${siftManifestState.totalCount} rows`
                : "manifest pending"}
            </span>
          </div>
        </div>
      </RendererCard>

      <section className="rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <h2 className="text-sm font-semibold">MIME Selection</h2>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            The table uses the production MIME priority helper, then marks whether the selected type
            can render in the main DOM or needs an isolated output adapter.
          </p>
        </div>
        <div className="divide-y divide-fd-border">
          {outputFixtures.mimeFixtures.map((fixture) => {
            const selected = selectMimeType(fixture.data);
            const safe = selected ? isSafeForMainDom(selected) : false;
            return (
              <div
                key={fixture.label}
                className="grid gap-2 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px]"
              >
                <div>
                  <div className="text-sm font-semibold">{fixture.label}</div>
                  <div className="mt-1 text-xs text-fd-muted-foreground">
                    {Object.keys(fixture.data).join(" · ")}
                  </div>
                </div>
                <div className="min-w-0 font-mono text-xs text-fd-muted-foreground [overflow-wrap:anywhere]">
                  {selected ?? "no displayable MIME"}
                </div>
                <div>
                  <span
                    className={[
                      "inline-flex rounded-full border px-2 py-1 text-[11px] font-medium",
                      safe
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                    ].join(" ")}
                  >
                    {safe ? "main DOM" : "iframe adapter"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <h2 className="text-sm font-semibold">Renderer Boundary Map</h2>
        <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
          The catalog separates visible component paths from production execution surfaces so output
          examples stay inspectable without booting notebook runtime, daemon, or iframe bundles.
        </p>
        <div className="mt-4 overflow-hidden rounded-md border border-fd-border">
          <div className="hidden grid-cols-[170px_180px_190px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground xl:grid">
            <span>Surface</span>
            <span>Catalog path</span>
            <span>Production boundary</span>
            <span>Notes</span>
          </div>
          {rendererBoundaryRows.map((row) => (
            <div
              key={row.surface}
              className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 xl:grid-cols-[170px_180px_190px_minmax(0,1fr)] xl:gap-3"
            >
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Surface
                </div>
                <div className="font-semibold">{row.surface}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Catalog path
                </div>
                <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                  {row.catalogPath}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Production boundary
                </div>
                <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                  {row.productionBoundary}
                </div>
              </div>
              <p className="leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Palette className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Stylesheet Boundaries</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            Renderer styles stay with the output surface that needs them. The catalog imports those
            production components or fixture plugin assets directly instead of relying on a global
            docs stylesheet.
          </p>
        </div>
        <div className="divide-y divide-fd-border">
          {stylesheetBoundaryRows.map((row) => (
            <div
              key={row.surface}
              className="grid gap-2 p-4 text-xs lg:grid-cols-[180px_200px_220px_minmax(0,1fr)] lg:gap-3"
            >
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground lg:hidden">
                  Surface
                </div>
                <div className="font-semibold">{row.surface}</div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground lg:hidden">
                  Catalog path
                </div>
                <div className="font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                  {row.catalogPath}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground lg:hidden">
                  Production path
                </div>
                <div className="font-mono text-[11px] text-amber-700 dark:text-amber-300">
                  {row.productionPath}
                </div>
              </div>
              <p className="leading-5 text-fd-muted-foreground">{row.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <h2 className="text-sm font-semibold">Rendered Components</h2>
          <div className="mt-4 space-y-3">
            {renderedPieces.map((piece) => (
              <div key={piece.name} className="border-l border-emerald-500/50 pl-3">
                <div className="text-sm font-semibold">{piece.name}</div>
                <div className="mt-1 font-mono text-[11px] text-fd-muted-foreground">
                  {piece.source}
                </div>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{piece.note}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4">
          <h2 className="text-sm font-semibold">Adapter Boundaries</h2>
          <div className="mt-4 space-y-3">
            {adapterBoundaries.map((boundary) => (
              <div key={boundary.name} className="border-l border-amber-500/50 pl-3">
                <div className="text-sm font-semibold">{boundary.name}</div>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">{boundary.reason}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
