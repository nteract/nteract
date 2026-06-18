import { BookOpen, Clock3, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotebookInteractionMode, NotebookInteractionState } from "./interaction-mode";

export type NotebookEditMode = NotebookInteractionMode;
export type NotebookEditModeState = NotebookInteractionState;

export interface NotebookEditModeButtonProps {
  mode: NotebookEditMode;
  state: NotebookEditModeState;
  onModeChange: (mode: NotebookEditMode) => void;
  ariaLabel?: string;
  dataSlot?: string;
  disabled?: boolean;
  editActiveTitle?: string;
  editDisabled?: boolean;
  editLabel?: string;
  editTitle?: string;
  requestedEditLabel?: string;
  requestedEditTitle?: string;
  viewLabel?: string;
  viewSegmentLabel?: string;
  viewTitle?: string;
  variant?: "button" | "segmented";
  className?: string;
}

export function NotebookEditModeButton({
  ariaLabel = "Notebook interaction mode",
  className,
  dataSlot = "notebook-edit-mode-button",
  disabled = false,
  editActiveTitle = "Editing notebook",
  editDisabled = false,
  editLabel: editLabelProp,
  editTitle = "Switch to edit mode",
  mode,
  onModeChange,
  requestedEditLabel = "Request sent",
  requestedEditTitle = "Edit access requested",
  viewLabel = "View",
  viewSegmentLabel = "Viewing",
  viewTitle = "View notebook",
  state,
  variant = "button",
}: NotebookEditModeButtonProps) {
  const requestingEdit = mode === "edit";
  const requestedEdit = requestingEdit && state === "requested";
  const nextMode: NotebookEditMode = requestingEdit ? "view" : "edit";
  const editLabel = editLabelProp ?? "Editing";
  const label = requestingEdit ? viewLabel : "Edit";
  const editSegmentLabel = requestedEdit ? requestedEditLabel : editLabel;
  const title = requestingEdit
    ? state === "editing"
      ? "Return to read-only viewing"
      : "Stop requesting edit access"
    : editTitle;

  if (variant === "segmented") {
    return (
      <div
        className={cn(
          "inline-flex h-8 max-w-[min(16rem,54vw)] min-w-0 items-center rounded-md border border-border bg-background p-0.5 text-xs text-muted-foreground",
          disabled && "opacity-60",
          className,
        )}
        role="group"
        aria-label={ariaLabel}
        data-slot={dataSlot}
        data-state={state}
        data-variant={variant}
      >
        <button
          type="button"
          aria-pressed={mode === "view"}
          className={cn(
            "inline-flex h-6 min-w-0 items-center justify-center gap-1 rounded px-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
            mode === "view" && "bg-background text-foreground shadow-sm",
          )}
          disabled={disabled}
          title={viewTitle}
          onClick={() => {
            if (mode !== "view") {
              onModeChange("view");
            }
          }}
        >
          <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only sm:min-w-0 sm:truncate sm:leading-none">
            {viewSegmentLabel}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={mode === "edit"}
          className={cn(
            "inline-flex h-6 min-w-0 items-center justify-center gap-1 rounded px-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
            mode === "edit" &&
              (state === "editing"
                ? "bg-background text-emerald-700 shadow-sm dark:text-emerald-300"
                : "bg-background text-amber-700 shadow-sm dark:text-amber-300"),
          )}
          disabled={disabled || editDisabled}
          title={
            state === "editing" ? editActiveTitle : requestedEdit ? requestedEditTitle : editTitle
          }
          onClick={() => {
            if (mode !== "edit") {
              onModeChange("edit");
            }
          }}
        >
          {requestedEdit ? (
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Pencil className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="sr-only sm:not-sr-only sm:min-w-0 sm:truncate sm:leading-none">
            {editSegmentLabel}
          </span>
        </button>
      </div>
    );
  }

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
      data-slot={dataSlot}
      data-state={state}
      data-variant={variant}
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
