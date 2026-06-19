import { MessageSquarePlus } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";

export interface CommentSelectionAffordanceProps {
  /** Fires on click or keyboard activation. Receives the button event so the
   *  host can fall back to the button rect when there is no selection rect. */
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Positioning and any extra classes from the host plane. */
  className?: string;
  style?: CSSProperties;
  label?: string;
  testId?: string;
}

/**
 * The "comment on selection" affordance: a small resting dot that grows in place
 * into a comment button on hover or focus. Shared by the code-editor and
 * rendered-markdown planes; the visual lives in styles/comment-affordance.css so
 * both surfaces match and stay tunable in one place (shown in Elements).
 */
export function CommentSelectionAffordance({
  onActivate,
  className,
  style,
  label = "Add comment",
  testId,
}: CommentSelectionAffordanceProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
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
        <MessageSquarePlus className="comment-affordance-icon" aria-hidden="true" />
      </span>
    </button>
  );
}
