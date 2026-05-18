/**
 * nteract Python REPL for pi — direct bindings edition.
 *
 * Uses the in-process @runtimed/node native binding to talk to
 * the running runtimed daemon, with no MCP subprocess. State (imports,
 * variables) persists across calls within the pi session.
 *
 * Config (env vars):
 *   NTERACT_RUNTIMED_NODE_PATH  override the runtimed-node package path.
 *
 * Daemon socket selection follows the runtimed-node contract:
 * `RUNTIMED_SOCKET_PATH` overrides outright, `RUNTIMED_WORKSPACE_PATH` (or
 * `RUNTIMED_DEV=1` plus a git checkout) selects the per-worktree dev daemon,
 * otherwise the running channel is auto-detected.
 *
 * After editing, run `/reload` in pi.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// --- runtimed-node loader ----------------------------------------------------

type RuntimedNode = {
  defaultSocketPath(): string;
  PackageManager?: { Uv: "uv"; Conda: "conda"; Pixi: "pixi" };
  createNotebook(opts?: {
    runtime?: string;
    workingDir?: string;
    socketPath?: string;
    peerLabel?: string;
    description?: string;
    dependencies?: string[];
    packageManager?: "uv" | "conda" | "pixi";
  }): Promise<Session>;
  openNotebook(
    notebookId: string,
    opts?: { socketPath?: string; peerLabel?: string; description?: string },
  ): Promise<Session>;
  readParquetFile(
    filePath: string,
    offset: number,
    limit: number,
  ): {
    columns: string[];
    rows: string[][];
    totalRows: number;
    offset: number;
  };
  summarizeParquetFile?(filePath: string): {
    numRows: number;
    numBytes: number;
    columns: Array<{ name: string; dataType: string; nullCount: number; statsJson: string }>;
  };
};

type JsOutput = {
  outputType: string;
  name?: string;
  text?: string;
  dataJson?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  executionCount?: number;
  blobUrlsJson?: string;
  blobPathsJson?: string;
};

type CellResult = {
  cellId: string;
  executionId: string;
  executionCount?: number;
  status: string; // "done" | "error" | "timeout" | "kernel_error"
  success: boolean;
  outputs?: JsOutput[];
};

type QueuedExecution = {
  cellId: string;
  executionId: string;
};

type ExecutionViewSnapshot = {
  execution_count: number | null;
  status: string;
  success: boolean | null;
  output_ids: string[];
};

type ExecutionViewChangeset = {
  execution_upserts?: Array<[executionId: string, snapshot: ExecutionViewSnapshot]>;
};

type SubscriptionLike = {
  unsubscribe?: () => void;
  dispose?: () => void;
};

type ObservableLike<T> = {
  subscribe(next: (value: T) => void): SubscriptionLike;
};

type Session = {
  readonly notebookId: string;
  readonly executionViewChanges$?: ObservableLike<ExecutionViewChangeset>;
  runCell(
    source: string,
    opts?: { timeoutMs?: number; cellType?: string; onUpdate?: (progress: CellResult) => void },
  ): Promise<CellResult>;
  queueCell(source: string, opts?: { cellType?: string }): Promise<QueuedExecution>;
  waitForExecution(
    executionId: string,
    opts?: { timeoutMs?: number; cellId?: string; onUpdate?: (progress: CellResult) => void },
  ): Promise<CellResult>;
  addUvDependency?(pkg: string): Promise<void>;
  addDependencies?(
    packages: string[],
    opts?: { packageManager?: "uv" | "conda" | "pixi" },
  ): Promise<void>;
  getDependencyStatus?(): Promise<{ uv?: { dependencies: string[] }; fingerprint?: string }>;
  getRuntimeStatus?(): Promise<{
    status: string;
    lifecycle: string;
    errorReason?: string;
    errorDetails?: string;
  }>;
  syncEnvironment(): Promise<void>;
  saveNotebook(path?: string): Promise<void>;
  shutdownNotebook?(): Promise<boolean>;
  close(): Promise<void>;
};

function loadRuntimedNode(): RuntimedNode | null {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.NTERACT_RUNTIMED_NODE_PATH,
    "@runtimed/node",
    path.resolve(extensionDir, "../../../..", "packages", "runtimed-node", "src", "index.cjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const req = createRequire(import.meta.url);
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return req(candidate) as RuntimedNode;
    } catch (e) {
      errors.push(`${candidate}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.error("[nteract-repl] failed to load runtimed-node:\n" + errors.join("\n"));
  return null;
}

// --- bootstrap detection -----------------------------------------------------

const INSTALL_HINT =
  "The nteract daemon (runtimed) isn't installed yet.\n" +
  "Quick install:  curl -fsSL https://sh.nteract.io | bash\n" +
  "Or visit:       https://nteract.io";

type BootstrapStatus =
  | { kind: "ready"; rn: RuntimedNode }
  | { kind: "missing"; reason: "binding" | "daemon" };

function findOnPath(cmd: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function detectBootstrap(): BootstrapStatus {
  const rn = loadRuntimedNode();
  if (!rn) return { kind: "missing", reason: "binding" };
  // defaultSocketPath() already honors RUNTIMED_SOCKET_PATH and the dev /
  // worktree-aware resolution from runt-workspace, so this is the single point
  // of truth. The socket file only exists while the daemon is running, but the
  // parent cache dir survives shutdowns, so dir-existence covers "installed
  // but stopped".
  const socket = rn.defaultSocketPath();
  const installed =
    existsSync(socket) ||
    existsSync(path.dirname(socket)) ||
    Boolean(findOnPath("runt")) ||
    Boolean(findOnPath("runt-nightly"));
  return installed ? { kind: "ready", rn } : { kind: "missing", reason: "daemon" };
}

// --- DataTable TUI component --------------------------------------------------

type Theme = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type ColumnStats = {
  kind: string;
  min?: number;
  max?: number;
  distinct_count?: number;
  top?: [string, number][];
  true_count?: number;
  false_count?: number;
};

function formatStat(stats: ColumnStats | null): string {
  if (!stats) return "";
  switch (stats.kind) {
    case "numeric":
      return `${stats.min?.toFixed(1)}..${stats.max?.toFixed(1)}`;
    case "string":
      return `${stats.distinct_count ?? "?"}d`;
    case "boolean":
      return `T:${stats.true_count ?? 0} F:${stats.false_count ?? 0}`;
    default:
      return "";
  }
}

function resolvePath(userPath: string, workingDir = process.cwd()): string {
  const expanded = expandHome(userPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(workingDir, expanded);
}

function expandHome(userPath: string): string {
  if (userPath === "~") return homedir();
  if (userPath.startsWith("~/") || userPath.startsWith("~\\")) {
    return path.join(homedir(), userPath.slice(2));
  }
  return userPath;
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bins = Array.from({ length: Math.min(width, 8) }, () => 0);
  if (min === max) {
    return SPARK_CHARS[3].repeat(bins.length);
  }
  const range = max - min;
  for (const v of values) {
    const bi = Math.min(Math.floor(((v - min) / range) * bins.length), bins.length - 1);
    bins[bi]++;
  }
  const maxCount = Math.max(...bins);
  return bins
    .map(
      (c) =>
        SPARK_CHARS[maxCount === 0 ? 0 : Math.round((c / maxCount) * (SPARK_CHARS.length - 1))],
    )
    .join("");
}

function sparklineForColumn(
  rows: string[][],
  ci: number,
  stats: ColumnStats | null,
  colType: string,
  width: number,
): string {
  if (stats?.kind === "boolean") {
    const t = stats.true_count ?? 0;
    const f = stats.false_count ?? 0;
    const total = t + f;
    if (total === 0) return "";
    const barW = Math.min(width, 8);
    const filled = Math.round((t / total) * barW);
    return (
      SPARK_CHARS[SPARK_CHARS.length - 1].repeat(filled) + SPARK_CHARS[0].repeat(barW - filled)
    );
  }
  if (stats?.kind === "numeric" || /int|float|decimal|uint/.test(colType)) {
    const nums: number[] = [];
    for (const row of rows) {
      const n = parseFloat(row[ci]);
      if (!isNaN(n)) nums.push(n);
    }
    return sparkline(nums, width);
  }
  if (stats?.kind === "string" && stats.top && stats.top.length > 0) {
    const counts = stats.top.map(([, c]) => c);
    return sparkline(counts, Math.min(width, counts.length));
  }
  return "";
}

class DataTable {
  private columns: string[];
  private rows: string[][];
  private totalRows: number;
  private colTypes: string[];
  private colStats: (ColumnStats | null)[];
  private theme: Theme;
  private cachedLines?: string[];
  private cachedWidth?: number;

  private indent: number;

  constructor(
    columns: string[],
    rows: string[][],
    totalRows: number,
    colTypes: string[],
    colStats: (ColumnStats | null)[],
    theme: Theme,
    indent: number = 0,
  ) {
    this.columns = columns;
    this.rows = rows;
    this.totalRows = totalRows;
    this.colTypes = colTypes;
    this.colStats = colStats;
    this.theme = theme;
    this.indent = indent;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const t = this.theme;
    const numRows = this.rows.length;
    const totalCols = this.columns.length;
    const MIN_COL_W = 6;

    // Calculate natural column widths: max of header, type, stat, and data
    const naturalWidths = this.columns.map((col, ci) => {
      let w = col.length;
      w = Math.max(w, (this.colTypes[ci] ?? "").length);
      const statStr = formatStat(this.colStats[ci] ?? null);
      w = Math.max(w, statStr.length);
      for (const row of this.rows) {
        w = Math.max(w, (row[ci] ?? "").length);
      }
      return w;
    });

    // Greedily fit columns left-to-right within the available width.
    // Each column costs its width + 3 chars of border ("│ " + " │").
    let budget = width - 1; // leading "│"
    let visibleCount = 0;
    for (let i = 0; i < totalCols; i++) {
      const colCost = Math.max(naturalWidths[i], MIN_COL_W) + 3;
      if (budget - colCost < 0 && visibleCount > 0) break;
      budget -= colCost;
      visibleCount++;
    }
    visibleCount = Math.max(1, visibleCount);
    const hiddenCols = totalCols - visibleCount;

    // Slice to visible columns
    const columns = this.columns.slice(0, visibleCount);
    const colTypes = this.colTypes.slice(0, visibleCount);
    const colStats = this.colStats.slice(0, visibleCount);
    const rows = this.rows.map((r) => r.slice(0, visibleCount));
    const numCols = columns.length;
    const colWidths = naturalWidths.slice(0, visibleCount);

    // Shrink proportionally only if still over budget after column pruning
    const borderOverhead = 1 + numCols * 3;
    const totalColWidth = colWidths.reduce((a, b) => a + b, 0);
    const availableForCols = width - borderOverhead;
    if (totalColWidth > availableForCols && availableForCols > numCols) {
      const ratio = availableForCols / totalColWidth;
      for (let i = 0; i < numCols; i++) {
        colWidths[i] = Math.max(MIN_COL_W, Math.floor(colWidths[i] * ratio));
      }
    }

    const pad = (s: string, w: number) => {
      const vw = visibleWidth(s);
      return vw >= w ? truncateToWidth(s, w, "…") : s + " ".repeat(w - vw);
    };

    const rpad = (s: string, w: number) => {
      const vw = visibleWidth(s);
      return vw >= w ? truncateToWidth(s, w, "…") : " ".repeat(w - vw) + s;
    };

    // Detect numeric columns for right-alignment
    const isNumeric = colTypes.map((dt) => /int|float|decimal|uint/.test(dt));

    const align = (s: string, ci: number, w: number) => (isNumeric[ci] ? rpad(s, w) : pad(s, w));

    const lines: string[] = [];

    // ── Top border ──
    const topBorder = t.fg("muted", "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
    lines.push(topBorder);

    // ── Column headers ──
    const headerCells = columns.map((col, ci) => t.fg("accent", t.bold(pad(col, colWidths[ci]))));
    lines.push(
      t.fg("muted", "│") + " " + headerCells.join(t.fg("muted", " │ ")) + " " + t.fg("muted", "│"),
    );

    // ── Type row ──
    const typeCells = colTypes.map((dt, ci) => t.fg("dim", pad(dt, colWidths[ci])));
    lines.push(
      t.fg("muted", "│") + " " + typeCells.join(t.fg("muted", " │ ")) + " " + t.fg("muted", "│"),
    );

    // ── Sparkline row ──
    const sparkCells = colStats.map((stats, ci) => {
      const spark = sparklineForColumn(rows, ci, stats, colTypes[ci] ?? "", colWidths[ci]);
      return t.fg("dim", pad(spark, colWidths[ci]));
    });
    lines.push(
      t.fg("muted", "│") + " " + sparkCells.join(t.fg("muted", " │ ")) + " " + t.fg("muted", "│"),
    );

    // ── Stats row ──
    const statCells = colStats.map((stats, ci) => {
      const statStr = formatStat(stats);
      return t.fg("dim", pad(statStr, colWidths[ci]));
    });
    lines.push(
      t.fg("muted", "│") + " " + statCells.join(t.fg("muted", " │ ")) + " " + t.fg("muted", "│"),
    );

    // ── Header separator ──
    const headerSep = t.fg("muted", "╞" + colWidths.map((w) => "═".repeat(w + 2)).join("╪") + "╡");
    lines.push(headerSep);

    // ── Data rows ──
    for (let r = 0; r < numRows; r++) {
      const row = rows[r];
      const cells = row.map((v, ci) => align(v, ci, colWidths[ci]));
      const rowStr =
        t.fg("muted", "│") + " " + cells.join(t.fg("muted", " │ ")) + " " + t.fg("muted", "│");
      lines.push(rowStr);
    }

    // ── Bottom border ──
    const botBorder = t.fg("muted", "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
    lines.push(botBorder);

    // ── Footer info ──
    const showingRows = numRows < this.totalRows ? `showing ${numRows} of ` : "";
    const hiddenSuffix = hiddenCols > 0 ? ` (${hiddenCols} more columns)` : "";
    const info = t.fg(
      "dim",
      `${showingRows}${this.totalRows} rows × ${totalCols} columns${hiddenSuffix}`,
    );
    lines.push(info);

    // Indent all lines to align with Out[n]: prompt
    const indent = " ".repeat(this.indent);
    for (let i = 0; i < lines.length; i++) {
      lines[i] = indent + lines[i];
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
}

// --- output formatting -------------------------------------------------------

function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

function formatResult(result: CellResult): {
  content: (TextContent | ImageContent)[];
  isError: boolean;
} {
  const outputs = result.outputs ?? [];
  const isError =
    result.status === "error" ||
    result.status === "kernel_error" ||
    result.status === "kernel_failed" ||
    outputs.some((o) => o.outputType === "error");

  const parts: (TextContent | ImageContent)[] = [];
  const header = `cell ${result.cellId} [${result.executionCount ?? "?"}] ${result.status}`;
  const textChunks: string[] = [];

  for (const o of outputs) {
    switch (o.outputType) {
      case "stream": {
        const prefix = o.name === "stderr" ? "[stderr] " : "";
        textChunks.push(prefix + (o.text ?? ""));
        break;
      }
      case "execute_result":
      case "display_data": {
        if (!o.dataJson) break;
        let data: Record<string, { type: string; value: unknown }>;
        try {
          data = JSON.parse(o.dataJson);
        } catch {
          break;
        }
        const hasImage = Object.keys(data).some(
          (m) => m.startsWith("image/") && m !== "image/svg+xml",
        );
        // Text-ish rep for the agent. Skip generic Figure reprs when we
        // also have an image — the image is more useful.
        const textRep =
          (data["text/llm+plain"]?.value as string | undefined) ??
          (data["text/plain"]?.value as string | undefined);
        if (textRep && !(hasImage && /^<Figure[^>]*>/.test(textRep.trim()))) {
          textChunks.push(String(textRep));
        }

        // Attach images directly so the model can see them.
        for (const [mime, entry] of Object.entries(data)) {
          if (!mime.startsWith("image/")) continue;
          if (mime === "image/svg+xml") continue; // text, not a raster image
          if (entry?.type !== "binary" || typeof entry.value !== "string") continue;
          // Dedupe images we've already emitted (Jupyter often sends the
          // same image as both execute_result and display_data).
          const dup = parts.some(
            (p) =>
              p.type === "image" &&
              (p as ImageContent).data === entry.value &&
              (p as ImageContent).mimeType === mime,
          );
          if (dup) continue;
          parts.push({
            type: "image",
            mimeType: mime,
            data: entry.value,
          } as ImageContent);
        }
        break;
      }
      case "error": {
        const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : "";
        textChunks.push(tb || `${o.ename ?? "Error"}: ${o.evalue ?? ""}`);
        break;
      }
      default:
        textChunks.push(`[${o.outputType} output]`);
    }
  }

  const body = stripAnsi(textChunks.join("").replace(/\n+$/, ""));
  parts.unshift({
    type: "text",
    text: body ? `${header}\n${body}` : header,
  });
  return { content: parts, isError };
}

function findParquetBlobPath(result: CellResult): string | undefined {
  for (const o of result.outputs ?? []) {
    if (!o.blobPathsJson) continue;
    try {
      const paths = JSON.parse(o.blobPathsJson);
      const pqPath = paths["application/vnd.apache.parquet"];
      if (typeof pqPath === "string") return pqPath;
    } catch {}
  }
  return undefined;
}

// --- extension ---------------------------------------------------------------

// Braille frames for the "waiting on first token" spinner shown in `In [*]:`
// before any input_json_delta arrives. Anthropic validates the JSON server-side,
// so the gap between toolcall_start and the first delta can be hundreds of ms.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type InCallState = {
  spinner?: { frame: number; timer: ReturnType<typeof setInterval> };
};

const PYTHON_PARAMS = Type.Object({
  code: Type.String({
    description:
      "Python source to execute in the persistent notebook session. Use print(...) for side effects; the last expression's repr is returned as the result.",
  }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Packages to add before executing this code. On the first call they are recorded before the kernel starts; on later calls they are hot-synced into the running environment.",
    }),
  ),
  timeout_secs: Type.Optional(
    Type.Number({
      description: "Max seconds to wait for execution (default 120).",
      default: 120,
    }),
  ),
});

const ADD_DEPENDENCIES_PARAMS = Type.Object({
  packages: Type.Array(Type.String(), {
    description: "Package specs (e.g. ['matplotlib', 'pandas>=2']).",
  }),
});

type AddDependenciesDetails = {
  notebook_id?: string;
  packages?: string[];
};

const SAVE_NOTEBOOK_PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "File path to save to (e.g. './analysis.ipynb'). If omitted, saves to the original location.",
    }),
  ),
});

type SaveNotebookDetails = {
  notebook_id: string;
  path?: string;
};

export default function nteractReplExtension(pi: ExtensionAPI) {
  const bootstrap = detectBootstrap();
  if (bootstrap.kind === "missing") {
    // Surface a one-liner toast each session so the user sees the hint without
    // having to invoke the tool first.
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(INSTALL_HINT, "warning");
    });
    // Register python_repl with a stub execute() so the LLM can still advertise
    // the capability and surface install guidance the moment it tries to run
    // Python. Throwing routes the message into the tool-result channel that the
    // model relays back to the user.
    pi.registerTool({
      name: "python_repl",
      label: "Python REPL",
      description:
        "Execute Python in your persistent REPL. Requires the nteract daemon (runtimed). " +
        "If unavailable, recommend the user install with `curl -fsSL https://sh.nteract.io | bash` " +
        "or download the desktop app at https://nteract.io.",
      promptSnippet:
        "python_repl: requires the nteract daemon. Install with `curl -fsSL https://sh.nteract.io | bash` or via https://nteract.io.",
      parameters: PYTHON_PARAMS,
      async execute() {
        throw new Error(INSTALL_HINT);
      },
    });
    return;
  }
  const rn = bootstrap.rn;

  let session: Session | null = null;
  let opening: Promise<Session> | null = null;
  let nextExecCount: number | null = 1;
  let executionViewSubscription: SubscriptionLike | null = null;

  function disposeExecutionViewTracking(): void {
    const sub = executionViewSubscription;
    executionViewSubscription = null;
    sub?.unsubscribe?.();
    sub?.dispose?.();
  }

  function trackExecutionView(sess: Session): void {
    disposeExecutionViewTracking();
    executionViewSubscription =
      sess.executionViewChanges$?.subscribe((changeset) => {
        for (const [, snapshot] of changeset.execution_upserts ?? []) {
          const count = snapshot.execution_count;
          if (typeof count === "number") {
            nextExecCount = Math.max(nextExecCount ?? 1, count + 1);
          }
        }
      }) ?? null;
  }

  async function addDependenciesAndSync(sess: Session, packages: string[]): Promise<void> {
    const unique = Array.from(new Set(packages.map((pkg) => pkg.trim()).filter(Boolean)));
    if (!unique.length) return;
    if (sess.addDependencies) {
      await sess.addDependencies(unique);
    } else if (sess.addUvDependency) {
      for (const pkg of unique) {
        await sess.addUvDependency(pkg);
      }
    } else {
      throw new Error("@runtimed/node Session does not support dependency edits");
    }
    await sess.syncEnvironment();
  }

  async function ensureSession(initialDependencies: string[] = []): Promise<Session> {
    const dependencies = Array.from(
      new Set(initialDependencies.map((pkg) => pkg.trim()).filter(Boolean)),
    );
    if (session) {
      await addDependenciesAndSync(session, dependencies);
      return session;
    }
    if (opening) {
      const opened = await opening;
      await addDependenciesAndSync(opened, dependencies);
      return opened;
    }
    opening = (async () => {
      // Omit socketPath so the binding resolves through defaultSocketPath(),
      // which honors RUNTIMED_SOCKET_PATH / RUNTIMED_WORKSPACE_PATH and the
      // channel auto-detect.
      session = await rn.createNotebook({
        runtime: "python",
        workingDir: process.cwd(),
        peerLabel: "pi",
        description: "pi Python REPL",
        dependencies,
      });
      trackExecutionView(session);
      return session;
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  pi.registerTool<typeof PYTHON_PARAMS, unknown, InCallState>({
    name: "python_repl",
    label: "Python REPL",
    description:
      "Execute Python in your persistent REPL. Backed by a real IPython runtime. Variables, imports, and state stick around between calls. The last expression is the result; use print() or display() for intermediate output. Images (matplotlib, PIL, widgets) are returned inline.",
    promptSnippet:
      "python_repl: run Python in your persistent REPL (variables and imports persist; returns stdout + last expression + images).",
    promptGuidelines: [
      "Use `python_repl` for data analysis, plotting, and multi-step workflows. State persists between calls in a real IPython runtime.",
      "Variables and imports stick around. No need to re-import or redefine on every turn unless the user has reloaded the session.",
      "The last expression is the result; use print() or display() for intermediate output.",
      "Images (matplotlib, PIL, widgets) come back inline. The user sees them if their terminal supports graphics.",
      "Pass `dependencies` on the first call to pre-install packages before the kernel starts.",
      "Use `python_add_dependencies` to install packages mid-session without restarting the kernel.",
    ],
    parameters: PYTHON_PARAMS,
    renderCall(args, theme, _context) {
      const text =
        (_context.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
      const code = (args?.code ?? "").replace(/^\n+/, "");
      const count = nextExecCount;
      const prompt = count != null ? `In [${count}]:` : "In [*]:";
      const promptStr = theme.fg("accent", theme.bold(prompt));

      // Anthropic gates input_json_delta on server-side validation, so there is
      // a visible pause between toolcall_start and the first token of `code`.
      // Show a braille spinner in the prompt slot until either the first
      // character streams in or the call resolves another way.
      const state = _context.state as InCallState;
      const waitingForFirstToken =
        !code && !_context.executionStarted && !_context.argsComplete && !_context.isError;
      if (waitingForFirstToken) {
        if (!state.spinner) {
          const timer = setInterval(() => {
            const s = state.spinner;
            if (!s) return;
            s.frame = (s.frame + 1) % SPINNER_FRAMES.length;
            _context.invalidate();
          }, SPINNER_INTERVAL_MS);
          // Don't keep the event loop alive on the spinner alone.
          timer.unref?.();
          state.spinner = { frame: 0, timer };
        }
        const frame = SPINNER_FRAMES[state.spinner.frame];
        text.setText(`${promptStr} ${theme.fg("muted", frame)}`);
        return text;
      }

      if (state.spinner) {
        clearInterval(state.spinner.timer);
        state.spinner = undefined;
      }

      const lines = highlightCode(code, "python");
      // Indent continuation lines to align with first line after prompt
      const pad = " ".repeat(prompt.length + 1);
      const formatted = lines
        .map((l, i) => (i === 0 ? `${promptStr} ${l}` : `${pad}${l}`))
        .join("\n");
      text.setText(formatted);
      return text;
    },
    renderResult(result, _options, theme, _context) {
      const details = (result as any).details ?? {};
      const count = details.execution_count;
      const isErr = details.is_error;

      // Update the closure count for the next renderCall
      if (count != null) {
        nextExecCount = count + 1;
      }

      // If we have a parquet blob path, read it via napi and render as DataTable
      const pqPath = details.parquet_blob_path;
      if (pqPath && rn?.readParquetFile) {
        try {
          const page = rn.readParquetFile(pqPath, 0, 40);
          if (page && page.rows.length > 0) {
            // Get column types and stats from summary
            let colTypes: string[] = page.columns.map(() => "");
            let colStats: (ColumnStats | null)[] = page.columns.map(() => null);
            if (rn.summarizeParquetFile) {
              try {
                const summary = rn.summarizeParquetFile(pqPath);
                colTypes = summary.columns.map((c: any) => c.dataType);
                colStats = summary.columns.map((c: any) => {
                  try {
                    return JSON.parse(c.statsJson);
                  } catch {
                    return null;
                  }
                });
              } catch {}
            }

            // Render table with Out[n]: prompt
            const prompt = count != null ? `Out[${count}]:` : "Out:";
            const promptStr = theme.fg("muted", prompt);
            const indent = prompt.length + 1;
            const dt = new DataTable(
              page.columns,
              page.rows,
              page.totalRows,
              colTypes,
              colStats,
              theme,
              indent,
            );
            const text =
              (_context.lastComponent instanceof Text ? _context.lastComponent : undefined) ??
              new Text("", 0, 0);
            const termWidth = process.stdout.columns || 120;
            const tableLines = dt.render(termWidth - indent);
            // Put first table line on the Out[n]: line instead of below it
            const indentStr = " ".repeat(indent);
            if (tableLines.length > 0 && tableLines[0].startsWith(indentStr)) {
              tableLines[0] = `${promptStr} ${tableLines[0].slice(indent)}`;
            }
            text.setText(tableLines.join("\n"));
            return text;
          }
        } catch {}
      }

      // Extract text output from content
      const textContent = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      // Strip the "cell <id> [n] status" header we put in the text content
      const body = textContent.replace(/^cell \S* \[[^\]]*\] \S*\n?/, "").trim();

      const text =
        (_context.lastComponent instanceof Text ? _context.lastComponent : undefined) ??
        new Text("", 0, 0);
      if (!body) {
        // No output — just show a check/cross
        const icon = isErr ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
        text.setText(icon);
      } else if (isErr) {
        text.setText(theme.fg("error", body));
      } else {
        const prompt = count != null ? `Out[${count}]:` : "Out:";
        const promptStr = theme.fg("muted", prompt);
        const pad = " ".repeat(prompt.length + 1);
        const bodyLines = body.split("\n");
        const formatted = bodyLines
          .map((l: string, i: number) => (i === 0 ? `${promptStr} ${l}` : `${pad}${l}`))
          .join("\n");
        text.setText(formatted);
      }
      return text;
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession(params.dependencies ?? []);
      const timeoutSecs = Math.max(1, params.timeout_secs ?? 120);
      const result = await sess.runCell(params.code, {
        timeoutMs: Math.round(timeoutSecs * 1000),
        onUpdate: (progress) => {
          const { content, isError } = formatResult(progress);
          onUpdate?.({
            content,
            details: {
              notebook_id: sess.notebookId,
              cell_id: progress.cellId,
              execution_id: progress.executionId,
              status: progress.status,
              execution_count: progress.executionCount,
              is_error: isError,
              parquet_blob_path: findParquetBlobPath(progress),
              streaming: true,
            },
          });
        },
      });
      // Extract parquet blob path for human-side table rendering
      const parquetBlobPath = findParquetBlobPath(result);

      const { content, isError } = formatResult(result);
      return {
        content,
        details: {
          notebook_id: sess.notebookId,
          cell_id: result.cellId,
          execution_id: result.executionId,
          status: result.status,
          execution_count: result.executionCount,
          is_error: isError,
          parquet_blob_path: parquetBlobPath,
          runtime: sess.getRuntimeStatus
            ? await sess.getRuntimeStatus().catch(() => undefined)
            : undefined,
        },
      };
    },
  });

  pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, AddDependenciesDetails>({
    name: "python_add_dependencies",
    label: "Add Dependencies",
    description:
      "Install packages into the running Python environment without restarting. Accepts pip-style specs like 'matplotlib', 'numpy>=2', 'requests'. The kernel stays hot.",
    promptSnippet:
      "python_add_dependencies: install packages into the running Python session (no restart needed).",
    parameters: ADD_DEPENDENCIES_PARAMS,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.packages.length) {
        return { content: [{ type: "text", text: "No packages given." }], details: {} };
      }
      const sess = await ensureSession();
      await addDependenciesAndSync(sess, params.packages);
      return {
        content: [
          {
            type: "text",
            text: `Installed into ${sess.notebookId}: ${params.packages.join(", ")}`,
          },
        ],
        details: { notebook_id: sess.notebookId, packages: params.packages },
      };
    },
  });

  pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, SaveNotebookDetails>({
    name: "python_save_notebook",
    label: "Save Notebook",
    description:
      "Save the current Python session as an .ipynb file. If no path is given, saves to the original location (if it was opened from a file). Provide a path to save elsewhere.",
    promptSnippet: "python_save_notebook: save the current session as an .ipynb file.",
    parameters: SAVE_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession();
      const savePath = params.path ? resolvePath(params.path) : undefined;
      await sess.saveNotebook(savePath);
      const where = savePath ?? "original location";
      return {
        content: [{ type: "text", text: `Notebook saved to ${where}` }],
        details: { notebook_id: sess.notebookId, path: savePath },
      };
    },
  });

  pi.registerCommand("python-reset", {
    description:
      "Start fresh: next /python_repl call opens a new kernel (clean slate, no prior variables or imports)",
    handler: async (_args, ctx) => {
      const old = session;
      session = null;
      nextExecCount = 1;
      disposeExecutionViewTracking();
      if (old) {
        try {
          if (old.shutdownNotebook) {
            await old.shutdownNotebook();
          } else {
            await old.close();
          }
        } catch {}
      }
      ctx.ui.notify(
        "Python session closed. Next python_repl call will start a fresh kernel.",
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    disposeExecutionViewTracking();
    if (session) {
      try {
        if (session.shutdownNotebook) {
          await session.shutdownNotebook();
        } else {
          await session.close();
        }
      } catch {}
      session = null;
    }
  });
}
