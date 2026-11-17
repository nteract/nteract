import { useId, useState } from "react";
import type {
  CondaEnvironmentInventory,
  EnvironmentSelectionSnapshot,
  KernelspecCatalogState,
  LocalEnvironmentTarget,
} from "runtimed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export interface LocalEnvironmentSelectorProps {
  available: boolean;
  selection: EnvironmentSelectionSnapshot | null;
  inventory: CondaEnvironmentInventory | null;
  /** Installed Jupyter kernels. Omitted or `unsupported` hides them and sends nothing. */
  kernelspecCatalog?: KernelspecCatalogState;
  loadingSelection: boolean;
  loadingInventory: boolean;
  mutating: boolean;
  error: string | null;
  running: {
    id: string | null;
    name: string;
    pythonVersion: string | null;
    language?: string | null;
  } | null;
  blocked: boolean;
  onLoadInventory: (refresh: boolean) => unknown;
  onLoadKernelspecs?: () => unknown;
  onSelect: (target: LocalEnvironmentTarget) => unknown;
  onApply: (revision: number) => unknown;
  onRetrySelection: () => unknown;
}

const CHOICE_CLASS_NAME =
  "w-full rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 aria-[current=true]:border-foreground/40";

/** Running-kernel identity the daemon reports for an installed kernelspec. */
function kernelspecEnvironmentId(name: string): string {
  return `kernelspec:${name}`;
}

/** The staged target. A kernelspec and a Conda prefix are never staged together. */
function nextChoice(selection: EnvironmentSelectionSnapshot): { id: string | null; name: string } {
  if (selection.selected_kernelspec) {
    const spec = selection.selected_kernelspec;
    return { id: kernelspecEnvironmentId(spec.name), name: spec.display_name || spec.name };
  }
  if (selection.selected) return { id: selection.selected.id, name: selection.selected.name };
  return { id: null, name: "Automatic" };
}

function ChoiceMarks({ next, running }: { next: boolean; running: boolean }) {
  if (!next && !running) return null;
  return (
    <span className="mt-0.5 block text-xs text-muted-foreground">
      {[running && "Running", next && "Next"].filter(Boolean).join(" · ")}
    </span>
  );
}

export function LocalEnvironmentSelector({
  available,
  selection,
  inventory,
  kernelspecCatalog,
  loadingSelection,
  loadingInventory,
  mutating,
  error,
  running,
  blocked,
  onLoadInventory,
  onLoadKernelspecs,
  onSelect,
  onApply,
  onRetrySelection,
}: LocalEnvironmentSelectorProps) {
  const [changing, setChanging] = useState(false);
  const [enteringPrefix, setEnteringPrefix] = useState(false);
  const [prefix, setPrefix] = useState("");
  const prefixId = useId();
  const disabled = blocked || mutating || loadingSelection || !selection || selection.applying;
  const next = selection ? nextChoice(selection) : null;
  const differs = Boolean(next && next.id !== (running?.id ?? null));
  const kernelspecs =
    kernelspecCatalog && kernelspecCatalog.status !== "unsupported" ? kernelspecCatalog : null;
  const kernelspecInventory =
    kernelspecs && "inventory" in kernelspecs ? kernelspecs.inventory : null;
  const kernelspecsLoading = kernelspecs?.status === "loading";
  const selectedSpec = selection?.selected_kernelspec ?? null;
  // Only a complete, current listing can show that the staged kernel is gone.
  const selectedSpecMissing = Boolean(
    selectedSpec &&
    kernelspecs?.status === "ready" &&
    !kernelspecs.inventory.truncated &&
    !kernelspecs.inventory.kernelspecs.some((spec) => spec.name === selectedSpec.name),
  );
  const runningDetail = running?.pythonVersion
    ? `Python ${running.pythonVersion}`
    : running?.language || null;

  return (
    <section
      aria-label="Environment"
      className="space-y-2 border-b border-border/70 pb-3 text-sm"
      data-testid="environment-selector"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-5">Environment</h3>
          <p className="break-words text-xs leading-4 text-muted-foreground">
            {running
              ? `Running: ${running.name}${runningDetail ? ` · ${runningDetail}` : ""}`
              : selection?.applying
                ? "Starting kernel"
                : "No running kernel"}
          </p>
          {available && next && (
            <p className="break-words text-xs leading-4 text-muted-foreground">
              {`Next: ${next.name}`}
              {differs && !selection?.applying && (running ? " · not applied" : " · not started")}
            </p>
          )}
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
              const opening = !changing;
              setChanging(opening);
              if (opening) {
                onLoadInventory(false);
                if (kernelspecs) onLoadKernelspecs?.();
              }
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
            <div className="space-y-3 border-t border-border pt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-current={next?.id === null && !selectedSpec ? "true" : undefined}
                  onClick={() => onSelect({ kind: "automatic" })}
                >
                  Automatic
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || loadingInventory || kernelspecsLoading}
                  onClick={() => {
                    onLoadInventory(true);
                    if (kernelspecs) onLoadKernelspecs?.();
                  }}
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
              <div className="space-y-2">
                {kernelspecs && (
                  <h4 className="text-xs font-medium text-muted-foreground">Conda environments</h4>
                )}
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
                            aria-current={next?.id === environment.id ? "true" : undefined}
                            className={CHOICE_CLASS_NAME}
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
                            <ChoiceMarks
                              next={next?.id === environment.id}
                              running={running?.id === environment.id}
                            />
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
              </div>
              {kernelspecs && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">Jupyter kernels</h4>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Kernels installed on this computer. nteract runs them as they are and does not
                    manage their packages.
                  </p>
                  {kernelspecsLoading && !kernelspecInventory && (
                    <Skeleton className="h-10 w-full" />
                  )}
                  {kernelspecInventory && (
                    <>
                      {kernelspecInventory.kernelspecs.length === 0 && (
                        <p className="text-muted-foreground">No installed Jupyter kernels found.</p>
                      )}
                      <ul aria-label="Installed Jupyter kernels" className="space-y-1">
                        {kernelspecInventory.kernelspecs.map((spec) => {
                          const id = kernelspecEnvironmentId(spec.name);
                          return (
                            <li key={spec.name}>
                              <button
                                type="button"
                                disabled={disabled}
                                aria-current={next?.id === id ? "true" : undefined}
                                className={CHOICE_CLASS_NAME}
                                onClick={() => onSelect({ kind: "kernelspec", name: spec.name })}
                              >
                                <span className="block break-words text-sm font-medium leading-snug">
                                  {spec.display_name || spec.name}
                                </span>
                                <span className="mt-0.5 block break-all text-xs text-muted-foreground">
                                  {[spec.language, spec.name].filter(Boolean).join(" · ")}
                                </span>
                                <ChoiceMarks next={next?.id === id} running={running?.id === id} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {kernelspecInventory.truncated && (
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          Not all installed kernels are listed.
                        </p>
                      )}
                      {kernelspecInventory.warnings.map((warning, index) => (
                        <p
                          key={index}
                          className="break-words text-sm leading-relaxed text-muted-foreground"
                        >
                          {warning}
                        </p>
                      ))}
                    </>
                  )}
                  {kernelspecs.status === "failed" && (
                    <p role="alert" className="break-words text-destructive">
                      Installed kernels could not be listed: {kernelspecs.error}
                    </p>
                  )}
                </div>
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
          {selectedSpec && selectedSpecMissing && (
            <p role="alert" className="break-words text-destructive">
              The selected kernel "{selectedSpec.display_name || selectedSpec.name}" is not
              installed on this computer. It stays selected until you choose another kernel or
              Automatic.
            </p>
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
