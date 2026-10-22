import { useId, useState } from "react";
import type {
  CondaEnvironmentInventory,
  EnvironmentSelectionSnapshot,
  LocalEnvironmentTarget,
} from "runtimed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export interface LocalEnvironmentSelectorProps {
  available: boolean;
  selection: EnvironmentSelectionSnapshot | null;
  inventory: CondaEnvironmentInventory | null;
  loadingSelection: boolean;
  loadingInventory: boolean;
  mutating: boolean;
  error: string | null;
  running: { id: string | null; name: string; pythonVersion: string | null } | null;
  blocked: boolean;
  onLoadInventory: (refresh: boolean) => unknown;
  onSelect: (target: LocalEnvironmentTarget) => unknown;
  onApply: (revision: number) => unknown;
  onRetrySelection: () => unknown;
}

export function LocalEnvironmentSelector({
  available,
  selection,
  inventory,
  loadingSelection,
  loadingInventory,
  mutating,
  error,
  running,
  blocked,
  onLoadInventory,
  onSelect,
  onApply,
  onRetrySelection,
}: LocalEnvironmentSelectorProps) {
  const [changing, setChanging] = useState(false);
  const [enteringPrefix, setEnteringPrefix] = useState(false);
  const [prefix, setPrefix] = useState("");
  const prefixId = useId();
  const disabled = blocked || mutating || loadingSelection || !selection || selection.applying;
  const differs = Boolean(selection && (selection.selected?.id ?? null) !== running?.id);

  return (
    <section
      aria-label="Environment"
      className="space-y-2 border-b border-border/70 pb-3 text-sm"
      data-testid="environment-selector"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-5">Environment</h3>
          <p className="truncate text-xs leading-4 text-muted-foreground">
            {running
              ? `Running: ${running.name}${running.pythonVersion ? ` · Python ${running.pythonVersion}` : ""}`
              : "No running kernel"}
            {available && selection && ` · Next: ${selection.selected?.name ?? "Automatic"}`}
          </p>
        </div>
        {available && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={disabled}
            aria-expanded={changing}
            onClick={() => {
              const next = !changing;
              setChanging(next);
              if (next) onLoadInventory(false);
            }}
          >
            {changing ? "Done" : "Change"}
          </Button>
        )}
      </div>
      {!available ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          This connection does not support local environment selection. It requires an updated
          daemon and a local Owner connection.
        </p>
      ) : (
        <>
          {!selection && !loadingSelection && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={onRetrySelection}
            >
              Retry
            </Button>
          )}
          {changing && (
            <div className="space-y-2 border-t border-border pt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onSelect({ kind: "automatic" })}
                >
                  Automatic
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || loadingInventory}
                  onClick={() => onLoadInventory(true)}
                >
                  Refresh
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setEnteringPrefix(!enteringPrefix)}
                >
                  Enter prefix...
                </Button>
              </div>
              {loadingInventory && <Skeleton className="h-10 w-full" />}
              {inventory && !loadingInventory && (
                <>
                  {inventory.environments.length === 0 && (
                    <p className="text-muted-foreground">
                      No Conda environments found. Enter an absolute prefix instead.
                    </p>
                  )}
                  <ul aria-label="Available Conda environments" className="space-y-1">
                    {inventory.environments.map((environment) => (
                      <li key={environment.id}>
                        <button
                          type="button"
                          disabled={disabled}
                          className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                          onClick={() => onSelect({ kind: "conda", prefix: environment.prefix })}
                        >
                          <span className="block truncate text-sm font-medium leading-snug">
                            {environment.name}
                          </span>
                          {environment.python_version && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              Python {environment.python_version}
                            </span>
                          )}
                          <span className="mt-1 block break-all font-mono text-xs leading-relaxed text-muted-foreground">
                            {environment.prefix}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {inventory.truncated && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Not all environments are listed. Enter a prefix if yours is missing.
                    </p>
                  )}
                  {inventory.warnings.map((warning, index) => (
                    <p
                      key={index}
                      className="break-words text-sm leading-relaxed text-muted-foreground"
                    >
                      {warning}
                    </p>
                  ))}
                </>
              )}
              {enteringPrefix && (
                <form
                  className="space-y-3 rounded-md border border-border bg-muted/30 p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (prefix.trim() && !disabled) onSelect({ kind: "conda", prefix });
                  }}
                >
                  <label htmlFor={prefixId} className="block text-sm font-medium">
                    Conda environment prefix
                  </label>
                  <Input
                    id={prefixId}
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="Absolute directory path"
                    disabled={disabled}
                    autoFocus
                  />
                  <p className="text-muted-foreground">
                    Use the environment directory, not a Python executable. The daemon validates it
                    without creating or repairing it.
                  </p>
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={disabled || !prefix.trim()}
                  >
                    Select prefix
                  </Button>
                </form>
              )}
            </div>
          )}
          {selection && (!running || differs) && (
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => onApply(selection.revision)}
            >
              {selection.applying ? "Applying..." : running ? "Apply and restart" : "Start kernel"}
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
