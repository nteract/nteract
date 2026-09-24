import { AlertCircle, Loader2, Plus, RotateCcw } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PackageSpecList } from "./PackageSpecList";

export interface ManagedPythonPackagesProps {
  requirements: readonly string[];
  installed: readonly string[];
  phase: "unavailable" | "ready" | "resolving" | "installing" | "restoring" | "error";
  error?: string | null;
  needsRestart?: boolean;
  readOnly?: boolean;
  onAdd: (requirement: string) => Promise<boolean>;
  onRemove: (requirement: string) => Promise<void>;
  onClear?: () => Promise<void>;
  onRestart?: () => void;
}

/** Package intent and observed session state are deliberately separate.
 * Adapted from Fábio Rosado's package installation work in nteract/nteract#4291.
 */
export function ManagedPythonPackages({
  requirements,
  installed,
  phase,
  error,
  needsRestart = false,
  readOnly = true,
  onAdd,
  onRemove,
  onClear,
  onRestart,
}: ManagedPythonPackagesProps) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const submitting = useRef(false);
  const busy = pending || ["resolving", "installing", "restoring"].includes(phase);
  const canInstall = !readOnly && !busy && phase !== "unavailable" && !needsRestart;

  async function add() {
    const requirement = draft.trim();
    if (!canInstall || !requirement || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (await onAdd(requirement)) setDraft("");
    } catch {
      setActionError("The install result could not be confirmed. Reconnect to check its status.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  async function remove(requirement?: string) {
    if (readOnly || busy || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (requirement === undefined) await onClear?.();
      else await onRemove(requirement);
    } catch {
      setActionError("The requirement could not be removed. Reconnect and try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-4 text-xs" data-slot="managed-python-packages">
      <p className="leading-5 text-muted-foreground">
        Packages you install successfully are saved with this notebook and restored when Python
        restarts.
      </p>
      {!readOnly && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label htmlFor={inputId} className="font-medium">
            Add a package
          </label>
          <div className="flex min-w-0 gap-1.5">
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="e.g. snowballstemmer>=2"
              disabled={!canInstall}
              className="min-w-0 flex-1 text-xs shadow-none"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="ghost" size="sm" disabled={!canInstall || !draft.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Install
            </Button>
          </div>
        </form>
      )}
      <div role="status" aria-live="polite" className="leading-5 text-muted-foreground">
        {phase === "resolving"
          ? "Finding compatible packages…"
          : phase === "installing"
            ? "Resolving and installing packages…"
            : phase === "restoring"
              ? "Restoring saved packages…"
              : phase === "unavailable"
                ? "Start Python to install packages or inspect this session."
                : null}
      </div>
      {(error || actionError || needsRestart) && (
        <div className="space-y-2 border-t border-border pt-3">
          {(error || actionError) && (
            <p role="alert" className="flex items-start gap-2 text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words leading-5">{actionError ?? error}</span>
            </p>
          )}
          {needsRestart && (
            <p className="leading-5 text-muted-foreground">
              Restart Python to restore the saved environment. This clears variables.
            </p>
          )}
          {needsRestart && !readOnly && onRestart && (
            <Button variant="ghost" size="sm" onClick={onRestart} disabled={busy}>
              <RotateCcw className="size-3.5" />
              Restart Python
            </Button>
          )}
          {!readOnly && onClear && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
              Clear saved packages
            </Button>
          )}
        </div>
      )}
      <section aria-label="Saved requirements" className="space-y-2">
        <h3 className="font-medium">Saved requirements</h3>
        <PackageSpecList
          values={requirements}
          emptyLabel="No packages added."
          framed={false}
          loading={busy}
          onRemove={readOnly ? undefined : (value) => void remove(value)}
        />
        {requirements.length > 0 && (
          <p className="leading-5 text-muted-foreground">
            Removing a saved package takes effect after restarting Python.
          </p>
        )}
      </section>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-muted-foreground">
          Installed in this session ({installed.length})
        </summary>
        <div className="pt-2">
          <PackageSpecList
            values={installed}
            emptyLabel="No confirmed package inventory."
            framed={false}
          />
        </div>
      </details>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-muted-foreground">Supported packages</summary>
        <p className="pt-2 leading-5 text-muted-foreground">
          Compatible pure Python wheels from PyPI and the included scientific packages. Packages
          requiring other native extensions, source builds, or external wheel URLs are unsupported.
        </p>
      </details>
      {readOnly && (
        <p className="leading-5 text-muted-foreground">
          Only the notebook owner can change packages.
        </p>
      )}
    </div>
  );
}
