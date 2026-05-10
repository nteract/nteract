import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

const DEFAULT_SCROLL_HANDOFF_LABEL = "Click inside the table to scroll";
const DEFAULT_FOCUS_STATUS_LABEL = "Table focused";
const DEFAULT_FOCUS_KEY_LABEL = "Esc";

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type SiftScrollHandoffCueProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  children?: ReactNode;
  label?: string;
};

export function SiftScrollHandoffCue({
  children,
  className,
  label = DEFAULT_SCROLL_HANDOFF_LABEL,
  type = "button",
  ...props
}: SiftScrollHandoffCueProps) {
  return (
    <button type={type} className={classNames("sift-scroll-handoff-cue", className)} {...props}>
      {children ?? label}
    </button>
  );
}

export type SiftFocusStatusProps = HTMLAttributes<HTMLSpanElement> & {
  label?: string;
  keyLabel?: string;
};

export function SiftFocusStatus({
  className,
  label = DEFAULT_FOCUS_STATUS_LABEL,
  keyLabel = DEFAULT_FOCUS_KEY_LABEL,
  ...props
}: SiftFocusStatusProps) {
  return (
    <span className={classNames("sift-focus-hint", className)} {...props}>
      <span>{label}</span>
      <kbd className="sift-focus-key">{keyLabel}</kbd>
    </span>
  );
}
