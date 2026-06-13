export function notebookRouteSegmentTitle(value: string | null | undefined): string | null {
  const decoded = safeDecodeNotebookRouteSegment(value);
  if (!decoded) {
    return null;
  }
  return humanizeNotebookRouteTitle(decoded);
}

export function humanizeNotebookRouteTitle(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (!word) {
        return word;
      }
      if (/[A-Z]/u.test(word.slice(1))) {
        return word;
      }
      return `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function safeDecodeNotebookRouteSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}
