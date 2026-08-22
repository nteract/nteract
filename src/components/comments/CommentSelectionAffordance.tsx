import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";

export interface CommentSelectionAffordanceProps {
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
  testId?: string;
}

export function CommentSelectionAffordance({
  onActivate,
  className,
  style,
  label = "Add comment",
  testId,
}: CommentSelectionAffordanceProps) {
  const keepSelection = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <span className={cn("comment-affordance", className)} style={style}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        className="comment-affordance-button"
        onPointerDown={keepSelection}
        onMouseDown={keepSelection}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivate(event);
        }}
      >
        <svg className="comment-affordance-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M12 7v6" />
          <path d="M9 10h6" />
        </svg>
      </button>
      <span className="comment-affordance-tip" aria-hidden="true">
        Add comment
      </span>
    </span>
  );
}
