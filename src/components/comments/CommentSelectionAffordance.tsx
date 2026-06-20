import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";

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
  /** Play the one-time appear peek (the dot springs open, then settles to a dot)
   *  so a fresh selection can tell what it is. Defaults to on. */
  peekOnMount?: boolean;
}

const PEEK_MS = 1400;

/**
 * The "comment on selection" affordance: an author-colored dot that breathes at
 * rest, peeks open once when it appears, and springs into a labeled "Comment"
 * speech bubble on hover or focus. No icon: the bubble shape is the cue. Shared
 * by the code-editor and rendered-markdown planes; the visual lives in
 * styles/comment-affordance.css so both surfaces match and stay tunable in
 * Elements.
 */
export function CommentSelectionAffordance({
  onActivate,
  className,
  style,
  label = "Comment",
  testId,
  peekOnMount = true,
}: CommentSelectionAffordanceProps) {
  const [peeking, setPeeking] = useState(peekOnMount);

  useEffect(() => {
    if (!peekOnMount) return;
    const timer = setTimeout(() => setPeeking(false), PEEK_MS);
    return () => clearTimeout(timer);
  }, [peekOnMount]);

  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      className={cn("comment-affordance", peeking && "comment-affordance-peek", className)}
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
