export interface MarkdownHeadingAnchor {
  itemId: string;
  title: string;
  level: number;
  anchor?: string | null;
  headingAnchorId: string;
}

export function markdownHeadingAnchorsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): MarkdownHeadingAnchor[] {
  const raw = metadata?.nteractMarkdownHeadingAnchors;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.itemId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.level !== "number" ||
      typeof record.headingAnchorId !== "string"
    ) {
      return [];
    }

    return [
      {
        itemId: record.itemId,
        title: record.title,
        level: record.level,
        anchor: typeof record.anchor === "string" ? record.anchor : null,
        headingAnchorId: record.headingAnchorId,
      },
    ];
  });
}
