import { BookOpen, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export type NotebookEditMode = "view" | "edit";
export type NotebookEditModeState = "viewing" | "requested" | "editing";

export interface NotebookEditModeButtonProps {
  mode: NotebookEditMode;
  state: NotebookEditModeState;
  onModeChange: (mode: NotebookEditMode) => void;
  disabled?: boolean;
  className?: string;
}

export function NotebookEditModeButton({
  className,
  disabled = false,
  mode,
  onModeChange,
  state,
}: NotebookEditModeButtonProps) {
  const requestingEdit = mode === "edit";
  const nextMode: NotebookEditMode = requestingEdit ? "view" : "edit";
  const label = requestingEdit ? "View" : "Edit";
  const title = requestingEdit
    ? state === "editing"
      ? "Return to read-only viewing"
      : "Stop requesting edit access"
    : "Request edit access";

  return (
    <button
      type="button"
      aria-pressed={requestingEdit}
      className={cn(
        "inline-flex h-8 max-w-[min(12rem,38vw)] min-w-0 items-center justify-center gap-1.5 rounded-full border border-border bg-background/90 px-3 text-sm text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
        state === "editing" && "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
        state === "requested" && "border-ring/50 text-foreground",
        className,
      )}
      data-slot="notebook-edit-mode-button"
      data-state={state}
      disabled={disabled}
      title={title}
      onClick={() => onModeChange(nextMode)}
    >
      {requestingEdit ? (
        <BookOpen className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Pencil className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate leading-none">{label}</span>
    </button>
  );
}
