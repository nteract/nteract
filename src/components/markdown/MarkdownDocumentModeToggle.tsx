import { BookOpen, PencilLine } from "lucide-react";
import type { MarkdownDocumentMode } from "@/lib/markdown-document";
import { cn } from "@/lib/utils";

export interface MarkdownDocumentModeToggleProps {
  mode: MarkdownDocumentMode;
  canEdit: boolean;
  onModeChange: (mode: MarkdownDocumentMode) => void;
  className?: string;
}

export function MarkdownDocumentModeToggle({
  mode,
  canEdit,
  onModeChange,
  className,
}: MarkdownDocumentModeToggleProps) {
  return (
    <div
      className={cn("markdown-document-mode-toggle", className)}
      role="group"
      aria-label="Markdown document mode"
      data-slot="markdown-document-mode-toggle"
    >
      <button
        type="button"
        aria-pressed={mode === "view"}
        title="View Markdown"
        onClick={() => {
          if (mode !== "view") {
            onModeChange("view");
          }
        }}
      >
        <BookOpen aria-hidden="true" />
        <span>View</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === "edit"}
        disabled={!canEdit}
        title={canEdit ? "Edit Markdown" : "Editing requires edit access"}
        onClick={() => {
          if (canEdit && mode !== "edit") {
            onModeChange("edit");
          }
        }}
      >
        <PencilLine aria-hidden="true" />
        <span>Edit</span>
      </button>
    </div>
  );
}
