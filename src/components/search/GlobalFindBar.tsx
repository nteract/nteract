import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

export interface GlobalFindBarProps {
  query: string;
  matchCount: number;
  currentMatchIndex: number;
  onQueryChange: (query: string) => void;
  onNextMatch: () => void;
  onPrevMatch: () => void;
  onClose: () => void;
}

export function GlobalFindBar({
  query,
  matchCount,
  currentMatchIndex,
  onQueryChange,
  onNextMatch,
  onPrevMatch,
  onClose,
}: GlobalFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        onPrevMatch();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onNextMatch();
      }
    },
    [onClose, onNextMatch, onPrevMatch],
  );

  const matchLabel =
    query && matchCount > 0
      ? `${currentMatchIndex + 1} of ${matchCount}`
      : query
        ? "No results"
        : "";

  return (
    <div className="flex items-center gap-1.5 border-b bg-background px-3 py-1.5 shadow-sm">
      <div className="relative flex-1 max-w-sm">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in notebook..."
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="h-7 w-full rounded border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Search notebook"
        />
      </div>
      <span className="text-xs text-muted-foreground min-w-[5rem] text-center tabular-nums">
        {matchLabel}
      </span>
      <button
        type="button"
        onClick={onPrevMatch}
        disabled={matchCount === 0}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition-colors"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onNextMatch}
        disabled={matchCount === 0}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition-colors"
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Close (Escape)"
        aria-label="Close find bar"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
