import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
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
  const hasQuery = query.length > 0;
  const hasMatches = matchCount > 0;

  return (
    <div
      data-slot="global-find-bar"
      className="flex items-center gap-2 border-b bg-background/95 px-3 py-1.5"
    >
      <div className="flex min-w-0 max-w-md flex-[1_1_24rem] items-center gap-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
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
          className="-mx-1 h-7 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:bg-muted/55 focus-visible:outline-none"
          aria-label="Search notebook"
        />
      </div>
      <span className="h-px min-w-8 flex-1 rounded-full bg-border/35" aria-hidden="true" />
      <span
        data-slot="global-find-match-count"
        className={
          hasMatches
            ? "min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground"
            : hasQuery
              ? "min-w-[4.5rem] text-center text-xs font-medium tabular-nums text-destructive/75"
              : "min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground/55"
        }
      >
        {matchLabel}
      </span>
      <button
        type="button"
        onClick={onPrevMatch}
        disabled={matchCount === 0}
        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        onClick={onNextMatch}
        disabled={matchCount === 0}
        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="Close (Escape)"
        aria-label="Close find bar"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
