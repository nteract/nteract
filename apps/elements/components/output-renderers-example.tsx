"use client";

import { AlertTriangle, Braces, FileImage, FileWarning, ListFilter, Terminal } from "lucide-react";
import { AnsiErrorOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
import { ImageOutput } from "@/components/outputs/image-output";
import { JsonOutput } from "@/components/outputs/json-output";
import { selectMimeType } from "@/components/outputs/mime-priority";
import { isSafeForMainDom } from "@/components/outputs/safe-mime-types";
import { TracebackOutput } from "@/components/outputs/traceback-output";

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
    name: "TracebackOutput",
    source: "src/components/outputs/traceback-output.tsx",
    note: "nteract-owned structured traceback renderer with source context and copy affordance.",
  },
];

const adapterBoundaries = [
  {
    name: "OutputArea",
    reason:
      "Owns output focus, scroll handoff, iframe sizing, search highlighting, and widget bridge wiring.",
  },
  {
    name: "IsolatedFrame",
    reason:
      "Required for HTML, markdown with raw HTML, SVG insertion, JavaScript, Plotly, Vega, and GeoJSON plugin surfaces.",
  },
  {
    name: "Widget output",
    reason:
      "Needs fixture-backed WidgetStore and saved widget state before controls can be shown without kernel comm state.",
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
  return (
    <div className="not-prose space-y-6" data-testid="output-renderers-example">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-sky-900 dark:text-sky-100">
        <div className="flex items-start gap-3">
          <ListFilter className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Output fixture adapter</h2>
            <p className="mt-1 text-xs leading-5">
              These examples render current output components directly with static nbformat-like
              fixtures. The iframe and widget paths stay documented as adapter boundaries until the
              docs app has a runtime-free isolation fixture.
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
        title="Rich traceback"
        source="src/components/outputs/traceback-output.tsx"
        icon={FileWarning}
      >
        <TracebackOutput data={tracebackFixture} />
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
