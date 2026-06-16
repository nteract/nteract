import { BookOpen, Code2, Columns2, PencilLine } from "lucide-react";
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
