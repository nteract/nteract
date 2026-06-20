import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";
import { wireCommentAffordanceMotion } from "./comment-affordance-motion";

export interface CommentSelectionAffordanceProps {
  /** Fires on click or keyboard activation. Receives the button event so the
   *  host can fall back to the button rect when there is no selection rect. */
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Positioning and any extra classes from the host plane. */
  className?: string;
  style?: CSSProperties;
  /** Accessible name (aria-label/title). The bubble always reads "Comment". */
  label?: string;
  testId?: string;
}

/**
 * The "comment on selection" affordance: an author-colored dot that breathes at
 * rest and springs into a labeled "Comment" speech bubble on hover or focus. No
 * icon: the bubble shape is the cue. It never folds out on its own, so dragging a
 * selection (almost always to edit code, not to comment) stays quiet. Shared by
 * the code-editor and rendered-markdown planes; the visual lives in
 * styles/comment-affordance.css so both surfaces match and stay tunable in
 * Elements.
 */
export function CommentSelectionAffordance({
  onActivate,
  className,
  style,
  label = "Comment",
  testId,
}: CommentSelectionAffordanceProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Stage the hover/focus open through the shared Web Animations helper, the same
  // one the editor plane uses, so both surfaces morph identically.
  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;
    return wireCommentAffordanceMotion(el);
  }, []);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      data-testid={testId}
      className={cn("comment-affordance", className)}
      style={style}
      onPointerDown={(event) => {
        // Keep the active text selection while the affordance is pressed.
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate(event);
      }}
    >
      <span className="comment-affordance-dot" aria-hidden="true">
        <span className="comment-affordance-label">Comment</span>
      </span>
    </button>
  );
}
