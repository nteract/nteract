"use client";

import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import type { MarkdownProjectionPlan } from "../../../src/lib/markdown-projection";

const commentHighlightPlan: MarkdownProjectionPlan = {
  version: 1,
  engine: "elements-fixture",
  byteLength: 113,
  utf16Length: 113,
  measurement: { estimatedHeight: 96, confidence: "high", width: 760 },
  anchors: [],
  blocks: [
    {
      blockId: "open-paragraph",
      blockIndex: 0,
      element: "p",
      kind: "paragraph",
      measurement: { estimatedHeight: 40, confidence: "high", width: 760 },
      sourceSpanByte: [0, 53],
      sourceSpanUtf16: [0, 53],
      syntaxSpans: [],
      text: "Open thread text is highlighted in rendered markdown.",
    },
    {
      blockId: "resolved-paragraph",
      blockIndex: 1,
      element: "p",
      kind: "paragraph",
      measurement: { estimatedHeight: 40, confidence: "high", width: 760 },
      sourceSpanByte: [60, 113],
      sourceSpanUtf16: [60, 113],
      syntaxSpans: [],
      text: "Resolved thread keeps the same surface in muted state.",
    },
  ],
  runs: [
    {
      blockId: "open-paragraph",
      inlineId: "open-highlight",
      listItemIndex: null,
      renderedText: "Open thread text",
      renderedTextUtf16: [0, 16],
      semantic: "text",
      sourceSpanByte: [0, 16],
      sourceSpanUtf16: [0, 16],
    },
    {
      blockId: "open-paragraph",
      inlineId: "open-rest",
      listItemIndex: null,
      renderedText: " is highlighted in rendered markdown.",
      renderedTextUtf16: [16, 53],
      semantic: "text",
      sourceSpanByte: [16, 53],
      sourceSpanUtf16: [16, 53],
    },
    {
      blockId: "resolved-paragraph",
      inlineId: "resolved-highlight",
      listItemIndex: null,
      renderedText: "Resolved thread",
      renderedTextUtf16: [60, 75],
      semantic: "text",
      sourceSpanByte: [60, 75],
      sourceSpanUtf16: [60, 75],
    },
    {
      blockId: "resolved-paragraph",
      inlineId: "resolved-rest",
      listItemIndex: null,
      renderedText: " keeps the same surface in muted state.",
      renderedTextUtf16: [75, 113],
      semantic: "text",
      sourceSpanByte: [75, 113],
      sourceSpanUtf16: [75, 113],
    },
  ],
};

export function CommentHighlightSurfacesExample() {
  return (
    <div className="not-prose my-6">
      <article className="mx-auto max-w-[760px] border border-border bg-background px-6 py-5 text-foreground shadow-sm max-sm:px-4">
        <ProjectedMarkdownView
          plan={commentHighlightPlan}
          commentHighlights={[
            { from: 0, to: 16, color: "#16a34a", resolved: false },
            { from: 60, to: 75, color: "#7c3aed", resolved: true },
          ]}
        />
      </article>
    </div>
  );
}
