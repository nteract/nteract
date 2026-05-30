import { cn } from "@/lib/utils";

interface ExecutionCountProps {
  count: number | null;
  isExecuting?: boolean;
  className?: string;
}

function formatExecutionCount(count: number): string {
  return count > 999 ? "999" : String(count);
}

export function ExecutionCount({ count, isExecuting, className }: ExecutionCountProps) {
  const state = isExecuting ? "running" : count !== null ? "ran" : "idle";
  const display = count === null ? null : formatExecutionCount(count);
  const title = isExecuting
    ? "Execution running"
    : count !== null
      ? `Last execution ${count}`
      : "Cell has not run";

  return (
    <span
      data-slot="execution-count"
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-6 min-w-9 items-center justify-end",
        "font-mono text-[11px] leading-none tabular-nums transition-colors",
        state === "idle" && "text-muted-foreground/45",
        state === "ran" && "text-muted-foreground/70",
        state === "running" && "text-destructive",
        className,
      )}
    >
      {state === "running" ? (
        <span className="inline-flex min-w-[5ch] items-center justify-end">
          <span className="text-muted-foreground/50">[</span>
          <span className="block size-2 rounded-sm bg-current animate-exec-squish" aria-hidden />
          <span className="text-muted-foreground/50">]</span>
        </span>
      ) : display !== null ? (
        <span className="inline-flex min-w-[5ch] items-center justify-end">
          <span className="text-muted-foreground/50">[</span>
          {display}
          <span className="text-muted-foreground/50">]</span>
        </span>
      ) : (
        <span className="inline-flex min-w-[5ch] items-center justify-end">
          <span className="text-muted-foreground/50">[</span>
          <span className="mx-[0.2ch] block size-1.5 rounded-full bg-current" aria-hidden />
          <span className="text-muted-foreground/50">]</span>
        </span>
      )}
    </span>
  );
}
