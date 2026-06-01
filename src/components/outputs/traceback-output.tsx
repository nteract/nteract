/**
 * Rich traceback renderer — experimental.
 *
 * Consumes `application/vnd.nteract.traceback+json` payloads. Schema is
 * deliberately loose while we iterate from a notebook; anything we don't
 * recognize renders via a "raw JSON" escape hatch so we can't lock
 * ourselves out of debugging the payload shape.
 *
 * Live iteration loop: emit a `display_data` message from a notebook cell
 * with this MIME and hack on the component. No kernel-side dependency,
 * no persistence, no plugin build step — main-DOM React all the way.
 */

import { Check, ChevronRight, Copy, LocateFixed, OctagonAlert } from "lucide-react";
import { useState } from "react";
import { highlight } from "@/components/editor/static-highlight";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { cn } from "@/lib/utils";

/** CodeMirror-matched mono stack so the traceback reads like the editor. */
const CM_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Source-context line shown around the failing line in a frame. */
interface Line {
  lineno: number;
  source: string;
  /** True for the line that actually raised. One per frame. */
  highlight?: boolean;
}

/** A single frame in the call stack. */
interface Frame {
  /** Interpreter filename for the frame. Notebook executions may be synthetic. */
  filename: string;
  /** Line number of the failing call. */
  lineno: number;
  /** Enclosing function / method / module name. */
  name: string;
  /** Execution provenance for clients that want to jump to source. */
  execution_id?: string;
  cell_id?: string;
  execution_count?: number;
  source_hash?: string;
  source_ref?: SourceRef;
  /** Optional source-context window — lines around `lineno`. */
  lines?: Line[];
  /** Optional "in library code" flag; lets the UI dim non-user frames. */
  library?: boolean;
}

/**
 * Parse-error-only info, populated when the exception is a
 * `SyntaxError` / `IndentationError` / `TabError`. These don't have
 * user-code frames (IPython raises from `ast_parse` before any cell
 * bytecode runs), so we dedicate a slot to what actually helps:
 * the offending source line and a caret at `offset`.
 */
interface SyntaxInfo {
  filename: string;
  lineno: number;
  offset: number;
  execution_id?: string;
  cell_id?: string;
  execution_count?: number;
  source_hash?: string;
  source_ref?: SourceRef;
  /**
   * End of the offending token (Python 3.11+). 0 means "absent" — the
   * renderer falls back to a single-column caret. When set, we underline
   * the `[offset, end_offset)` range so multi-char errors read at a
   * glance. Matches CPython's own traceback format since 3.11.
   */
  end_lineno?: number;
  end_offset?: number;
  text: string;
  msg: string;
}

interface TracebackPayload {
  /** Exception class name, e.g. "ValueError". */
  ename: string;
  /** Exception message. */
  evalue: string;
  /** Frames, outermost first (Python convention). */
  frames?: Frame[];
  /**
   * Language for syntax highlighting of source lines. Defaults to
   * "python" since that's what we emit today; Deno notebooks will
   * ship "typescript" here. Unknown values fall back to plain text.
   */
  language?: string;
  execution?: ExecutionInfo;
  /**
   * Paste/LLM-ready plain text version of the traceback. The launcher
   * normalizes notebook source refs here so copy paths avoid ipykernel
   * temp filenames.
   */
  text?: string;
  /** Raw Python `traceback.format_exception` output for debugging. */
  raw_text?: string;
  /** Raw traceback strings, for cases where we couldn't parse. */
  raw?: string[];
  /**
   * Present for `SyntaxError` / `IndentationError` / `TabError`.
   * When set, the renderer shows a dedicated parse-error layout
   * (source line + caret) instead of a frame list.
   */
  syntax?: SyntaxInfo;
}

interface ExecutionInfo {
  execution_id?: string;
  cell_id?: string;
  execution_count?: number;
}

interface SourceRef {
  kind?: string;
  execution_id?: string;
  cell_id?: string;
  execution_count?: number;
  source_hash?: string;
  compiled_filename?: string;
}

interface Props {
  data: unknown;
  className?: string;
  resolveExecutionTarget?: TracebackExecutionResolver;
  onNavigateToCell?: TracebackCellNavigator;
}

export interface TracebackCellTarget {
  cellId: string;
  label?: string;
}

export type TracebackExecutionResolver = (
  executionId: string,
  sourceHash?: string,
) => TracebackCellTarget | null | undefined;

export type TracebackCellNavigator = (target: TracebackCellTarget) => void;

/** A single frame, or a run of consecutive identical frames (recursion). */
interface Cluster {
  frame: Frame;
  /** Number of consecutive frames this represents. >1 on recursion. */
  count: number;
  /** Original index of the representative frame, for key stability. */
  firstIndex: number;
}

/**
 * Group consecutive frames sharing (filename, lineno, name) into one
 * cluster. Turns a 2978-frame RecursionError into a single row labeled
 * "× 2978" instead of tanking the DOM with thousands of `<pre>` blocks.
 */
function clusterFrames(frames: Frame[]): Cluster[] {
  const out: Cluster[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const last = out[out.length - 1];
    if (
      last &&
      last.frame.filename === f.filename &&
      last.frame.lineno === f.lineno &&
      last.frame.name === f.name
    ) {
      last.count += 1;
    } else {
      out.push({ frame: f, count: 1, firstIndex: i });
    }
  }
  return out;
}

export function TracebackOutput({
  data,
  className,
  resolveExecutionTarget,
  onNavigateToCell,
}: Props) {
  const payload = toPayload(data);
  if (!payload) {
    return <RawJsonFallback data={data} className={className} />;
  }
  const frames = payload.frames ?? [];
  const clusters = clusterFrames(frames);
  const language = payload.language ?? "python";
  // Expand user frames by default, collapse library frames. Matches how
  // humans read tracebacks: their own code first, stdlib noise tucked
  // away. Two extra rules:
  //   - Recursion clusters (count > 1) stay collapsed; they're noise.
  //   - If everything is library code, open the innermost so something
  //     useful is visible.
  const everythingIsLibrary = clusters.length > 0 && clusters.every((c) => c.frame.library);
  const innermost = clusters.length - 1;
  const shouldOpen = (c: Cluster, i: number): boolean => {
    if (c.count > 1) return false;
    if (everythingIsLibrary) return i === innermost;
    return !c.frame.library;
  };

  // Inline `ename: evalue` on one line when the evalue fits. Multi-line
  // evalues (pytest diffs, chained SQL errors) fall through to the
  // two-line layout. Independent of frame count — a short evalue next
  // to the ename reads better whether we show frames below or not.
  const inlineEvalue = Boolean(payload.evalue) && !payload.evalue.includes("\n");
  const currentExecutionId = payload.execution?.execution_id;

  return (
    <div
      data-slot="traceback"
      className={cn(
        "border-l-2 border-destructive/45 bg-destructive/[0.03] pl-2",
        "text-sm",
        className,
      )}
    >
      <Header
        ename={payload.ename}
        // For parse errors, prefer `syntax.msg` ("invalid syntax") over
        // `str(evalue)` ("invalid syntax (<tmpfile>, line 1)"). IPython
        // stringifies SyntaxError with a temp-file tail that's noise
        // for cell users — the caret block shows location already.
        evalue={payload.syntax?.msg || payload.evalue}
        payload={payload}
        resolveExecutionTarget={resolveExecutionTarget}
        inlineEvalue={inlineEvalue || Boolean(payload.syntax?.msg)}
      />
      {payload.syntax ? (
        <SyntaxErrorBlock
          syntax={payload.syntax}
          language={language}
          currentExecutionId={currentExecutionId}
          resolveExecutionTarget={resolveExecutionTarget}
          onNavigateToCell={onNavigateToCell}
        />
      ) : (
        clusters.length > 0 && (
          <ol className="divide-y divide-destructive/10">
            {clusters.map((cluster, i) => (
              <FrameRow
                key={`${cluster.frame.filename}:${cluster.frame.lineno}:${cluster.firstIndex}`}
                cluster={cluster}
                defaultOpen={shouldOpen(cluster, i)}
                language={language}
                currentExecutionId={currentExecutionId}
                resolveExecutionTarget={resolveExecutionTarget}
                onNavigateToCell={onNavigateToCell}
              />
            ))}
          </ol>
        )
      )}
    </div>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────────

function Header({
  ename,
  evalue,
  payload,
  resolveExecutionTarget,
  inlineEvalue,
}: {
  ename: string;
  evalue: string;
  payload: TracebackPayload;
  resolveExecutionTarget?: TracebackExecutionResolver;
  /**
   * When true, render `ename: evalue` on a single line (for the
   * single-frame and SyntaxError cases where the two-line header
   * is unnecessary ceremony).
   */
  inlineEvalue?: boolean;
}) {
  // Caller already decides whether inlining is appropriate (short,
  // single-line evalues). Trust that here so the two layouts don't
  // disagree on edge cases.
  const canInline = inlineEvalue && Boolean(evalue);
  return (
    <div className="flex items-start gap-2 px-2 py-2 font-mono">
      <OctagonAlert
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        strokeWidth={2.5}
      />
      <div className="min-w-0 flex-1">
        {canInline ? (
          <div>
            <span className="font-semibold text-destructive">{ename}</span>
            <span className="text-destructive/80">: </span>
            <span className="whitespace-pre-wrap break-words text-foreground/85">{evalue}</span>
          </div>
        ) : (
          <>
            <div className="font-semibold text-destructive">{ename}</div>
            {evalue && (
              <div className="mt-0.5 whitespace-pre-wrap break-words text-foreground/85">
                {evalue}
              </div>
            )}
          </>
        )}
      </div>
      <CopyButton payload={payload} resolveExecutionTarget={resolveExecutionTarget} />
    </div>
  );
}

/**
 * Parse-error layout. Shows the offending source line with a caret at
 * the `offset` column. No frame list (SyntaxError doesn't have one
 * that'd be useful). If `text` is empty (older Python versions don't
 * always populate it), we show just the header.
 */
function SyntaxErrorBlock({
  syntax,
  language,
  currentExecutionId,
  resolveExecutionTarget,
  onNavigateToCell,
}: {
  syntax: SyntaxInfo;
  language: string;
  currentExecutionId?: string;
  resolveExecutionTarget?: TracebackExecutionResolver;
  onNavigateToCell?: TracebackCellNavigator;
}) {
  const isDark = useDarkMode();
  const rawTheme = useColorTheme();
  const colorTheme = rawTheme === "cream" ? "cream" : "classic";

  if (!syntax.text) {
    return null;
  }

  // `offset` is 1-based (CPython convention). Clamp to the line length
  // so the underline never runs past the content.
  const lineLen = syntax.text.length;
  const startCol = Math.max(1, Math.min(syntax.offset || 1, lineLen + 1));
  // When `end_offset` is known AND on the same line AND past `offset`,
  // underline the whole range. Otherwise fall back to a single caret
  // at `startCol`.
  const sameLine = !syntax.end_lineno || syntax.end_lineno === syntax.lineno;
  const endColRaw = syntax.end_offset ?? 0;
  const endCol = sameLine && endColRaw > startCol ? Math.min(endColRaw, lineLen + 1) : startCol + 1;
  const underlineLen = Math.max(1, endCol - startCol);
  const underlinePadding = " ".repeat(startCol - 1);
  const underline = "^".repeat(underlineLen);

  const gutterWidth = String(syntax.lineno || 1).length;
  const location = sourceLocation(syntax, currentExecutionId, resolveExecutionTarget);

  return (
    <div className="px-2 pb-2">
      <div className="mb-1.5 font-mono text-xs text-muted-foreground" title={location.title}>
        <LocationLabel
          location={location}
          line={syntax.lineno || 1}
          onNavigateToCell={onNavigateToCell}
        />
      </div>
      <pre
        className={cn(
          "overflow-x-auto border-l-2 border-destructive/20 bg-muted/30",
          "px-2 py-1.5 leading-5",
        )}
        style={{ fontFamily: CM_FONT_FAMILY, fontSize: "13px" }}
      >
        <div className="grid grid-cols-[auto_1fr] gap-x-3 border-l-2 border-destructive bg-destructive/10 pl-1.5">
          <span
            className="select-none text-right font-semibold tabular-nums text-destructive"
            style={{ minWidth: `${gutterWidth}ch` }}
          >
            ▸{String(syntax.lineno || 1).padStart(gutterWidth, " ")}
          </span>
          <code className="whitespace-pre">
            {highlight(syntax.text, language, isDark, colorTheme)}
          </code>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 border-l-2 border-transparent pl-1.5">
          <span
            className="select-none text-right tabular-nums text-muted-foreground/50"
            style={{ minWidth: `${gutterWidth}ch` }}
          >
            {" ".repeat(gutterWidth + 1)}
          </span>
          <code className="whitespace-pre font-semibold text-destructive">
            {underlinePadding}
            <span aria-hidden="true">{underline}</span>
          </code>
        </div>
      </pre>
    </div>
  );
}

function CopyButton({
  payload,
  resolveExecutionTarget,
}: {
  payload: TracebackPayload;
  resolveExecutionTarget?: TracebackExecutionResolver;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    const text = tracebackCopyText(payload, resolveExecutionTarget);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Clipboard can fail in some iframe/permission contexts. Fall back
      // silently — users can still select the rendered text by hand.
      console.warn("[traceback] copy failed:", err);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : "Copy traceback"}
      title={copied ? "Copied" : "Copy traceback"}
      className={cn(
        "shrink-0 rounded-sm px-1.5 py-1 text-xs font-mono transition-colors",
        "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <span className="flex items-center gap-1">
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </span>
    </button>
  );
}

function FrameRow({
  cluster,
  defaultOpen,
  language,
  currentExecutionId,
  resolveExecutionTarget,
  onNavigateToCell,
}: {
  cluster: Cluster;
  defaultOpen: boolean;
  language: string;
  currentExecutionId?: string;
  resolveExecutionTarget?: TracebackExecutionResolver;
  onNavigateToCell?: TracebackCellNavigator;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { frame, count } = cluster;
  const location = sourceLocation(frame, currentExecutionId, resolveExecutionTarget);
  return (
    <li className={cn("px-2 py-1.5", frame.library && "opacity-60")}>
      <div className="flex w-full items-center gap-2 font-mono text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          aria-expanded={open}
          aria-label={open ? "Collapse traceback frame" : "Expand traceback frame"}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
          />
        </button>
        <LocationLabel
          location={location}
          line={frame.lineno}
          name={frame.name}
          onNavigateToCell={onNavigateToCell}
        />
        {count > 1 && (
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums",
              "bg-destructive/15 text-destructive",
            )}
            title={`${count} consecutive identical frames (collapsed)`}
          >
            ×{count.toLocaleString()}
          </span>
        )}
      </div>
      {open && frame.lines && frame.lines.length > 0 && (
        <SourceBlock lines={frame.lines} language={language} />
      )}
    </li>
  );
}

interface SourceLocation {
  kind: "notebook" | "file";
  label: string;
  executionId?: string;
  sourceHash?: string;
  target?: TracebackCellTarget;
  title: string;
}

function LocationLabel({
  location,
  line,
  name,
  onNavigateToCell,
}: {
  location: SourceLocation;
  line: number;
  name?: string;
  onNavigateToCell?: TracebackCellNavigator;
}) {
  const displayName = typeof name === "string" ? name : undefined;
  const showName = Boolean(displayName && displayName !== "<module>");
  const target = location.target && onNavigateToCell ? location.target : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={location.title}>
      <span className="shrink-0 text-muted-foreground">Line</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{line}</span>
      <span className="shrink-0 text-muted-foreground">in</span>
      {target ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onNavigateToCell?.(target);
          }}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5",
            "text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
          )}
          aria-label={`Go to cell ${target.cellId}`}
          title={`Go to cell ${target.cellId}`}
        >
          <LocateFixed aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="truncate">{location.label}</span>
        </button>
      ) : (
        <span className="truncate text-muted-foreground">{location.label}</span>
      )}
      {showName && (
        <>
          <span className="shrink-0 text-muted-foreground">in</span>
          <span className="truncate">{displayName}</span>
        </>
      )}
    </span>
  );
}

function sourceLocation(
  source: Pick<
    Frame | SyntaxInfo,
    "filename" | "execution_id" | "cell_id" | "execution_count" | "source_hash" | "source_ref"
  >,
  currentExecutionId: string | undefined,
  resolveExecutionTarget?: TracebackExecutionResolver,
): SourceLocation {
  const sourceRef = isObjectRecord(source.source_ref) ? source.source_ref : undefined;
  const filename = asOptionalString(source.filename) ?? "Unknown source";
  const executionId =
    asOptionalString(sourceRef?.execution_id) ?? asOptionalString(source.execution_id);
  const cellId = asOptionalString(sourceRef?.cell_id) ?? asOptionalString(source.cell_id);
  const sourceHash =
    asOptionalString(sourceRef?.source_hash) ?? asOptionalString(source.source_hash);
  const compiledFilename = asOptionalString(sourceRef?.compiled_filename) ?? filename;
  const titleParts = [];
  if (executionId) titleParts.push(`Execution: ${executionId}`);
  if (sourceHash) titleParts.push(`Source: ${sourceHash}`);
  if (compiledFilename) titleParts.push(`Compiled file: ${compiledFilename}`);

  const isNotebookSource =
    sourceRef?.kind === "notebook_execution" || isSyntheticNotebookFilename(filename);
  const target =
    (executionId ? (resolveExecutionTarget?.(executionId, sourceHash) ?? null) : null) ??
    (cellId ? { cellId } : null);
  if (target) titleParts.unshift(`Cell: ${target.cellId}`);
  const title = titleParts.join("\n") || filename;

  if (!isNotebookSource) {
    return {
      kind: "file",
      label: shortenPythonPath(filename),
      title,
    };
  }

  if (target) {
    const label =
      target.label ??
      (executionId === currentExecutionId ? "Current Cell" : `Cell ${shortCellId(target.cellId)}`);
    return {
      kind: "notebook",
      label,
      executionId,
      sourceHash,
      target,
      title,
    };
  }

  if (executionId && executionId === currentExecutionId) {
    return {
      kind: "notebook",
      label: "Current Cell",
      executionId,
      sourceHash,
      title,
    };
  }

  if (executionId) {
    return {
      kind: "notebook",
      label: "Notebook Execution",
      executionId,
      sourceHash,
      title,
    };
  }

  return {
    kind: "notebook",
    label: "Notebook Cell",
    sourceHash,
    title,
  };
}

function shortCellId(cellId: string): string {
  return cellId.length <= 12 ? cellId : cellId.slice(0, 8);
}

function shortenPythonPath(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const sitePackages = normalized.match(/(?:^|\/)(?:site-packages|dist-packages)\/(.+)$/);
  const packagePath = sitePackages?.[1];
  if (packagePath && /^[\w.-]+(?:\/[\w.-]+)*\.py[wi]?$/.test(packagePath)) {
    return `.../${packagePath}`;
  }

  return filename;
}

function isSyntheticNotebookFilename(filename: string): boolean {
  if (!filename) return false;
  return (
    /^<ipython-input-\d+-[^>]+>$/.test(filename) ||
    /(?:^|[/\\])ipykernel_\d+[/\\][^/\\]+\.py$/.test(filename)
  );
}

function tracebackCopyText(
  payload: TracebackPayload,
  resolveExecutionTarget?: TracebackExecutionResolver,
): string {
  const synthesized = synthesizeTracebackText(payload, resolveExecutionTarget);
  if (synthesized) return synthesized;
  return (
    payload.text ??
    (payload.raw && payload.raw.length > 0
      ? `${payload.raw.join("\n")}\n${payload.ename}: ${payload.evalue}`
      : `${payload.ename}: ${payload.evalue}`)
  );
}

function synthesizeTracebackText(
  payload: TracebackPayload,
  resolveExecutionTarget?: TracebackExecutionResolver,
): string | null {
  const frames = payload.frames ?? [];
  const currentExecutionId = payload.execution?.execution_id;
  const hasNotebookSource =
    (payload.syntax && isNotebookSource(payload.syntax)) || frames.some(isNotebookSource);
  if (!hasNotebookSource) {
    return null;
  }

  const out = ["Traceback (most recent call last):"];
  if (payload.syntax) {
    out.push(`  ${copyLocationLine(payload.syntax, currentExecutionId, resolveExecutionTarget)}`);
    if (payload.syntax.text) {
      out.push(`    ${payload.syntax.text}`);
      const caret = syntaxCaretLine(payload.syntax);
      if (caret) out.push(`    ${caret}`);
    }
  } else {
    for (const frame of frames) {
      out.push(
        `  ${copyLocationLine(frame, currentExecutionId, resolveExecutionTarget, frame.name)}`,
      );
      const source = highlightedSourceLine(frame.lines);
      if (source) out.push(`    ${source}`);
    }
  }
  out.push(`${payload.ename}: ${payload.evalue}`);
  return out.join("\n");
}

function copyLocationLine(
  source: Pick<
    Frame | SyntaxInfo,
    | "filename"
    | "lineno"
    | "execution_id"
    | "cell_id"
    | "execution_count"
    | "source_hash"
    | "source_ref"
  >,
  currentExecutionId: string | undefined,
  resolveExecutionTarget?: TracebackExecutionResolver,
  name?: string,
): string {
  if (!isNotebookSource(source)) {
    return `File "${source.filename || "<unknown>"}", line ${source.lineno}, in ${
      name || "<module>"
    }`;
  }

  const location = sourceLocation(source, currentExecutionId, resolveExecutionTarget);
  let line = `Line ${source.lineno} in ${location.label}`;
  const details = [];
  if (location.target) details.push(`cell_id=${location.target.cellId}`);
  if (location.executionId) details.push(`execution_id=${location.executionId}`);
  if (location.sourceHash) details.push(`source_hash=${location.sourceHash}`);
  if (details.length > 0) line += ` (${details.join(", ")})`;
  if (name && name !== "<module>") line += `, in ${name}`;
  return line;
}

function isNotebookSource(source: Pick<Frame | SyntaxInfo, "filename" | "source_ref">): boolean {
  const sourceRef = isObjectRecord(source.source_ref) ? source.source_ref : undefined;
  const filename = asOptionalString(source.filename) ?? "";
  return sourceRef?.kind === "notebook_execution" || isSyntheticNotebookFilename(filename);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function highlightedSourceLine(lines: Line[] | undefined): string | undefined {
  if (!lines || lines.length === 0) return undefined;
  return lines.find((line) => line.highlight)?.source ?? lines[0]?.source;
}

function syntaxCaretLine(syntax: SyntaxInfo): string | undefined {
  if (!syntax.text) return undefined;
  const lineLen = syntax.text.length;
  const startCol = Math.max(1, Math.min(syntax.offset || 1, lineLen + 1));
  const sameLine = !syntax.end_lineno || syntax.end_lineno === syntax.lineno;
  const endColRaw = syntax.end_offset ?? 0;
  const endCol = sameLine && endColRaw > startCol ? Math.min(endColRaw, lineLen + 1) : startCol + 1;
  return " ".repeat(startCol - 1) + "^".repeat(Math.max(1, endCol - startCol));
}

function SourceBlock({ lines, language }: { lines: Line[]; language: string }) {
  const isDark = useDarkMode();
  const rawTheme = useColorTheme();
  const colorTheme = rawTheme === "cream" ? "cream" : "classic";

  const gutterWidth = String(Math.max(...lines.map((l) => l.lineno))).length;

  return (
    <pre
      className={cn(
        "mt-1.5 overflow-x-auto border-l-2 border-destructive/20 bg-muted/30",
        "px-2 py-1.5 leading-5",
      )}
      style={{ fontFamily: CM_FONT_FAMILY, fontSize: "13px" }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "grid grid-cols-[auto_1fr] gap-x-3 border-l-2 border-transparent pl-1.5",
            line.highlight && "border-destructive bg-destructive/10",
          )}
        >
          <span
            className={cn(
              "select-none text-right tabular-nums text-muted-foreground/70",
              line.highlight && "font-semibold text-destructive",
            )}
            style={{ minWidth: `${gutterWidth}ch` }}
          >
            {line.highlight ? "▸" : " "}
            {String(line.lineno).padStart(gutterWidth, " ")}
          </span>
          <code className="whitespace-pre">
            {highlight(line.source, language, isDark, colorTheme)}
          </code>
        </div>
      ))}
    </pre>
  );
}

function RawJsonFallback({ data, className }: { data: unknown; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md border border-yellow-300 bg-yellow-50/60 p-3 text-xs",
        "dark:border-yellow-800 dark:bg-yellow-950/30",
        className,
      )}
    >
      <div className="mb-1 font-semibold text-yellow-800 dark:text-yellow-200">
        Unparsed traceback payload
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-yellow-900/80 dark:text-yellow-100/80">
        {safeStringify(data)}
      </pre>
    </div>
  );
}

// ─── Payload normalization ─────────────────────────────────────────────

function toPayload(data: unknown): TracebackPayload | null {
  // Payloads arrive as either an object (already parsed) or a JSON string
  // (when a kernel sends it through paths that stringify custom +json).
  let obj: unknown = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.ename !== "string" || typeof o.evalue !== "string") {
    return null;
  }
  return {
    ename: o.ename,
    evalue: o.evalue,
    frames: Array.isArray(o.frames) ? (o.frames as Frame[]) : undefined,
    language: typeof o.language === "string" ? o.language : undefined,
    execution: isExecutionInfo(o.execution) ? o.execution : undefined,
    text: typeof o.text === "string" ? o.text : undefined,
    raw_text: typeof o.raw_text === "string" ? o.raw_text : undefined,
    raw: Array.isArray(o.raw) ? (o.raw as string[]) : undefined,
    syntax: isSyntaxInfo(o.syntax) ? o.syntax : undefined,
  };
}

function isSyntaxInfo(v: unknown): v is SyntaxInfo {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.filename === "string" &&
    typeof s.lineno === "number" &&
    typeof s.offset === "number" &&
    typeof s.text === "string" &&
    typeof s.msg === "string"
  );
  // end_lineno / end_offset are optional — we don't require them.
}

function isExecutionInfo(v: unknown): v is ExecutionInfo {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    (e.execution_id === undefined || typeof e.execution_id === "string") &&
    (e.execution_count === undefined || typeof e.execution_count === "number")
  );
}

function safeStringify(x: unknown): string {
  try {
    return typeof x === "string" ? x : JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}
