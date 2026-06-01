import { memo, useCallback, useDeferredValue, useMemo, type Ref } from "react";
import { StaticCodeBlock } from "@/components/editor/static-highlight";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";

export interface HistorySearchEntry {
  session: number;
  line: number;
  source: string;
}

export interface HistorySearchDialogViewProps<
  Entry extends HistorySearchEntry = HistorySearchEntry,
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: Entry[];
  isLoading: boolean;
  error: string | null;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onSelectEntry: (entry: Entry) => void;
  inputRef?: Ref<HTMLInputElement>;
  maxPreviewLines?: number;
  title?: string;
  description?: string;
  placeholder?: string;
}

const CodePreview = memo(function CodePreview({
  code,
  maxLines = 8,
}: {
  code: string;
  maxLines?: number;
}) {
  const isDark = useDarkMode();
  const colorTheme = (useColorTheme() ?? "classic") as "classic" | "cream";

  const lines = code.split("\n");
  const truncated = lines.length > maxLines;
  const displayCode = truncated ? `${lines.slice(0, maxLines).join("\n")}\n...` : code;

  return (
    <StaticCodeBlock
      code={displayCode}
      language="python"
      isDark={isDark}
      colorTheme={colorTheme}
      className="!m-0 !p-2 !text-xs !leading-[1.4] !bg-transparent overflow-hidden"
    />
  );
});

export function HistorySearchDialogView<Entry extends HistorySearchEntry>({
  open,
  onOpenChange,
  entries,
  isLoading,
  error,
  searchValue,
  onSearchValueChange,
  onSelectEntry,
  inputRef,
  maxPreviewLines = 6,
  title = "History Search",
  description = "Search through your IPython command history (Ctrl+R)",
  placeholder = "Search history...",
}: HistorySearchDialogViewProps<Entry>) {
  const deferredSearchValue = useDeferredValue(searchValue);

  const filteredEntries = useMemo(() => {
    if (!deferredSearchValue.trim()) {
      return entries;
    }
    const search = deferredSearchValue.toLowerCase();
    return entries.filter((entry) => entry.source.toLowerCase().includes(search));
  }, [entries, deferredSearchValue]);

  const handleSelect = useCallback(
    (entry: Entry) => {
      onSelectEntry(entry);
    },
    [onSelectEntry],
  );

  const emptyMessage = useMemo(() => {
    if (error) {
      if (error.includes("No kernel running")) {
        return "Start a kernel to search history.";
      }
      return `Error: ${error}`;
    }
    if (isLoading && filteredEntries.length === 0) {
      return "Searching history...";
    }
    if (entries.length === 0) {
      return "No history found.";
    }
    if (filteredEntries.length === 0) {
      return "No matching history.";
    }
    return null;
  }, [error, isLoading, entries.length, filteredEntries.length]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 max-w-2xl" showCloseButton={false}>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            ref={inputRef}
            placeholder={placeholder}
            value={searchValue}
            onValueChange={onSearchValueChange}
          />
          <CommandList className="max-h-[400px]">
            {emptyMessage ? (
              <CommandEmpty>{emptyMessage}</CommandEmpty>
            ) : (
              <CommandGroup heading={`History${isLoading ? " (searching...)" : ""}`}>
                {filteredEntries.map((entry, index) => (
                  <CommandItem
                    key={`${entry.session}-${entry.line}-${index}`}
                    value={`${entry.session}-${entry.line}`}
                    onSelect={() => handleSelect(entry)}
                    className="cursor-pointer"
                  >
                    <div className="w-full overflow-hidden rounded border border-border/50">
                      <CodePreview code={entry.source} maxLines={maxPreviewLines} />
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
