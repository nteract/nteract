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
          A small author-colored dot that breathes at rest, peeks open once when it appears so you
          can tell what it is, then springs into a "Comment" speech bubble on hover or keyboard
          focus. No icon: the bubble shape is the cue. The editor and rendered-markdown planes share
          this one surface, tunable here via <code>--comment-affordance-color</code>.
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
                label="Comment"
                onActivate={() => undefined}
                style={authorColor(sample.color)}
              />
            </span>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Hover a dot, or tab to it. Respects <code>prefers-reduced-motion</code>.
        </p>
      </div>
    </div>
  );
}
