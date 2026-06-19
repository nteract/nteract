"use client";

import { CommentSelectionAffordance } from "@/components/comments/CommentSelectionAffordance";

export function CommentSelectionAffordanceExample() {
  return (
    <div className="not-prose my-6">
      <div className="mx-auto max-w-[760px] border border-border bg-background px-6 py-5 text-foreground shadow-sm max-sm:px-4">
        <p className="mb-4 text-sm text-muted-foreground">
          Resting, the affordance is a quiet dot that stays out of the way while you select and copy
          text. Hover it, or focus it with the keyboard, and it grows in place into a comment
          button. The editor and rendered-markdown planes share this one surface.
        </p>
        <div className="flex items-center gap-3 text-sm">
          <CommentSelectionAffordance label="Add comment" onActivate={() => undefined} />
          <span>Hover the dot, or tab to it.</span>
        </div>
      </div>
    </div>
  );
}
