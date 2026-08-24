import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";
import { wireCommentAffordanceMotion } from "./comment-affordance-motion";
import { COMMENT_SELECTION_BADGE_CLASS } from "./comment-selection-badge";

export interface CommentSelectionAffordanceProps {
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
  testId?: string;
}

/**
 * The "comment on selection" affordance: a "Comment" badge beside the selection,
 * styled with the shared badge primitive so it matches every other badge in the app.
 * It mounts open, shrinks to a dot after a beat of no interaction, and springs back
 * open on hover or focus (comment-affordance-motion.ts). The CodeMirror source plane
 * builds the same markup and wires the same motion in
 * `apps/notebook/src/lib/source-comment-extension.ts`; the wrapper's layout lives in
 * `styles/comment-affordance.css`, so both planes stay in step.
 */
export function CommentSelectionAffordance({
  onActivate,
  className,
  style,
  label = "Add comment",
  testId,
}: CommentSelectionAffordanceProps) {
  const badgeRef = useRef<HTMLButtonElement>(null);

  // Re-arm on every new selection. React reuses the same DOM node when the
  // affordance moves, so without keying on the position the badge would stay
  // collapsed from the previous selection instead of opening for the new one.
  const left = style?.left;
  const top = style?.top;
  useEffect(() => {
    const badge = badgeRef.current;
    if (!badge) return;
    return wireCommentAffordanceMotion(badge);
  }, [left, top]);

  const keepSelection = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <span className={cn("comment-affordance", className)} style={style}>
      <button
        ref={badgeRef}
        type="button"
        aria-label={label}
        data-testid={testId}
        className={COMMENT_SELECTION_BADGE_CLASS}
        onPointerDown={keepSelection}
        onMouseDown={keepSelection}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivate(event);
        }}
      >
        <span className="comment-affordance-label">Comment</span>
      </button>
    </span>
  );
}