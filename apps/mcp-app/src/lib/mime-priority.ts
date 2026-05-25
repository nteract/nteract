const VISUAL_MIME_PRIORITY = [
  // Visualizations (highest priority - rich interactive content)
  "application/vnd.plotly.v1+json",
] as const;

const VERSIONED_VEGA_MIME_PRIORITY = [
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
] as const;

const MIME_PRIORITY_AFTER_VERSIONED_VEGA = [
  "application/geo+json",
  // Data tables (Arrow IPC/parquet -> Sift renderer)
  "application/vnd.nteract.arrow-stream-manifest+json",
  "application/vnd.apache.arrow.stream",
  "application/vnd.apache.parquet",
  // Rich text
  "text/html",
  "text/markdown",
  "text/latex",
  // Images
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // Structured data
  "application/json",
  // Plain text (fallback)
  "text/plain",
] as const;

/**
 * MIME type priority for MCP App output rendering.
 * Higher priority types are preferred when multiple are available.
 */
export const MIME_PRIORITY: readonly string[] = [
  ...VISUAL_MIME_PRIORITY,
  ...VERSIONED_VEGA_MIME_PRIORITY,
  ...MIME_PRIORITY_AFTER_VERSIONED_VEGA,
];

/**
 * Check if a MIME type is a Vega or Vega-Lite variant.
 */
export function isVegaMimeType(mime: string): boolean {
  return /^application\/vnd\.vega(lite)?\.v\d/.test(mime);
}

/**
 * Select the best MIME type to render from available data.
 * Returns null if nothing renderable is found.
 */
export function selectMimeType(data: Record<string, unknown>): string | null {
  const available = Object.keys(data).filter(
    (k) => data[k] != null && k !== "text/llm+plain",
  );

  for (const mime of VISUAL_MIME_PRIORITY) {
    if (available.includes(mime)) return mime;
  }

  for (const mime of VERSIONED_VEGA_MIME_PRIORITY) {
    if (available.includes(mime)) return mime;
  }

  // Check for future Vega/Vega-Lite variants before falling back to HTML.
  const vegaMime = available.find(isVegaMimeType);
  if (vegaMime) return vegaMime;

  for (const mime of MIME_PRIORITY_AFTER_VERSIONED_VEGA) {
    if (available.includes(mime)) return mime;
  }

  // Fallback: first available type
  return available[0] ?? null;
}
