import { SiftTable, type TableData, type TableEngine, type TableEngineState } from "@nteract/sift";
import "@nteract/sift/style.css";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureModule, getModuleSync, loadIpc } from "../../../../packages/sift/src/predicate";
import { createWasmTableData } from "../../../../packages/sift/src/wasm-table-data";
import type {
  InsertTablePayload,
  PluginToUiMessage,
  SiftSourceMetadata,
  UiToPluginMessage,
} from "../shared";
import "./style.css";

const DEMO_URL = "https://huggingface.co/datasets/spotify/resolve/main/data.parquet";
const MAX_INSERT_ROWS = 40;
const MAX_INSERT_COLUMNS = 10;

type LoadedTable = {
  data: TableData;
  source: SiftSourceMetadata;
};

type LoadStatus =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };

function App() {
  const [url, setUrl] = useState(DEMO_URL);
  const [loaded, setLoaded] = useState<LoadedTable | null>(null);
  const [engine, setEngine] = useState<TableEngine | null>(null);
  const [engineState, setEngineState] = useState<TableEngineState | null>(null);
  const [status, setStatus] = useState<LoadStatus>({
    kind: "idle",
    message: "Load Arrow IPC or Parquet to scan it with Sift.",
  });
  const [insertRows, setInsertRows] = useState(18);
  const [insertColumns, setInsertColumns] = useState(8);
  const loadedRef = useRef<LoadedTable | null>(null);
  const engineRef = useRef<TableEngine | null>(null);

  loadedRef.current = loaded;
  engineRef.current = engine;

  useEffect(() => {
    window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginToUiMessage }>) => {
      const message = event.data.pluginMessage;
      if (!message) return;
      if (message.type === "insert-result") {
        setStatus({
          kind: message.ok ? "ready" : "error",
          message: message.message,
        });
      } else if (message.type === "hydrate-source" && message.source.kind === "url") {
        setUrl(message.source.url ?? message.source.label);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      loadedRef.current?.data.dispose?.();
    };
  }, []);

  const loadUrl = useCallback(
    async (nextUrl = url) => {
      const trimmed = nextUrl.trim();
      if (!trimmed) return;
      setStatus({ kind: "loading", message: "Loading dataset through Sift WASM..." });
      try {
        const table = await loadTableFromUrl(trimmed);
        loadedRef.current?.data.dispose?.();
        setLoaded({
          data: table,
          source: { kind: "url", url: trimmed, label: labelFromUrl(trimmed) },
        });
        setEngine(null);
        setEngineState(null);
        setStatus({ kind: "ready", message: "Dataset loaded. Scroll and filter in Sift." });
      } catch (error) {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [url],
  );

  const loadFile = useCallback(async (file: File) => {
    setStatus({ kind: "loading", message: `Loading ${file.name}...` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const table =
        file.name.endsWith(".csv") || file.name.endsWith(".tsv") || file.name.endsWith(".json")
          ? tableDataFromText(new TextDecoder().decode(bytes), file.name)
          : await loadTableFromBytes(bytes, file.name);
      loadedRef.current?.data.dispose?.();
      setLoaded({ data: table, source: { kind: "file", label: file.name } });
      setEngine(null);
      setEngineState(null);
      setStatus({ kind: "ready", message: "File loaded. Scroll and filter in Sift." });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const onReady = useCallback((readyEngine: TableEngine, tableData: TableData) => {
    setEngine(readyEngine);
    setEngineState(readyEngine.getState());
    tableData.prefetchViewport?.(readyEngine.getVisibleDataRows(MAX_INSERT_ROWS));
  }, []);

  const visiblePreview = useMemo(() => {
    if (!loaded || !engine) return null;
    return collectVisibleRows(loaded.data, engine, insertRows, insertColumns);
  }, [loaded, engine, insertRows, insertColumns, engineState]);

  const insertVisibleRows = useCallback(() => {
    const currentLoaded = loadedRef.current;
    const currentEngine = engineRef.current;
    if (!currentLoaded || !currentEngine) {
      setStatus({ kind: "error", message: "Load a table before inserting." });
      return;
    }
    const snapshot = collectVisibleRows(
      currentLoaded.data,
      currentEngine,
      insertRows,
      insertColumns,
    );
    if (snapshot.rows.length === 0) {
      setStatus({ kind: "error", message: "No visible Sift rows to insert." });
      return;
    }
    const state = currentEngine.getState();
    const payload: InsertTablePayload = {
      title: currentLoaded.source.label,
      source: currentLoaded.source,
      columns: snapshot.columns,
      rows: snapshot.rows,
      totalRows: state.totalCount,
      filteredRows: state.filteredCount,
      visibleRows: snapshot.rows.length,
      stateLabel: formatStateLabel(state),
    };
    postToPlugin({ type: "insert-table", payload });
    setStatus({ kind: "loading", message: "Inserting visible rows into the focused slide..." });
  }, [insertColumns, insertRows]);

  return (
    <main className="plugin-shell">
      <section className="control-bar">
        <div className="source-controls">
          <label className="field">
            <span>Arrow or Parquet URL</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadUrl();
              }}
            />
          </label>
          <div className="button-row">
            <button onClick={() => void loadUrl()}>Load URL</button>
            <button
              onClick={() => {
                setUrl(DEMO_URL);
                void loadUrl(DEMO_URL);
              }}
            >
              Load demo
            </button>
            <label className="file-button">
              Load file
              <input
                type="file"
                accept=".arrow,.arrows,.ipc,.parquet,.csv,.tsv,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void loadFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </div>

        <div className="insert-controls">
          <label className="number-field">
            <span>Rows</span>
            <input
              type="number"
              min={1}
              max={MAX_INSERT_ROWS}
              value={insertRows}
              onChange={(event) => setInsertRows(clampNumber(event.currentTarget.value, 1, 40))}
            />
          </label>
          <label className="number-field">
            <span>Columns</span>
            <input
              type="number"
              min={1}
              max={MAX_INSERT_COLUMNS}
              value={insertColumns}
              onChange={(event) => setInsertColumns(clampNumber(event.currentTarget.value, 1, 10))}
            />
          </label>
          <button className="primary" disabled={!visiblePreview} onClick={insertVisibleRows}>
            Insert visible rows
          </button>
        </div>
      </section>

      <section className={`status-line ${status.kind}`}>{status.message}</section>

      <section className="table-stage">
        {loaded ? (
          <SiftTable
            data={loaded.data}
            onReady={onReady}
            onChange={(state) => setEngineState(state)}
          />
        ) : (
          <div className="empty-state">
            <strong>Sift runs here.</strong>
            <span>Load a dataset to scan, filter, and then insert the current viewport.</span>
          </div>
        )}
      </section>
    </main>
  );
}

async function loadTableFromUrl(url: string): Promise<TableData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return loadTableFromBytes(bytes, url);
}

async function loadTableFromBytes(bytes: Uint8Array, label: string): Promise<TableData> {
  await ensureModule();
  const mod = getModuleSync();
  const handle = isLikelyParquet(bytes, label) ? mod.load_parquet(bytes) : await loadIpc(bytes);
  const { tableData, columns, prefetchViewport } = createWasmTableData(handle);
  tableData.prefetchViewport = prefetchViewport;
  tableData.recomputeSummaries = () => updateWasmSummaries(tableData);
  updateWasmSummaries(tableData);

  function updateWasmSummaries(data: TableData) {
    const rowCount = mod.num_rows(handle);
    data.rowCount = rowCount;
    data.columnSummaries = columns.map((column, columnIndex) => {
      switch (column.columnType) {
        case "categorical": {
          const counts = mod.store_value_counts(handle, columnIndex) as {
            label: string;
            count: number;
          }[];
          const pctOf = (count: number) =>
            rowCount > 0 ? Math.round((count / rowCount) * 1000) / 10 : 0;
          const allCategories = counts.map(({ label: category, count }) => ({
            label: category,
            count,
            pct: pctOf(count),
          }));
          return {
            kind: "categorical" as const,
            uniqueCount: allCategories.length,
            topCategories: allCategories.slice(0, 3),
            othersCount: counts.slice(3).reduce((sum, entry) => sum + entry.count, 0),
            othersPct: pctOf(counts.slice(3).reduce((sum, entry) => sum + entry.count, 0)),
            allCategories,
            medianTextLength: medianLength(allCategories.map((entry) => entry.label)),
          };
        }
        case "boolean": {
          const [trueCount, falseCount, nullCount] = mod.store_bool_counts(handle, columnIndex);
          return { kind: "boolean" as const, trueCount, falseCount, nullCount, total: rowCount };
        }
        case "timestamp": {
          const bins = mod.store_temporal_histogram(handle, columnIndex);
          if (bins.length === 0) return null;
          return {
            kind: "timestamp" as const,
            min: bins[0].x0,
            max: bins[bins.length - 1].x1,
            bins,
            timezone: column.timezone,
          };
        }
        case "numeric": {
          const bins = mod.store_histogram(handle, columnIndex, 25);
          if (bins.length === 0) return null;
          return {
            kind: "numeric" as const,
            min: bins[0].x0,
            max: bins[bins.length - 1].x1,
            bins,
          };
        }
        case "image":
          return null;
      }
    });
  }

  return tableData;
}

function tableDataFromText(text: string, fileName: string): TableData {
  const rows = fileName.endsWith(".json") ? rowsFromJson(text) : rowsFromDelimited(text, fileName);
  if (rows.length === 0) throw new Error("No rows found in the file.");
  const headers = rows[0].map((header, index) => header || `Column ${index + 1}`);
  const body = rows.slice(1);
  const columns = headers.map((header, index) => {
    const values = body.map((row) => row[index]);
    const numeric = values.every((value) => value === "" || Number.isFinite(Number(value)));
    return {
      key: header,
      label: header,
      width: Math.max(110, Math.min(240, header.length * 10 + 42)),
      sortable: true,
      numeric,
      columnType: numeric ? ("numeric" as const) : ("categorical" as const),
    };
  });
  return {
    columns,
    rowCount: body.length,
    getCell(row, col) {
      return body[row]?.[col] ?? "";
    },
    getCellRaw(row, col) {
      const value = body[row]?.[col] ?? "";
      return columns[col].numeric && value !== "" ? Number(value) : value;
    },
    columnSummaries: columns.map(() => null),
  };
}

function collectVisibleRows(
  tableData: TableData,
  engine: TableEngine,
  maxRows: number,
  maxColumns: number,
): { columns: string[]; rows: string[][] } {
  const columns = tableData.columns.slice(0, maxColumns);
  const visibleRows = engine.getVisibleDataRows(maxRows);
  tableData.prefetchViewport?.(visibleRows);
  return {
    columns: columns.map((column) => column.label || column.key),
    rows: visibleRows.map((dataRow) =>
      columns.map((_column, columnIndex) => tableData.getCell(dataRow, columnIndex)),
    ),
  };
}

function isLikelyParquet(bytes: Uint8Array, label: string): boolean {
  return (
    label.endsWith(".parquet") ||
    (bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x41 &&
      bytes[2] === 0x52 &&
      bytes[3] === 0x31)
  );
}

function rowsFromDelimited(text: string, fileName: string): string[][] {
  const delimiter = fileName.endsWith(".tsv") ? "\t" : ",";
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => splitDelimitedLine(line, delimiter));
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function rowsFromJson(text: string): string[][] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("JSON import expects an array of objects.");
  const objects = parsed.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  const headers = Array.from(new Set(objects.flatMap((entry) => Object.keys(entry))));
  return [
    headers,
    ...objects.map((entry) => headers.map((header) => stringifyCell(entry[header]))),
  ];
}

function stringifyCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatStateLabel(state: TableEngineState): string {
  const parts: string[] = [];
  if (state.sort) parts.push(`sorted by ${state.sort.column} ${state.sort.direction}`);
  if (state.filters.length > 0) parts.push(`${state.filters.length} filter(s)`);
  return parts.length === 0 ? "unfiltered viewport" : parts.join(", ");
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.length > 0 ? parts[parts.length - 1] : parsed.host);
  } catch {
    return url;
  }
}

function medianLength(values: string[]): number {
  if (values.length === 0) return 0;
  const lengths = values.map((value) => value.length).sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function postToPlugin(message: UiToPluginMessage) {
  parent.postMessage({ pluginMessage: message }, "*");
}

createRoot(document.getElementById("root")!).render(<App />);
