import type { InstalledCondaPackageInventory } from "runtimed";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface InstalledCondaPackagesPanelProps {
  inventory: InstalledCondaPackageInventory | null;
  loading: boolean;
  error: string | null;
  onLoad: (refresh: boolean) => unknown;
}

export function InstalledCondaPackagesPanel({
  inventory,
  loading,
  error,
  onLoad,
}: InstalledCondaPackagesPanelProps) {
  return (
    <section aria-label="Installed Conda packages" className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium leading-snug">Installed packages</h4>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Conda records in the running environment. This is separate from notebook declarations.
          </p>
        </div>
        {inventory && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => onLoad(true)}
          >
            Refresh
          </Button>
        )}
      </div>
      {loading && <Skeleton className="h-12 w-full" />}
      {!loading && !inventory && !error && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Installed package records will load when the selected Conda environment is running.
        </p>
      )}
      {!loading && inventory && inventory.packages.length === 0 && !inventory.truncated && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No Conda package records found.
        </p>
      )}
      {!loading && inventory && inventory.packages.length > 0 && (
        <ul
          aria-label="Installed Conda package records"
          className="divide-y divide-border/70 rounded-md border border-border"
        >
          {inventory.packages.map((pkg, index) => (
            <li
              key={`${pkg.name}:${pkg.version}:${pkg.build}:${index}`}
              className="flex min-w-0 items-baseline gap-2 px-2.5 py-2"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs leading-snug">
                {pkg.name}
              </code>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {pkg.version}
              </span>
              {pkg.build && (
                <span className="max-w-32 shrink-0 truncate font-mono text-xs text-muted-foreground">
                  {pkg.build}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!loading && inventory?.truncated && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          The inventory was truncated at a configured record or size limit.
        </p>
      )}
      {!loading &&
        inventory?.warnings.map((warning, index) => (
          <p
            key={`${index}:${warning}`}
            role="status"
            className="break-words text-sm leading-relaxed text-muted-foreground"
          >
            {warning}
          </p>
        ))}
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="alert" className="break-words text-sm leading-relaxed text-destructive">
            {error}
          </p>
          {!inventory && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => onLoad(false)}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
