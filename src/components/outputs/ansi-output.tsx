import Anser from "anser";
import { escapeCarriageReturn } from "escape-carriage";
import { X } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Theme-aware ANSI color mapping.
 *
 * We call anser's ansiToJson with use_classes: true so it gives us structured
 * data we can remap. The base 16 ANSI colors go through CSS variables so they
 * adapt to light/dark mode. Extended colors (256-color palette and 24-bit
 * truecolor) render as inline rgb() styles since they're already precise.
 *
 * anser returns these shapes in class mode:
 *
 *   Standard 16:    fg = "ansi-red",           fg_truecolor = null
 *   256 (0-15):     fg = "ansi-red" etc,       fg_truecolor = null
 *   256 (16-255):   fg = "ansi-palette-123",   fg_truecolor = null
 *   24-bit RGB:     fg = "ansi-truecolor",     fg_truecolor = "237, 17, 128"
 *   No color:       fg = null,                 fg_truecolor = null
 */

// The 16 class names anser emits for standard colors.
const ANSI_CLASS_NAMES = new Set([
  "ansi-black",
  "ansi-red",
  "ansi-green",
  "ansi-yellow",
  "ansi-blue",
  "ansi-magenta",
  "ansi-cyan",
  "ansi-white",
  "ansi-bright-black",
  "ansi-bright-red",
  "ansi-bright-green",
  "ansi-bright-yellow",
  "ansi-bright-blue",
  "ansi-bright-magenta",
  "ansi-bright-cyan",
  "ansi-bright-white",
]);

function isStandardColor(name: string | null): boolean {
  return name !== null && ANSI_CLASS_NAMES.has(name);
}

function isPaletteColor(name: string | null): boolean {
  return !!name?.startsWith("ansi-palette-");
}

/**
 * Resolve a 256-color palette index to an rgb() string.
 *
 * Indices 0-15 are handled by anser as standard class names.
 * Indices 16-231 are a 6×6×6 color cube.
 * Indices 232-255 are a grayscale ramp.
 */
function paletteIndexToRgb(index: number): string {
  if (index >= 16 && index <= 231) {
    const adjusted = index - 16;
    const r = Math.floor(adjusted / 36);
    const g = Math.floor((adjusted % 36) / 6);
    const b = adjusted % 6;
    return `rgb(${r ? r * 40 + 55 : 0}, ${g ? g * 40 + 55 : 0}, ${b ? b * 40 + 55 : 0})`;
  }
  if (index >= 232 && index <= 255) {
    const level = (index - 232) * 10 + 8;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return "inherit";
}

/**
 * Parse an anser JSON entry's color fields into a React style + className.
 */
function resolveAnsiStyle(entry: Anser.AnserJsonEntry): {
  style: CSSProperties;
  className: string;
} {
  const style: CSSProperties = {};
  const classes: string[] = [];

  // Foreground
  if (entry.fg) {
    if (isStandardColor(entry.fg)) {
      // Use CSS variable via class: .ansi-red-fg { color: var(--ansi-red) }
      classes.push(`${entry.fg}-fg`);
    } else if (entry.fg === "ansi-truecolor" && entry.fg_truecolor) {
      style.color = `rgb(${entry.fg_truecolor})`;
    } else if (isPaletteColor(entry.fg)) {
      const index = parseInt(entry.fg.replace("ansi-palette-", ""), 10);
      style.color = paletteIndexToRgb(index);
    }
  }

  // Background
  if (entry.bg) {
    if (isStandardColor(entry.bg)) {
      classes.push(`${entry.bg}-bg`);
    } else if (entry.bg === "ansi-truecolor" && entry.bg_truecolor) {
      style.backgroundColor = `rgb(${entry.bg_truecolor})`;
    } else if (isPaletteColor(entry.bg)) {
      const index = parseInt(entry.bg.replace("ansi-palette-", ""), 10);
      style.backgroundColor = paletteIndexToRgb(index);
    }
  }

  // Decorations
  for (const decoration of entry.decorations) {
    switch (decoration) {
      case "bold":
        style.fontWeight = "bold";
        break;
      case "dim":
        style.opacity = 0.5;
        break;
      case "italic":
        style.fontStyle = "italic";
        break;
      case "hidden":
        style.visibility = "hidden";
        break;
      case "strikethrough":
        style.textDecoration =
          style.textDecoration === "underline" ? "underline line-through" : "line-through";
        break;
      case "underline":
        style.textDecoration =
          style.textDecoration === "line-through" ? "underline line-through" : "underline";
        break;
    }
  }

  return { style, className: classes.join(" ") };
}

/**
 * Backspace handling ported from ansi-to-react (originally from Jupyter Classic).
 */
function fixBackspace(txt: string): string {
  let result = txt;
  let previous: string;
  do {
    previous = result;
    // eslint-disable-next-line no-control-regex -- intentional backspace (\x08) matching
    result = result.replace(/[^\n]\x08/gm, "");
  } while (result.length < previous.length);
  return result;
}

/**
 * Parse ANSI text into structured JSON entries using anser.
 */
function ansiToJson(input: string): Anser.AnserJsonEntry[] {
  const cleaned = escapeCarriageReturn(fixBackspace(input));
  return Anser.ansiToJson(cleaned, {
    json: true,
    remove_empty: true,
    use_classes: true,
  });
}

/**
 * Render parsed ANSI entries to React spans.
 */
function renderAnsiEntries(entries: Anser.AnserJsonEntry[]): ReactNode[] {
  return entries.map((entry, i) => {
    const { style, className } = resolveAnsiStyle(entry);
    const hasStyle = Object.keys(style).length > 0;
    const hasClass = className.length > 0;

    if (!hasStyle && !hasClass) {
      return <span key={i}>{entry.content}</span>;
    }

    return (
      <span
        key={i}
        style={hasStyle ? style : undefined}
        className={hasClass ? className : undefined}
      >
        {entry.content}
      </span>
    );
  });
}

// ---------------------------------------------------------------------------
// Public components
// ---------------------------------------------------------------------------

interface AnsiOutputProps {
  children: string;
  className?: string;
  isError?: boolean;
}

/**
 * AnsiOutput renders ANSI escape sequences as colored text.
 *
 * Standard 16 colors use CSS variables (theme-aware, adapts to light/dark).
 * 256-color and 24-bit truecolor use inline rgb() styles for full fidelity.
 */
export function AnsiOutput({ children, className = "", isError = false }: AnsiOutputProps) {
  if (!children || typeof children !== "string") {
    return null;
  }

  const entries = ansiToJson(children);

  return (
    <div
      data-slot="ansi-output"
      className={cn(
        "not-prose font-mono text-sm whitespace-pre-wrap leading-relaxed",
        isError && "text-red-600 dark:text-red-400",
        className,
      )}
    >
      <code>{renderAnsiEntries(entries)}</code>
    </div>
  );
}

interface AnsiStreamOutputProps {
  text: string;
  streamName: "stdout" | "stderr";
  className?: string;
}

const STREAM_PREVIEW_LINE_LIMIT = 160;
const STREAM_PREVIEW_CHAR_LIMIT = 24_000;
const STREAM_PREVIEW_HEAD_LINES = 7;
const STREAM_PREVIEW_TAIL_LINES = 20;

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function buildStreamPreview(text: string): {
  lineCount: number;
  isLong: boolean;
  previewText: string;
  omittedLines: number;
} {
  const lines = splitLines(text);
  const lineCount = lines.length;
  const isLong = lineCount > STREAM_PREVIEW_LINE_LIMIT || text.length > STREAM_PREVIEW_CHAR_LIMIT;

  if (!isLong) {
    return { lineCount, isLong, previewText: text, omittedLines: 0 };
  }

  const head = lines.slice(0, STREAM_PREVIEW_HEAD_LINES);
  const tail = lines.slice(-STREAM_PREVIEW_TAIL_LINES);
  const omittedLines = Math.max(0, lineCount - head.length - tail.length);
  const omittedMarker =
    omittedLines > 0 ? [`\n... ${omittedLines.toLocaleString()} lines omitted ...\n`] : [];

  return {
    lineCount,
    isLong,
    previewText: [...head, ...omittedMarker, ...tail].join("\n"),
    omittedLines,
  };
}

/**
 * AnsiStreamOutput component specifically for stdout/stderr rendering.
 */
export function AnsiStreamOutput({ text, streamName, className = "" }: AnsiStreamOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => buildStreamPreview(text), [text]);
  const isStderr = streamName === "stderr";
  const streamClasses = isStderr
    ? "text-red-600 dark:text-red-400"
    : "text-gray-700 dark:text-gray-300";
  const displayedText = preview.isLong && !expanded ? preview.previewText : text;
  const label = streamName === "stderr" ? "stderr" : "stdout";

  return (
    <div data-slot="ansi-stream-output" className={cn("not-prose py-2", streamClasses, className)}>
      {preview.isLong && (
        <div
          className={cn(
            "mb-2 flex flex-wrap items-center gap-2 text-xs leading-none",
            isStderr ? "text-red-700/80 dark:text-red-300/80" : "text-muted-foreground/70",
          )}
        >
          <span className="font-mono font-semibold">{label}</span>
          <span
            className={cn(
              "h-px min-w-8 flex-1 rounded-full",
              isStderr ? "bg-red-500/20 dark:bg-red-300/20" : "bg-border/20",
            )}
            aria-hidden="true"
          />
          <span className="tabular-nums">
            {preview.lineCount.toLocaleString()} lines · {formatBytes(text.length)}
          </span>
          {!expanded && preview.omittedLines > 0 && (
            <span className="tabular-nums text-muted-foreground/55">
              {preview.omittedLines.toLocaleString()} lines hidden
            </span>
          )}
          <button
            type="button"
            className={cn(
              "rounded-sm px-1.5 py-1 font-medium transition-colors",
              isStderr
                ? "hover:bg-red-500/10 hover:text-red-700 dark:hover:bg-red-300/10 dark:hover:text-red-200"
                : "hover:bg-muted hover:text-foreground",
            )}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse log" : "Show full log"}
          >
            {expanded ? "Collapse" : "Show full"}
          </button>
        </div>
      )}
      <AnsiOutput isError={isStderr}>{displayedText}</AnsiOutput>
    </div>
  );
}

interface AnsiErrorOutputProps {
  ename?: string;
  evalue?: string;
  traceback?: string[] | string;
  className?: string;
}

/**
 * AnsiErrorOutput component specifically for error messages and tracebacks.
 */
export function AnsiErrorOutput({
  ename,
  evalue,
  traceback,
  className = "",
}: AnsiErrorOutputProps) {
  const headline = ename && evalue ? `${ename}: ${evalue}` : (ename ?? evalue ?? "Error");
  const tracebackText = Array.isArray(traceback) ? traceback.join("\n") : traceback;

  return (
    <div
      data-slot="ansi-error-output"
      className={cn(
        "not-prose my-1 rounded-md border border-destructive/15 bg-destructive/[0.018]",
        "px-2 py-1.5 text-sm shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-1 py-1.5 font-mono">
        <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-destructive" strokeWidth={2.5} />
        <div className="min-w-0 truncate font-semibold text-destructive">{headline}</div>
        <div className="h-px min-w-6 flex-1 bg-destructive/10" />
      </div>
      {tracebackText && (
        <div className="mx-1 mb-1 rounded-sm bg-background/55 px-2 py-1.5">
          <AnsiOutput isError className="text-xs leading-5 text-destructive/80">
            {tracebackText}
          </AnsiOutput>
        </div>
      )}
    </div>
  );
}
