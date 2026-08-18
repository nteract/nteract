import { House } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NotebookRailHomeButtonProps {
  href: string;
  label?: string;
  className?: string;
}

export function NotebookRailHomeButton({
  href,
  label = "Notebooks",
  className,
}: NotebookRailHomeButtonProps) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      data-slot="notebook-rail-home"
      className={cn(
        "flex size-9 items-center justify-center rounded-md bg-foreground text-background transition-colors",
        "hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <House className="size-4" strokeWidth={2.25} aria-hidden="true" />
    </a>
  );
}
