import { Plus } from "lucide-react";
import { type KeyboardEvent, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { DependencyPanelVariant } from "./dependency-panel-types";
import { PackageSpecList } from "./PackageSpecList";

export interface PyodideDependencyPanelProps {
  /** Declared `runt.execution.dependencies` — installed via micropip at interpreter startup. */
  dependencies: string[];
  loading: boolean;
  variant?: DependencyPanelVariant;
  readOnly?: boolean;
  onAdd: (pkg: string) => Promise<void>;
  onRemove: (pkg: string) => Promise<void>;
}

/**
 * Packages panel for the pyodide runtime. Unlike the uv/conda/pixi panels,
 * these dependencies are not installed by an environment manager — they are
 * declared in notebook metadata and installed into the WASM sandbox via
 * micropip when the interpreter starts.
 */
export function PyodideDependencyPanel({
  dependencies,
  loading,
  variant = "header",
  readOnly = false,
  onAdd,
  onRemove,
}: PyodideDependencyPanelProps) {
  const [newDep, setNewDep] = useState("");
  const isRail = variant === "rail";

  const handleAdd = useCallback(async () => {
    const pkg = newDep.trim();
    if (!pkg) return;
    await onAdd(pkg);
    setNewDep("");
  }, [newDep, onAdd]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void handleAdd();
      }
    },
    [handleAdd],
  );

  return (
    <div className={cn("flex flex-col gap-2", isRail ? "text-xs" : "text-sm")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">micropip packages</span>
        <span className="text-muted-foreground">installed in the sandbox on launch</span>
      </div>

      <PackageSpecList
        values={dependencies}
        tone="neutral"
        emptyLabel="No packages declared"
        loading={loading}
        onRemove={readOnly ? undefined : (value) => void onRemove(value)}
      />

      {!readOnly && (
        <div className="flex items-center gap-1.5">
          <input
            value={newDep}
            onChange={(event) => setNewDep(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="package name (e.g. requests)"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!newDep.trim() || loading}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </div>
      )}

      <p className="text-muted-foreground">
        Declared packages are installed by micropip when the pyodide runtime starts — nothing is
        installed until then. Pure-Python and pyemscripten wheels only.
      </p>
    </div>
  );
}
