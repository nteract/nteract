import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistorySearchDialogView } from "@/components/search";
import { type HistoryEntry, useHistorySearch } from "../hooks/useHistorySearch";

interface HistorySearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (source: string) => void;
  initialQuery?: string;
}

export function HistorySearchDialog({
  open,
  onOpenChange,
  onSelect,
  initialQuery = "",
}: HistorySearchDialogProps) {
  const { entries, isLoading, error, searchHistory, clearEntries } = useHistorySearch();
  const [searchValue, setSearchValue] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextDebouncedSearchRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shouldPlaceCaretAtEndRef = useRef(false);

  // Fetch initial history (Tail) when dialog opens
  useEffect(() => {
    if (open) {
      const query = initialQuery.trim();
      skipNextDebouncedSearchRef.current = true;
      shouldPlaceCaretAtEndRef.current = true;
      setSearchValue(query);
      searchHistory(query || undefined);
    } else {
      clearEntries();
      setSearchValue("");
      skipNextDebouncedSearchRef.current = false;
      shouldPlaceCaretAtEndRef.current = false;
    }
  }, [open, initialQuery, searchHistory, clearEntries]);

  useLayoutEffect(() => {
    if (!open || !shouldPlaceCaretAtEndRef.current) return;
    const input = inputRef.current;
    if (!input || input.value !== searchValue) return;

    shouldPlaceCaretAtEndRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      input.focus();
      const caret = input.value.length;
      input.setSelectionRange(caret, caret);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, searchValue]);

  useEffect(() => {
    if (!open) return;

    if (skipNextDebouncedSearchRef.current) {
      skipNextDebouncedSearchRef.current = false;
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      // Only call kernel search if there's a non-empty search term
      if (searchValue.trim()) {
        searchHistory(searchValue.trim());
      } else {
        // Empty search = fetch tail again
        searchHistory();
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchValue, open, searchHistory]);

  const handleSelectEntry = useCallback(
    (entry: HistoryEntry) => {
      onSelect(entry.source);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <HistorySearchDialogView
      open={open}
      onOpenChange={onOpenChange}
      entries={entries}
      isLoading={isLoading}
      error={error}
      searchValue={searchValue}
      onSearchValueChange={setSearchValue}
      onSelectEntry={handleSelectEntry}
      inputRef={inputRef}
    />
  );
}
