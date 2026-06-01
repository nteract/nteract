import { Package, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type PackageSpecTone = "uv" | "conda" | "pixi" | "neutral";

interface PackageSpecListProps {
  values: readonly string[];
  tone?: PackageSpecTone;
  emptyLabel: string;
  loading?: boolean;
  onRemove?: (value: string) => void;
  className?: string;
  framed?: boolean;
}

const toneClasses: Record<PackageSpecTone, string> = {
  uv: "text-uv bg-uv/10 ring-uv/15",
  conda: "text-emerald-700 bg-emerald-500/10 ring-emerald-500/15 dark:text-emerald-300",
  pixi: "text-amber-700 bg-amber-500/10 ring-amber-500/15 dark:text-amber-300",
  neutral: "text-muted-foreground bg-muted/70 ring-border/60",
};

export function PackageSpecList({
  values,
  tone = "neutral",
  emptyLabel,
  loading = false,
  onRemove,
  className,
  framed = true,
}: PackageSpecListProps) {
  if (values.length === 0) {
    return <div className={cn("text-xs text-muted-foreground", className)}>{emptyLabel}</div>;
  }

  return (
    <div
      className={cn(
        framed
          ? "w-full overflow-hidden rounded-md border bg-background shadow-sm shadow-black/[0.02]"
          : "w-full overflow-hidden rounded-md bg-transparent",
        className,
      )}
    >
      {values.map((value, index) => {
        const parsed = parsePackageSpec(value);
        const hasEnvironmentMarker = value.includes(";");
        return (
          <div
            key={`${index}-${value}`}
            className={cn(
              "grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-0.5 border-b px-2.5 py-1.5 text-xs last:border-b-0",
              !framed && "px-0",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full ring-1",
                hasEnvironmentMarker && parsed.spec && "row-span-2 self-start",
                toneClasses[tone],
              )}
              aria-hidden="true"
            >
              <Package className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{parsed.name}</span>
            {parsed.spec && hasEnvironmentMarker ? (
              <span className="col-span-3 col-start-2 min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {parsed.spec}
              </span>
            ) : parsed.spec ? (
              <span className="max-w-[8rem] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {parsed.spec}
              </span>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(value)}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={loading}
                title={`Remove ${value}`}
                aria-label={`Remove ${value}`}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function parsePackageSpec(value: string): { name: string; spec: string | null } {
  const trimmed = value.trim();
  const markerStart = trimmed.indexOf(";");
  if (markerStart > 0) {
    const packagePart = trimmed.slice(0, markerStart).trim();
    const markerPart = trimmed.slice(markerStart + 1).trim();
    const parsedPackage = parsePackageSpec(packagePart);
    return {
      name: parsedPackage.name,
      spec: [parsedPackage.spec, markerPart].filter(Boolean).join(" · ") || null,
    };
  }

  const specStart = trimmed.search(/[<>=!~]/);
  if (specStart <= 0) return { name: trimmed, spec: null };
  return {
    name: trimmed.slice(0, specStart).trim(),
    spec: trimmed.slice(specStart).trim() || null,
  };
}
