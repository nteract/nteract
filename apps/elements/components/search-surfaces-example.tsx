"use client";

import { NotebookHostProvider } from "@nteract/notebook-host";
import { History, Search, TextCursorInput } from "lucide-react";
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
    </div>
  );
}
