import type { MarkdownProjectionRun } from "./markdown-projection";

const TASK_MARKER_PATTERN = /\[[ xX]\]/;

export function toggleMarkdownTaskMarker(
  source: string,
  run: Pick<MarkdownProjectionRun, "sourceSpanUtf16">,
  checked: boolean,
): string | null {
  const [spanStart, spanEnd] = run.sourceSpanUtf16;
  if (spanStart < 0 || spanEnd < spanStart || spanEnd > source.length) return null;

  const lineStart = source.lastIndexOf("\n", Math.max(0, spanStart - 1)) + 1;
  const nextLineBreak = source.indexOf("\n", spanEnd);
  const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak;
  const sourceSegment = source.slice(lineStart, lineEnd);
  const markerMatch = TASK_MARKER_PATTERN.exec(sourceSegment);
  if (!markerMatch) return null;

  const markerStart = lineStart + markerMatch.index;
  const markerEnd = markerStart + markerMatch[0].length;
  const nextMarker = checked ? "[x]" : "[ ]";

  return `${source.slice(0, markerStart)}${nextMarker}${source.slice(markerEnd)}`;
}
