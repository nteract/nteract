import { UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NotebookPresenceStatusProps {
  label: string;
  title: string;
  connected?: boolean;
  modeLabel?: string | null;
  className?: string;
}

export function NotebookPresenceStatus({
  className,
  connected = false,
  label,
  modeLabel = null,
  title,
}: NotebookPresenceStatusProps) {
  const displayLabel = modeLabel ? `${label} · ${modeLabel}` : label;
  const displayTitle = modeLabel ? `${title}; ${modeLabel}` : title;

  return (
    <div
      className={cn(
        "pointer-events-auto inline-flex h-8 max-w-[min(16rem,52vw)] items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 text-sm text-muted-foreground shadow-sm backdrop-blur",
        connected && "border-teal-700/30 text-foreground",
        className,
      )}
      data-slot="notebook-presence-status"
      data-connected={String(connected)}
      title={displayTitle}
      aria-label={title}
      aria-live="polite"
    >
      <UsersRound className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{displayLabel}</span>
    </div>
  );
}
