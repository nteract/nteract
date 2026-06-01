import { UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NotebookPresenceStatusProps {
  label: string;
  title: string;
  connected?: boolean;
  modeLabel?: string | null;
  variant?: "pill" | "inline";
  className?: string;
}

export function NotebookPresenceStatus({
  className,
  connected = false,
  label,
  modeLabel = null,
  title,
  variant = "pill",
}: NotebookPresenceStatusProps) {
  const displayLabel = modeLabel ? `${label}, ${modeLabel}` : label;
  const displayTitle = modeLabel ? `${title}. ${modeLabel}` : title;
  const inline = variant === "inline";

  return (
    <div
      className={cn(
        "pointer-events-auto inline-flex h-8 max-w-[min(16rem,52vw)] items-center text-sm",
        inline
          ? "gap-2 text-foreground"
          : "gap-1.5 rounded-full border border-border bg-background/90 px-3 text-muted-foreground shadow-sm backdrop-blur",
        connected && !inline && "border-teal-700/30 text-foreground",
        className,
      )}
      data-slot="notebook-presence-status"
      data-connected={String(connected)}
      data-variant={variant}
      title={displayTitle}
      aria-label={displayTitle}
      aria-live="polite"
    >
      <span className="relative inline-flex shrink-0" aria-hidden="true">
        <UsersRound className="size-4" />
        {inline && connected ? (
          <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
        ) : null}
      </span>
      <span className="min-w-0 truncate">{displayLabel}</span>
    </div>
  );
}
