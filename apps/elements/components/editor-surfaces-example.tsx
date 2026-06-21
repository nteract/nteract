"use client";

import {
  Braces,
  Code2,
  FileCode2,
  GitPullRequestArrow,
  Languages,
  Search,
  Sparkles,
  TextCursorInput,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColorTheme } from "@/components/editor/static-highlight";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { detectCellMagic, getCellMagicLanguage } from "@/components/editor/ipython";
import { languageDisplayNames, type SupportedLanguage } from "@/components/editor/languages";
import { ReadOnlyCodeMirror } from "@/components/editor/readonly-codemirror";
import {
  peerColor,
  remoteCursorsExtension,
  setRemoteCursors,
  setRemoteSelections,
} from "@/components/editor/remote-cursors";
import { searchHighlight } from "@/components/editor/search-highlight";
import { StaticCodeBlock } from "@/components/editor/static-highlight";
import {
  addTextAttributions,
  textAttributionExtension,
} from "@/components/editor/text-attribution";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import {
  getElementsNotebookPrimaryCodeCell,
  getElementsNotebookScenario,
  resolveElementsNotebookLanguage,
} from "@/components/notebook-scenarios";
import { Eyebrow, SurfaceFrame } from "@/components/surface-primitives";

type SampleKey = "python" | "sql" | "markdown" | "json";

const editorScenario = getElementsNotebookScenario("desktop-local-owner");
const scenarioCodeCell = getElementsNotebookPrimaryCodeCell(editorScenario.cells);
const scenarioCodeLanguage = resolveElementsNotebookLanguage(scenarioCodeCell.language) ?? "plain";
const readOnlyScenarioCell =
  editorScenario.cells.find((cell) => cell.id === "cell-findings") ?? scenarioCodeCell;
const readOnlyScenarioLanguage =
  resolveElementsNotebookLanguage(readOnlyScenarioCell.language) ?? "plain";

const codeSamples: Record<
  SampleKey,
  { label: string; language: SupportedLanguage; search: string; source: string }
> = {
  python: {
    label: "Python",
    language: scenarioCodeLanguage,
    search: "features",
    source: scenarioCodeCell.source,
  },
  sql: {
    label: "SQL",
    language: "sql",
    search: "revenue",
    source: `select
  date_trunc('week', order_date) as week,
  sum(revenue) as revenue
from mart.orders
group by 1
order by 1`,
  },
  markdown: {
    label: "Markdown",
    language: "markdown",
    search: "forecast",
    source: `## Forecast notes

- Hold out the most recent 16 weeks.
- Compare forecast drift by product line.
- Keep the notebook narrative close to the output.`,
  },
  json: {
    label: "JSON",
    language: "json",
    search: "metrics",
    source: `{
  "run": "forecast-042",
  "status": "complete",
  "metrics": {
    "mae": 8.42,
    "mape": 0.068
  }
}`,
  },
};

const renderedPieces = [
  {
    name: "CodeMirrorEditor",
    source: "src/components/editor/codemirror-editor.tsx",
    detail:
      "Editable notebook source surface with current language, theme, keymap, and extension compartments.",
  },
  {
    name: "ReadOnlyCodeMirror",
    source: "src/components/editor/readonly-codemirror.tsx",
    detail: "Read-only source view used by notebook/report surfaces through the same editor shell.",
  },
  {
    name: "StaticCodeBlock",
    source: "src/components/editor/static-highlight.tsx",
    detail: "Lezer-backed static highlighting for contexts that cannot own a live EditorView.",
  },
  {
    name: "searchHighlight",
    source: "src/components/editor/search-highlight.ts",
    detail: "Current global-find highlight decorations rendered against fixture source.",
  },
  {
    name: "remoteCursorsExtension",
    source: "src/components/editor/remote-cursors.ts",
    detail: "Runtime-free peer cursor and selection decorations pushed into the EditorView.",
  },
  {
    name: "textAttributionExtension",
    source: "src/components/editor/text-attribution.ts",
    detail: "Imperative attribution marks for notebook source ownership and delegated edits.",
  },
];

const adapterBoundaries = [
  {
    name: "useCrdtBridge",
    reason:
      "Requires generated WASM and notebook sync state; the catalog should receive fixture source changes instead.",
  },
  {
    name: "kernelCompletionExtension",
    reason:
      "Queries the active runtime for completions and needs a kernel-backed adapter before rendering here.",
  },
  {
    name: "presenceSenderExtension",
    reason:
      "Publishes local selection frames through the presence bus; this page only renders static peer state.",
  },
  {
    name: "editor registry",
    reason:
      "Coordinates app-level focus navigation and should stay outside standalone docs examples.",
  },
];

const scenarioFacts = [
  {
    label: "scenario",
    value: editorScenario.title,
  },
  {
    label: "cell",
    value: scenarioCodeCell.id,
  },
  {
    label: "execution",
    value:
      scenarioCodeCell.executionCount === null
        ? "not run"
        : `run ${scenarioCodeCell.executionCount}`,
  },
];

const magicSource = `%%sql
select country, count(*) as notebooks
from public_sessions
group by country
order by notebooks desc`;

const languageMatrix: { filename: string; language: SupportedLanguage; note: string }[] = [
  {
    filename: `${scenarioCodeCell.id}.py`,
    language: scenarioCodeLanguage,
    note: "Shared Elements notebook scenario model cell",
  },
  { filename: "analysis.py", language: "python", note: "PEP 8 indentation and Python parser" },
  { filename: "query.sql", language: "sql", note: "SQL parser for cell magics and database cells" },
  { filename: "notes.md", language: "markdown", note: "Markdown parser for source previews" },
  { filename: "state.json", language: "json", note: "Structured metadata and renderer fixtures" },
];

function range(source: string, needle: string) {
  const from = source.indexOf(needle);
  return from === -1 ? { from: 0, to: 0 } : { from, to: from + needle.length };
}

function RenderedBadge() {
  return (
    <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">rendered</span>
  );
}

export function EditorSurfacesExample() {
  const [sampleKey, setSampleKey] = useState<SampleKey>("python");
  const [draftSource, setDraftSource] = useState(codeSamples.python.source);
  const isDark = useDarkMode();
  const documentColorTheme = useColorTheme();
  const mode = isDark ? "dark" : "light";
  const colorTheme: ColorTheme = documentColorTheme === "cream" ? "cream" : "classic";
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const sample = codeSamples[sampleKey];
  const activeOffset = useMemo(
    () => sample.source.toLowerCase().indexOf(sample.search.toLowerCase()),
    [sample.search, sample.source],
  );
  const editorExtensions = useMemo(
    () => [
      ...searchHighlight(sample.search, activeOffset),
      ...remoteCursorsExtension(),
      ...textAttributionExtension(),
    ],
    [activeOffset, sample.search],
  );

  useEffect(() => {
    setDraftSource(sample.source);
  }, [sample.source]);

  useEffect(() => {
    let frame = 0;
    let attempts = 0;

    const applyFixtureState = () => {
      const view = editorRef.current?.getEditor();
      if (!view) {
        attempts += 1;
        if (attempts < 20) {
          frame = window.requestAnimationFrame(applyFixtureState);
        }
        return;
      }

      setRemoteCursors(view, [
        {
          peerId: "designer",
          peerLabel: "Ari",
          line: 1,
          column: 10,
          color: peerColor("designer"),
        },
        {
          peerId: "agent",
          peerLabel: "Codex",
          line: 2,
          column: 14,
          color: peerColor("agent"),
        },
      ]);
      setRemoteSelections(view, [
        {
          peerId: "reviewer",
          peerLabel: "Review",
          anchorLine: 0,
          anchorCol: 0,
          headLine: 0,
          headCol: Math.min(20, sample.source.split("\n")[0]?.length ?? 0),
          color: peerColor("reviewer"),
        },
      ]);

      const featureRange = range(sample.source, sample.search);
      if (featureRange.to > featureRange.from) {
        addTextAttributions(view, [
          {
            ...featureRange,
            actors: ["fixture peer"],
            color: peerColor("fixture peer"),
          },
        ]);
      }
    };

    frame = window.requestAnimationFrame(applyFixtureState);
    return () => window.cancelAnimationFrame(frame);
  }, [sample.search, sample.source]);

  const detectedMagic = detectCellMagic(magicSource);
  const magicLanguage = detectedMagic ? getCellMagicLanguage(detectedMagic) : "plain";

  return (
    <div className="not-prose space-y-6" data-testid="editor-surfaces-example">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <TextCursorInput className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Editor fixture adapter</h2>
            <p className="mt-1 text-xs leading-5">
              This page renders current editor components from the shared Elements notebook
              scenario. Runtime sync, presence sending, kernel completion, and focus registry
              behavior stay documented as adapter boundaries until they can be fed without notebook
              host state.
            </p>
          </div>
        </div>
      </section>

      <SurfaceFrame
        title="Live source editor"
        source="src/components/editor/codemirror-editor.tsx"
        icon={<Code2 aria-hidden="true" />}
        badge={<RenderedBadge />}
        bodyClassName="space-y-4 p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(codeSamples).map(([key, value]) => (
            <button
              key={key}
              type="button"
              aria-pressed={sampleKey === key}
              onClick={() => setSampleKey(key as SampleKey)}
              className={[
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                sampleKey === key
                  ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                  : "border-fd-border bg-fd-background text-fd-muted-foreground hover:bg-fd-muted",
              ].join(" ")}
            >
              {value.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-fd-border" aria-hidden="true" />
          <span className="text-xs font-medium capitalize text-fd-muted-foreground">
            {mode} / {colorTheme}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {scenarioFacts.map((fact) => (
            <div
              key={fact.label}
              className="rounded-md border border-fd-border bg-fd-background px-3 py-2"
            >
              <Eyebrow>{fact.label}</Eyebrow>
              <div className="mt-1 break-words font-mono text-[11px] leading-4">{fact.value}</div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Languages className="size-3.5" aria-hidden="true" />
              <span>{languageDisplayNames[sample.language]}</span>
              <span aria-hidden="true">·</span>
              <span>search: {sample.search}</span>
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">
              {draftSource.length} chars
            </div>
          </div>
          <CodeMirrorEditor
            key={`${sampleKey}-${mode}-${colorTheme}`}
            ref={editorRef}
            initialValue={sample.source}
            language={sample.language}
            lineWrapping
            extensions={editorExtensions}
            onValueChange={setDraftSource}
            className="min-h-52"
          />
        </div>
      </SurfaceFrame>

      <section className="grid gap-4 lg:grid-cols-2">
        <SurfaceFrame
          title="Read-only source"
          source="src/components/editor/readonly-codemirror.tsx"
          icon={<FileCode2 aria-hidden="true" />}
          badge={<RenderedBadge />}
          bodyClassName="p-4"
        >
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <ReadOnlyCodeMirror
              value={readOnlyScenarioCell.source}
              language={readOnlyScenarioLanguage}
              lineWrapping
              className="min-h-36"
            />
          </div>
        </SurfaceFrame>

        <SurfaceFrame
          title="Static highlighting"
          source="src/components/editor/static-highlight.tsx"
          icon={<Braces aria-hidden="true" />}
          badge={<RenderedBadge />}
          bodyClassName="space-y-3 p-4"
        >
          <StaticCodeBlock
            code={magicSource}
            language={magicLanguage}
            isDark={mode === "dark"}
            colorTheme={colorTheme}
          />
          <div className="rounded-md border border-fd-border bg-fd-background px-3 py-2 text-xs text-fd-muted-foreground">
            IPython cell magic <span className="font-mono">%%{detectedMagic}</span> resolves to{" "}
            <span className="font-mono">{magicLanguage}</span> for static preview.
          </div>
        </SurfaceFrame>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Rendered Editor Pieces</h2>
            </div>
          </div>
          <div className="divide-y divide-fd-border">
            {renderedPieces.map((piece) => (
              <div key={piece.name} className="p-4">
                <div className="text-sm font-semibold">{piece.name}</div>
                <div className="mt-1 break-words font-mono text-[11px] text-fd-muted-foreground [overflow-wrap:anywhere]">
                  {piece.source}
                </div>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{piece.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card">
          <div className="border-b border-fd-border p-4">
            <div className="flex items-center gap-2">
              <GitPullRequestArrow className="size-4 text-fd-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Adapter Boundaries</h2>
            </div>
          </div>
          <div className="divide-y divide-fd-border">
            {adapterBoundaries.map((boundary) => (
              <div key={boundary.name} className="p-4">
                <div className="text-sm font-semibold">{boundary.name}</div>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{boundary.reason}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Search className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Language Matrix</h2>
          </div>
        </div>
        <div className="divide-y divide-fd-border">
          {languageMatrix.map((item) => (
            <div
              key={item.filename}
              className="grid gap-2 p-4 md:grid-cols-[160px_150px_minmax(0,1fr)]"
            >
              <div className="font-mono text-xs text-fd-muted-foreground">{item.filename}</div>
              <div className="text-xs font-medium">{languageDisplayNames[item.language]}</div>
              <div className="text-xs leading-5 text-fd-muted-foreground">{item.note}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
