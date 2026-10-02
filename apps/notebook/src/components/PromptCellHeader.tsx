import { Play, Sparkles, Square } from "lucide-react";
import type { PromptMode } from "@/lib/prompt-cells";
import { cn } from "@/lib/utils";

export interface PromptCellHeaderProps {
  mode: PromptMode;
  running: boolean;
  onRun?: () => void;
  onCancel?: () => void;
  onSetMode?: (mode: PromptMode) => void;
}

const modes: { mode: PromptMode; label: string; title: string }[] = [
  { mode: "explore", label: "Explore", title: "The agent answers in the cell below" },
  { mode: "full", label: "Full", title: "The agent may also edit and run the cells above" },
];

export function PromptCellHeader({
  mode,
  running,
  onRun,
  onCancel,
  onSetMode,
}: PromptCellHeaderProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3" aria-hidden="true" />
        Prompt
      </span>
      <div
        role="group"
        aria-label="Agent mode"
        className="flex rounded-full border border-border/60"
      >
        {modes.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            title={option.title}
            disabled={!onSetMode || running}
            onClick={() => onSetMode?.(option.mode)}
            className={cn(
              "rounded-full px-2 text-xs transition-colors",
              mode === option.mode
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="flex-1" />
      {running ? (
        <button
          type="button"
          title="Stop the agent"
          onClick={onCancel}
          disabled={!onCancel}
          className="flex items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Square className="size-3" aria-hidden="true" />
          Stop
        </button>
      ) : (
        <button
          type="button"
          title="Ask the agent (Shift+Enter)"
          onClick={onRun}
          disabled={!onRun}
          className="flex items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Play className="size-3" aria-hidden="true" />
          Run
        </button>
      )}
    </div>
  );
}
