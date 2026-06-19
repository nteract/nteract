import { BOKEHJS_EXEC_MIME_TYPE, BOKEHJS_LOAD_MIME_TYPE } from "./bokeh-mime";
import { PANEL_EXEC_MIME_TYPE, PANEL_LOAD_MIME_TYPE } from "./panel-mime";

/**
 * Default MIME type priority order for rendering.
 * Higher priority types are preferred when multiple are available.
 */
export const DEFAULT_PRIORITY = [
  // Our own rich traceback lives at the top — if we minted the MIME we
  // trust it, and no reasonable kernel emits a traceback alongside a
  // widget/plot/dataframe in the same output. Keeping it #1 also means
  // the JSON-tree fallback never wins on a mistyped payload.
  "application/vnd.nteract.traceback+json",
  "application/vnd.jupyter.widget-view+json",
  // Projected markdown is our own structured representation, so it should
  // outrank source markdown and HTML fallbacks when a host supplies it.
  "application/vnd.nteract.markdown+json",
  "application/vnd.plotly.v1+json",
  // Bokeh and Panel emit marker MIMEs alongside text/html and
  // application/javascript. They must win so renderer plugins can coordinate
  // the sibling payloads.
  BOKEHJS_EXEC_MIME_TYPE,
  BOKEHJS_LOAD_MIME_TYPE,
  PANEL_EXEC_MIME_TYPE,
  PANEL_LOAD_MIME_TYPE,
  "application/vnd.vegalite.v6+json",
  "application/vnd.vegalite.v6.json",
  "application/vnd.vegalite.v5+json",
  "application/vnd.vegalite.v5.json",
  "application/vnd.vegalite.v4+json",
  "application/vnd.vegalite.v3+json",
  "application/vnd.vega.v6+json",
  "application/vnd.vega.v6.json",
  "application/vnd.vega.v5+json",
  "application/vnd.vega.v5.json",
  "application/vnd.vega.v4+json",
  "application/geo+json",
  // DataFrames — sift renders Arrow IPC/parquet as an interactive table. Must
  // outrank text/html so pandas's HTML fallback doesn't win when both
  // are present (dx emits table bytes + text/html for rich table outputs).
  "application/vnd.nteract.arrow-stream-manifest+json",
  "application/vnd.apache.arrow.stream",
  "application/vnd.apache.parquet",
  // HTML, PDF, markdown, and LaTeX
  "text/html",
  "application/pdf",
  "text/markdown",
  "text/latex",
  "application/javascript",
  // Images
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  // Audio
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
  // Video
  "video/mp4",
  "video/webm",
  "video/ogg",
  // Structured data
  "application/json",
  // Plain text (fallback)
  "text/plain",
] as const;

const PREVIEW_ONLY_MIME_TYPES = new Set(["text/llm+plain"]);

export type MimeType = (typeof DEFAULT_PRIORITY)[number] | string;

export function isPreviewOnlyMimeType(mimeType: string): boolean {
  return PREVIEW_ONLY_MIME_TYPES.has(mimeType);
}

/**
 * Select the best MIME type from available data based on priority.
 */
export function selectMimeType(
  data: Record<string, unknown>,
  priority: readonly string[] = DEFAULT_PRIORITY,
): MimeType | null {
  const availableTypes = Object.keys(data);
  for (const mimeType of priority) {
    if (
      availableTypes.includes(mimeType) &&
      !isPreviewOnlyMimeType(mimeType) &&
      data[mimeType] != null
    ) {
      return mimeType;
    }
  }
  const firstAvailable = availableTypes.find(
    (type) => !isPreviewOnlyMimeType(type) && data[type] != null,
  );
  return firstAvailable || null;
}
