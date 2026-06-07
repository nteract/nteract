import { Check } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  markdownTaskCheckboxClassName,
  markdownTaskCheckboxGlyphClassName,
  markdownTaskContentClassName,
} from "./markdown-typography";

type MarkdownTaskCheckboxInputProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "checked" | "className" | "onChange" | "readOnly" | "tabIndex" | "type"
>;

interface MarkdownTaskCheckboxProps {
  checked: boolean;
  className?: string;
  glyphClassName?: string;
  inputClassName?: string;
  inputProps?: MarkdownTaskCheckboxInputProps;
  label?: string;
  onToggle?: () => void;
  slot?: string;
}

export function MarkdownTaskCheckbox({
  checked,
  className,
  glyphClassName,
  inputClassName,
  inputProps,
  label,
  onToggle,
  slot = "markdown-task-checkbox",
}: MarkdownTaskCheckboxProps) {
  const interactive = Boolean(onToggle);
  const actionLabel = interactive
    ? checked
      ? "Mark task incomplete"
      : "Mark task complete"
    : checked
      ? "Completed task"
      : "Incomplete task";
  const ariaLabel = label ? `${actionLabel}: ${label}` : inputProps?.["aria-label"];
  const Wrapper = interactive ? "label" : "span";

  return (
    <Wrapper
      className={cn(markdownTaskCheckboxClassName, interactive && "cursor-pointer", className)}
      data-slot={slot}
      data-state={checked ? "checked" : "unchecked"}
    >
      <input
        {...inputProps}
        type="checkbox"
        checked={checked}
        disabled={!interactive}
        readOnly={!interactive}
        tabIndex={interactive ? 0 : -1}
        aria-label={ariaLabel}
        className={cn("peer sr-only", inputClassName)}
        onChange={interactive ? onToggle : undefined}
      />
      <span
        aria-hidden="true"
        className={cn(
          markdownTaskCheckboxGlyphClassName,
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background",
          interactive && "group-hover/task:border-primary/70",
          glyphClassName,
        )}
      >
        {checked ? <Check className="size-2.5 stroke-[3]" /> : null}
      </span>
    </Wrapper>
  );
}

export function MarkdownTaskContent({
  checked,
  children,
  className,
}: {
  checked: boolean | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        markdownTaskContentClassName,
        checked === true && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
