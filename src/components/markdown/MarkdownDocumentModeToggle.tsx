import { BookOpen, Code2, Columns2 } from "lucide-react";
import { NotebookEditModeButton } from "@/components/notebook/NotebookEditModeButton";
import type {
  MarkdownDocumentMode,
  MarkdownDocumentRepresentation,
  MarkdownDocumentRepresentationOption,
} from "@/lib/markdown-document";
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
    <NotebookEditModeButton
      ariaLabel="Markdown document mode"
      className={cn("markdown-document-mode-toggle", className)}
      dataSlot="markdown-document-mode-toggle"
      editDisabled={!canEdit}
      editActiveTitle="Editing Markdown"
      editLabel="Edit"
      editTitle={canEdit ? "Edit Markdown" : "Editing requires edit access"}
      mode={mode}
      state={mode === "edit" && canEdit ? "editing" : "viewing"}
      variant="segmented"
      viewSegmentLabel="View"
      viewTitle="View Markdown"
      onModeChange={(nextMode) => {
        if (nextMode === "edit" && !canEdit) {
          return;
        }
        if (nextMode !== mode) {
          onModeChange(nextMode);
        }
      }}
    />
  );
}

const MARKDOWN_REPRESENTATION_ICONS = {
  rendered: BookOpen,
  source: Code2,
  split: Columns2,
} satisfies Record<MarkdownDocumentRepresentation, typeof BookOpen>;

export interface MarkdownDocumentRepresentationToolbarProps {
  active: MarkdownDocumentRepresentation;
  options: readonly MarkdownDocumentRepresentationOption[];
  onRepresentationChange: (representation: MarkdownDocumentRepresentation) => void;
  className?: string;
}

export function MarkdownDocumentRepresentationToolbar({
  active,
  options,
  onRepresentationChange,
  className,
}: MarkdownDocumentRepresentationToolbarProps) {
  return (
    <div
      className={cn("markdown-document-representation-toolbar", className)}
      role="group"
      aria-label="Markdown representation"
      data-slot="markdown-document-representation-toolbar"
    >
      {options.map((option) => {
        const Icon = MARKDOWN_REPRESENTATION_ICONS[option.id];
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active === option.id}
            disabled={option.disabled}
            title={option.title}
            onClick={() => {
              if (!option.disabled && active !== option.id) {
                onRepresentationChange(option.id);
              }
            }}
          >
            <Icon aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
