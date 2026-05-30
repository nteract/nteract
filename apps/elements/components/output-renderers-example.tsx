"use client";

import { SiftTable, type TableData, type TableEngineState } from "@nteract/sift";
import {
  AlertTriangle,
  Braces,
  Database,
  FileAudio,
  FileImage,
  FileText,
  FileWarning,
  ListFilter,
  Table2,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { OutputArea, type JupyterOutput } from "@/components/cell/OutputArea";

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

const jsonFixture = {
  run: {
    id: "forecast-042",
    status: "complete",
    metrics: {
      mae: 8.42,
      mape: 0.068,
      backtestWeeks: 16,
    },
  },
  artifacts: ["forecast.parquet", "diagnostics.json"],
};

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

const siftParquetUrl =
  "https://huggingface.co/datasets/mstz/heart_failure/resolve/refs%2Fconvert%2Fparquet/death/train/0000.parquet";

const siftUrlMilestones = [
  {
    phase: "Resolve",
    value: "mstz/heart_failure - death/train/0000.parquet",
  },
  {
    phase: "Fetch",
    value: "12 KB parquet source from HuggingFace",
  },
  {
    phase: "Decode boundary",
    value: "generated sift-wasm load_parquet_row_group",
  },
  {
    phase: "Render",
    value: "SiftTable mounted with fixture TableData",
  },
];

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

const tracebackFixture = {
  ename: "ValueError",
  evalue: "feature matrix contains null values",
  language: "python",
  text: `ValueError: feature matrix contains null values
  at cell forecast-model line 3`,
  execution: {
    execution_id: "exec-042",
    cell_id: "forecast-model",
    execution_count: 12,
  },
  frames: [
    {
      filename: "cell://forecast-model",
      lineno: 3,
      name: "<module>",
      execution_id: "exec-042",
      cell_id: "forecast-model",
      execution_count: 12,
      lines: [
        { lineno: 1, source: "features = orders.assign(month=orders.date.dt.month)" },
        { lineno: 2, source: "model.fit(features[columns], target)" },
        { lineno: 3, source: "predictions = model.predict(features_holdout)", highlight: true },
      ],
    },
    {
      filename: "/workspace/forecasting/model.py",
      lineno: 88,
      name: "predict",
      library: true,
      lines: [
        { lineno: 86, source: "def predict(self, frame):" },
        { lineno: 87, source: "    if frame.isna().any().any():" },
        {
          lineno: 88,
          source: "        raise ValueError('feature matrix contains null values')",
          highlight: true,
        },
      ],
    },
  ],
};

const outputAreaFixtures: JupyterOutput[] = [
  {
    output_id: "output-area-stream",
    output_type: "stream",
    name: "stdout",
    text: "loaded 22,767 rows\nvalidated fold 02 with mae=8.42\n",
  },
  {
    output_id: "output-area-html",
    output_type: "display_data",
    data: {
      "text/html": "<strong>unsafe HTML fixture</strong>",
      "text/plain": "unsafe HTML fixture",
    },
    metadata: {},
  },
  {
    output_id: "output-area-parquet",
    output_type: "display_data",
    data: {
      "application/vnd.apache.parquet": {
        url: siftParquetUrl,
        rows: siftData.rowCount,
      },
      "text/plain": "heart_failure parquet fixture",
    },
    metadata: {},
  },
];

const mimeFixtures = [
  {
    label: "Rich traceback beats text",
    data: {
      "text/plain": "ValueError: feature matrix contains null values",
      "application/vnd.nteract.traceback+json": tracebackFixture,
    },
  },
  {
    label: "HTML requires isolation",
    data: {
      "text/html": "<table><tr><td>8.42</td></tr></table>",
      "text/plain": "MAE 8.42",
    },
  },
  {
    label: "Preview-only text is skipped",
    data: {
      "text/llm+plain": "internal model preview",
      "text/plain": "visible fallback",
    },
  },
  {
    label: "Structured JSON stays inspectable",
    data: {
      "application/json": jsonFixture,
      "text/plain": JSON.stringify(jsonFixture),
    },
  },
];

const renderedPieces = [
  {
    name: "OutputArea",
    source: "src/components/cell/OutputArea.tsx",
    note: "Notebook output lane composition, collapse control, DOM-vs-isolated segmentation, and search count plumbing rendered with static outputs.",
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
    note: "Expandable notebook JSON tree using the current shadcn Collapsible primitive.",
  },
  {
    name: "ImageOutput",
    source: "src/components/outputs/image-output.tsx",
    note: "Notebook media frame with data URL and preload handling.",
  },
  {
    name: "MathOutput",
    source: "src/components/outputs/math-output.tsx",
    note: "KaTeX-backed text/latex rendering that is safe in the main output lane.",
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
    note: "nteract-owned Arrow/parquet table UI rendered here with static TableData and a fixture-backed URL handoff.",
  },
];

const adapterBoundaries = [
  {
    name: "IsolatedFrame",
    reason:
      "Required in production for HTML, markdown with raw HTML, executable JavaScript, and renderer library bootstrap. This page uses deterministic fixture globals for visible Plotly, Vega, and GeoJSON component paths.",
  },
  {
    name: "Widget output",
    reason:
      "Needs fixture-backed WidgetStore and saved widget state before controls can be shown without kernel comm state.",
  },
  {
    name: "Generated Sift WASM decode",
    reason:
      "Parquet and Arrow URL bytes still need generated sift-wasm glue and a served WASM asset; this catalog shows the URL handoff with decoded TableData until the docs app owns that asset path.",
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

export function OutputRenderersExample() {
  const [siftState, setSiftState] = useState<TableEngineState | null>(null);
  const [siftUrlState, setSiftUrlState] = useState<TableEngineState | null>(null);
  const [outputAreaCollapsed, setOutputAreaCollapsed] = useState(false);
  const [outputAreaMatchCount, setOutputAreaMatchCount] = useState(0);

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
              plugin injection, and generated WASM stay explicit adapter boundaries.
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
          <JsonOutput data={jsonFixture} collapsed={2} />
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
            <MathOutput content="$$\\operatorname{MAE}=\\frac{1}{n}\\sum_{i=1}^{n}|y_i-\\hat{y}_i|=8.42$$" />
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
              <button
                type="button"
                className="mt-3 rounded-md border border-fd-border px-2 py-1 text-xs font-medium text-fd-foreground transition-colors hover:bg-fd-muted"
                onClick={() => setOutputAreaCollapsed((value) => !value)}
              >
                {outputAreaCollapsed ? "Show outputs" : "Collapse outputs"}
              </button>
            </div>
          </div>
          <div className="rounded-md border border-fd-border bg-background py-3">
            <OutputArea
              outputs={outputAreaFixtures}
              cellId="elements-output-area"
              executionCount={12}
              collapsed={outputAreaCollapsed}
              onToggleCollapse={() => setOutputAreaCollapsed((value) => !value)}
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
        <TracebackOutput data={tracebackFixture} />
      </RendererCard>

      <RendererCard title="Sift table renderer" source="packages/sift/src/react.tsx" icon={Table2}>
        <div className="space-y-3">
          <div className="h-[380px] min-w-0 overflow-hidden rounded-md border border-fd-border bg-fd-background">
            <SiftTable data={siftData} onChange={setSiftState} />
          </div>
          <div className="grid gap-2 text-xs text-fd-muted-foreground md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              Static TableData mirrors the renderer handoff after parquet/Arrow bytes have been
              decoded. The generated WASM decode path is still tracked as an adapter boundary.
            </div>
            <div className="font-mono">
              {siftState
                ? `${siftState.filteredCount}/${siftState.totalCount} rows`
                : `${siftData.rowCount}/${siftData.rowCount} rows`}
            </div>
          </div>
        </div>
      </RendererCard>

      <RendererCard
        title="Sift parquet URL handoff"
        source="packages/sift/src/react.tsx"
        icon={Database}
      >
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
              <div className="mt-2 font-mono text-xs text-fd-foreground">
                source.kind = table-data
              </div>
              <div className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                The URL is real; the docs surface stays runtime-free by rendering the decoded table
                fixture.
              </div>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            {siftUrlMilestones.map((milestone) => (
              <div
                key={milestone.phase}
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
            <SiftTable source={{ kind: "table-data", data: siftData }} onChange={setSiftUrlState} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fd-muted-foreground">
            <span>
              This keeps the visible renderer faithful to the Sift UI while keeping network, blob,
              and generated WASM concerns outside the docs runtime.
            </span>
            <span className="font-mono">
              {siftUrlState
                ? `${siftUrlState.filteredCount}/${siftUrlState.totalCount} rows`
                : `${siftData.rowCount}/${siftData.rowCount} rows`}
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
          {mimeFixtures.map((fixture) => {
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
