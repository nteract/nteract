"use client";

import { NotebookHostProvider } from "@nteract/notebook-host";
import { FileSearch, History, Search, TextCursorInput } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { HistoryEntry, NotebookRequest, NotebookResponse } from "runtimed";
import { Button } from "@/components/ui/button";
import { createFixtureNotebookHost } from "@/components/fixture-notebook-host";
import { GlobalFindBar } from "@/notebook-components/GlobalFindBar";
import { HistorySearchDialog } from "@/notebook-components/HistorySearchDialog";

const notebookCells = [
  {
    id: "cell-imports",
    label: "cell 1",
    source: [
      "from datasets import load_dataset",
      "import pandas as pd",
      "from sklearn.ensemble import RandomForestRegressor",
    ].join("\n"),
  },
  {
    id: "cell-features",
    label: "cell 2",
    source: [
      "features = orders.assign(month=orders.date.dt.month)",
      "model.fit(features[columns], target)",
      "predictions = model.predict(features_holdout)",
      "display(predictions.head())",
    ].join("\n"),
  },
  {
    id: "cell-review",
    label: "cell 3",
    source: [
      "summary = predictions.groupby(features.region).mean()",
      "summary.sort_values('forecast_error').tail()",
    ].join("\n"),
  },
];

const fixtureHistoryEntries: HistoryEntry[] = [
  {
    session: 24,
    line: 83,
    source: [
      "features = orders.assign(month=orders.date.dt.month)",
      "model.fit(features[columns], target)",
      "predictions = model.predict(features_holdout)",
    ].join("\n"),
  },
  {
    session: 24,
    line: 71,
    source: [
      "columns = ['country', 'competition', 'problem_length']",
      "features = ds_slice.to_pandas()[columns]",
    ].join("\n"),
  },
  {
    session: 23,
    line: 18,
    source: [
      "history = client.get_history(pattern='features', n=100, unique=True)",
      "len(history)",
    ].join("\n"),
  },
  {
    session: 21,
    line: 4,
    source: [
      "from datasets import load_dataset",
      "ds_slice = load_dataset('ShadenA/MathNet', 'all', split='train')",
    ].join("\n"),
  },
];

function isGetHistoryRequest(
  request: unknown,
): request is Extract<NotebookRequest, { type: "get_history" }> {
  return (
    typeof request === "object" &&
    request !== null &&
    "type" in request &&
    request.type === "get_history"
  );
}

function filterHistoryEntries({
  pattern,
  n,
  unique,
}: Extract<NotebookRequest, { type: "get_history" }>) {
  const needle = pattern?.split("*").join("").trim().toLowerCase() ?? "";
  const filtered = needle
    ? fixtureHistoryEntries.filter((entry) => entry.source.toLowerCase().includes(needle))
    : fixtureHistoryEntries;

  const entries = unique
    ? filtered.filter(
        (entry, index, list) =>
          list.findIndex((candidate) => candidate.source === entry.source) === index,
      )
    : filtered;

  return entries.slice(0, n);
}

const historyFixtureHost = createFixtureNotebookHost({
  name: "elements-history-fixture",
  transport: {
    sendRequest: async (request): Promise<NotebookResponse> => {
      if (isGetHistoryRequest(request)) {
        return { result: "history_result", entries: filterHistoryEntries(request) };
      }

      throw new Error("Search fixture host only handles get_history requests.");
    },
  },
});

const searchBoundaryRows = [
  {
    boundary: "Find state projection",
    catalogPath: "notebookCells[] + GlobalFindBar props",
    productionBoundary: "NotebookView cell sources, focus, and selection",
    detail:
      "The catalog owns static cell text and match counts. The notebook app still owns live cell projection, keyboard shortcuts, focus restoration, and editor selections.",
  },
  {
    boundary: "History transport",
    catalogPath: "createFixtureNotebookHost(get_history)",
    productionBoundary: "NotebookHost -> runtimed history request",
    detail:
      "HistorySearchDialog stays on the real hook path. The docs host answers only typed get_history requests and never opens a daemon or kernel session.",
  },
  {
    boundary: "Selection handoff",
    catalogPath: "setSelectedHistorySource",
    productionBoundary: "focused editor insertion",
    detail:
      "Selecting history updates local preview state here. Production inserts the selected source into the focused notebook editor through the notebook host.",
  },
  {
    boundary: "Match navigation",
    catalogPath: "inert next/previous callbacks",
    productionBoundary: "cell scroll and active-match focus",
    detail:
      "The fixture cycles a counter so the toolbar surface is interactive. Production navigation scrolls to matched cells and keeps active match state synchronized with editors.",
  },
];

function countMatches(source: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  let count = 0;
  let cursor = 0;
  const haystack = source.toLowerCase();
  while (cursor < haystack.length) {
    const next = haystack.indexOf(needle, cursor);
    if (next === -1) break;
    count += 1;
    cursor = next + needle.length;
  }
  return count;
}

function HighlightedLine({ line, query }: { line: string; query: string }) {
  const needle = query.trim();
  if (!needle) return line;

  const lowerLine = line.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: ReactNode[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const next = lowerLine.indexOf(lowerNeedle, cursor);
    if (next === -1) {
      segments.push(line.slice(cursor));
      break;
    }

    if (next > cursor) {
      segments.push(line.slice(cursor, next));
    }

    segments.push(
      <mark key={`${line}-${next}`} className="rounded-sm bg-amber-300/70 px-0.5 text-foreground">
        {line.slice(next, next + needle.length)}
      </mark>,
    );
    cursor = next + needle.length;
  }

  return <>{segments}</>;
}

export function SearchSurfacesExample() {
  const [findOpen, setFindOpen] = useState(true);
  const [query, setQuery] = useState("features");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedHistorySource, setSelectedHistorySource] = useState(
    fixtureHistoryEntries[0].source,
  );

  const matchCount = useMemo(
    () => notebookCells.reduce((total, cell) => total + countMatches(cell.source, query), 0),
    [query],
  );

  useEffect(() => {
    if (currentMatchIndex >= matchCount) {
      setCurrentMatchIndex(0);
    }
  }, [currentMatchIndex, matchCount]);

  return (
    <div className="not-prose space-y-5" data-elements-slot="search-surfaces">
      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="grid gap-3 border-b border-fd-border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-fd-muted-foreground">
              <Search className="size-4" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-fd-foreground">GlobalFindBar</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              Rendered from the notebook app with fixture notebook text and inert navigation
              callbacks.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setFindOpen(true)}>
            Show find bar
          </Button>
        </div>
        <div className="bg-background">
          {findOpen ? (
            <GlobalFindBar
              query={query}
              matchCount={matchCount}
              currentMatchIndex={currentMatchIndex}
              onQueryChange={(nextQuery) => {
                setQuery(nextQuery);
                setCurrentMatchIndex(0);
              }}
              onNextMatch={() =>
                setCurrentMatchIndex((index) => (matchCount ? (index + 1) % matchCount : 0))
              }
              onPrevMatch={() =>
                setCurrentMatchIndex((index) =>
                  matchCount ? (index - 1 + matchCount) % matchCount : 0,
                )
              }
              onClose={() => setFindOpen(false)}
            />
          ) : (
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>Notebook find is closed.</span>
              <button
                type="button"
                className="font-medium text-foreground"
                onClick={() => setFindOpen(true)}
              >
                Reopen
              </button>
            </div>
          )}

          <div className="divide-y divide-border">
            {notebookCells.map((cell) => (
              <article key={cell.id} className="grid gap-3 p-4 md:grid-cols-[84px_minmax(0,1fr)]">
                <div className="font-mono text-xs text-muted-foreground">{cell.label}</div>
                <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs leading-6 text-foreground">
                  {cell.source.split("\n").map((line, index) => (
                    <span key={`${cell.id}-${index}`}>
                      <HighlightedLine line={line} query={query} />
                      {index < cell.source.split("\n").length - 1 ? "\n" : null}
                    </span>
                  ))}
                </pre>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="grid gap-3 border-b border-fd-border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-fd-muted-foreground">
              <History className="size-4" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-fd-foreground">HistorySearchDialog</h2>
            </div>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
              Rendered from the notebook app under a fixture host whose transport only answers typed
              `get_history` requests.
            </p>
          </div>
          <NotebookHostProvider host={historyFixtureHost}>
            <Button size="sm" onClick={() => setHistoryOpen(true)}>
              Open history search
            </Button>
            <HistorySearchDialog
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              onSelect={setSelectedHistorySource}
              initialQuery={query}
            />
          </NotebookHostProvider>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex items-start gap-2 text-fd-muted-foreground">
            <TextCursorInput className="mt-0.5 size-4" aria-hidden="true" />
            <div>
              <h3 className="text-sm font-semibold text-fd-foreground">Selected history source</h3>
              <p className="mt-2 text-xs leading-5">
                Choosing a command in the dialog feeds the same source string the notebook inserts
                into an editor.
              </p>
            </div>
          </div>
          <pre className="min-w-0 overflow-x-auto whitespace-pre-wrap rounded-md border border-fd-border bg-fd-background p-3 font-mono text-xs leading-6 text-fd-foreground">
            {selectedHistorySource}
          </pre>
        </div>
      </section>

      <section className="rounded-lg border border-dashed border-fd-border bg-fd-background p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileSearch className="size-4 text-fd-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Adapter boundary</h2>
        </div>
        <p className="text-xs leading-5 text-fd-muted-foreground">
          Search is rendered through current notebook components, but the docs app owns only static
          cell text, deterministic history entries, and inert handoff callbacks. Live notebook
          projection, daemon history, focus, and editor insertion stay behind app adapters.
        </p>
        <div className="mt-4 overflow-hidden rounded-md border border-fd-border bg-fd-card">
          <div className="hidden grid-cols-[190px_230px_230px_minmax(0,1fr)] gap-3 border-b border-fd-border bg-fd-muted/40 px-3 py-2 text-[11px] font-medium uppercase text-fd-muted-foreground xl:grid">
            <span>Boundary</span>
            <span>Catalog path</span>
            <span>Production boundary</span>
            <span>Notes</span>
          </div>
          {searchBoundaryRows.map((row) => (
            <div
              key={row.boundary}
              className="grid gap-2 border-b border-fd-border px-3 py-3 text-xs last:border-b-0 xl:grid-cols-[190px_230px_230px_minmax(0,1fr)] xl:gap-3"
            >
              <div>
                <div className="text-[11px] font-medium uppercase text-fd-muted-foreground xl:hidden">
                  Boundary
                </div>
                <div className="font-semibold">{row.boundary}</div>
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
    </div>
  );
}
