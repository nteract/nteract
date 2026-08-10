"use client";

import type { CSSProperties } from "react";
import { CommentSelectionAffordance } from "@/components/comments/CommentSelectionAffordance";

function authorColor(color: string): CSSProperties {
  return { "--comment-affordance-color": color } as CSSProperties;
}

const SAMPLES: Array<{ text: string; color: string }> = [
  { text: "selected prose", color: "#6366f1" },
  { text: "another author", color: "#16a34a" },
  { text: "a third voice", color: "#ea580c" },
];

export function CommentSelectionAffordanceExample() {
  return (
    <div className="not-prose my-6">
      <div className="mx-auto max-w-[760px] border border-border bg-background px-6 py-5 text-foreground shadow-sm max-sm:px-4">
        <p className="mb-5 text-sm text-muted-foreground">
          A floating toolbar beside the selection with one add-comment button. Clicking it opens the
          Discussions panel with the selection staged as the draft target, so every comment is
          composed in one place. The editor and rendered-markdown planes share this one surface,
          tinted here via <code>--comment-affordance-color</code>.
        </p>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4 text-sm">
          {SAMPLES.map((sample) => (
            <span
              key={sample.color}
              className="inline-flex items-center gap-1.5 rounded-[3px] px-1 py-0.5"
              style={{ backgroundColor: `color-mix(in srgb, ${sample.color} 20%, transparent)` }}
            >
              <span>{sample.text}</span>
              <CommentSelectionAffordance
                onActivate={() => undefined}
                style={authorColor(sample.color)}
              />
            </span>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Hover a button, or tab to it, for the "Add comment" tooltip.
        </p>
      </div>
    </div>
  );
}
