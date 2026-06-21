import { Check, Download, FileText, Info, Plus, RefreshCw, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import type { PyProjectDeps, PyProjectInfo } from "runtimed";
import { cn } from "@/lib/utils";
import type { DependencyPanelVariant, EnvironmentSyncState } from "./dependency-panel-types";
import { PackageSpecList } from "./PackageSpecList";

export interface UvDependencyPanelProps {
  dependencies: string[];
  requiresPython: string | null;
  loading: boolean;
  variant?: DependencyPanelVariant;
  readOnly?: boolean;
  onAdd: (pkg: string) => Promise<void>;
  onRemove: (pkg: string) => Promise<void>;
  onSetRequiresPython: (version: string | null) => Promise<void>;
  // Environment sync state
  syncState?: EnvironmentSyncState | null;
  onSyncNow?: () => Promise<boolean>;
  // pyproject.toml support
  pyprojectInfo?: PyProjectInfo | null;
  pyprojectDeps?: PyProjectDeps | null;
  /** Copy pyproject.toml deps into notebook metadata as a portable snapshot */
  onImportFromPyproject?: () => Promise<void>;
  /** Start kernel using the project environment (uv run) */
  onUseProjectEnv?: () => Promise<void>;
  /** Whether the kernel is currently using the project environment */
  isUsingProjectEnv?: boolean;
  /** Show success feedback after sync completed */
  justSynced?: boolean;
}

export function UvDependencyPanel({
  dependencies,
  requiresPython,
  loading,
  variant = "header",
  readOnly = false,
  onAdd,
  onRemove,
  onSetRequiresPython,
  syncState,
  onSyncNow,
  pyprojectInfo,
  pyprojectDeps,
  onImportFromPyproject,
  onUseProjectEnv,
  isUsingProjectEnv,
  justSynced,
}: UvDependencyPanelProps) {
  const [newDep, setNewDep] = useState("");
  const [pythonSpec, setPythonSpec] = useState(requiresPython ?? "");
  const isRail = variant === "rail";
  const pyprojectDependencyValues = pyprojectDeps
    ? [...pyprojectDeps.dependencies, ...pyprojectDeps.dev_dependencies]
    : [];
  const pyprojectDependencyCount =
    pyprojectDependencyValues.length || pyprojectInfo?.dependency_count || 0;
  const hasPyprojectDependencies =
    Boolean(pyprojectInfo?.has_dependencies) || pyprojectDependencyCount > 0;
  const pyprojectPath = pyprojectInfo?.relative_path ?? "pyproject.toml";

  useEffect(() => {
    setPythonSpec(requiresPython ?? "");
  }, [requiresPython]);

  const handleAdd = useCallback(async () => {
    if (!readOnly && newDep.trim()) {
      await onAdd(newDep.trim());
      setNewDep("");
    }
  }, [newDep, onAdd, readOnly]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd],
  );

  const commitPythonSpec = useCallback(async () => {
    const next = pythonSpec.trim();
    const current = requiresPython ?? "";
    if (readOnly) return;
    if (next === current) return;
    await onSetRequiresPython(next || null);
  }, [onSetRequiresPython, pythonSpec, readOnly, requiresPython]);

  const handlePythonKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitPythonSpec();
      }
    },
    [commitPythonSpec],
  );

  return (
    <div
      className={cn(isRail ? "space-y-3" : "border-b bg-uv/[0.02] dark:bg-uv/[0.04]")}
      data-testid="deps-panel"
      data-variant={variant}
    >
      <div className={cn(!isRail && "px-3 py-3")}>
        {/* uv badge */}
        <div
          className={cn(
            "mb-2 flex items-center gap-2",
            isRail &&
              "mb-3 flex-wrap justify-between gap-x-2 gap-y-1 rounded-md border bg-background px-3 py-2 shadow-sm shadow-black/[0.02]",
          )}
        >
          <div className={cn("flex min-w-0 items-center gap-2", isRail && "shrink-0")}>
            <span className="rounded bg-uv/20 px-1.5 py-0.5 text-xs font-medium text-uv">uv</span>
            {isRail && (
              <span className="whitespace-nowrap text-xs text-muted-foreground">Python</span>
            )}
          </div>
        </div>

        {/* Success feedback after sync completed */}
        {justSynced && (
          <div className="mb-3 flex items-center gap-2 rounded bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5 shrink-0" />
            <span>Environment synced — dependencies are ready to use</span>
          </div>
        )}

        {/* Environment drift notice - kernel restart needed */}
        {!readOnly && syncState?.status === "dirty" && onSyncNow && (
          <div
            className={cn(
              "mb-3 rounded bg-amber-500/10 text-xs text-amber-700 dark:text-amber-400",
              isRail
                ? "flex flex-col gap-2 px-3 py-2"
                : "flex items-center justify-between px-2 py-1.5",
            )}
          >
            <div className="flex items-start gap-2">
              <Info className="size-3.5 shrink-0" />
              <span>Re-initialize the environment to apply dependency changes.</span>
            </div>
            <button
              type="button"
              onClick={onSyncNow}
              disabled={loading}
              data-testid="deps-restart-button"
              className={cn(
                "flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50",
                isRail && "self-start py-1",
              )}
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
              Re-initialize
            </button>
          </div>
        )}

        {/* pyproject.toml detected banner */}
        {hasPyprojectDependencies && !isUsingProjectEnv && (
          <div
            className="mb-3 rounded bg-muted/80 px-2 py-1.5 text-xs text-muted-foreground"
            data-slot="deps-pyproject-banner"
          >
            <div
              className={cn(isRail ? "flex flex-col gap-2" : "flex items-center justify-between")}
            >
              <div className="flex min-w-0 items-start gap-2">
                <FileText className="size-3.5 shrink-0" />
                <span className="min-w-0">
                  <code className="rounded bg-muted px-1">{pyprojectPath}</code>
                  {pyprojectInfo?.project_name && (
                    <span className="text-muted-foreground ml-1">
                      ({pyprojectInfo.project_name})
                    </span>
                  )}
                </span>
              </div>
              <div
                data-slot="deps-pyproject-actions"
                className={cn("flex items-center gap-2", isRail && "flex-wrap justify-start pl-5")}
              >
                {!readOnly && onUseProjectEnv && !isUsingProjectEnv && (
                  <button
                    type="button"
                    onClick={onUseProjectEnv}
                    disabled={loading}
                    className="flex items-center gap-1 rounded bg-uv px-2 py-0.5 text-white text-xs font-medium hover:bg-uv/90 transition-colors disabled:opacity-50"
                    title="Start kernel with uv run — stays in sync with pyproject.toml"
                  >
                    Use project env
                  </button>
                )}
                {isUsingProjectEnv && (
                  <span className="rounded bg-uv/20 px-1.5 py-0.5 text-uv text-xs font-medium">
                    Active
                  </span>
                )}
                {!readOnly && onImportFromPyproject && (
                  <button
                    type="button"
                    onClick={onImportFromPyproject}
                    disabled={loading}
                    className="flex items-center gap-1 text-uv/70 hover:text-uv transition-colors disabled:opacity-50"
                    title="Copy deps into notebook metadata for portable sharing"
                  >
                    <Download className="size-3" />
                    Copy to notebook
                  </button>
                )}
              </div>
            </div>
            {pyprojectDeps &&
              (pyprojectDeps.dependencies.length > 0 ||
                pyprojectDeps.dev_dependencies.length > 0) &&
              (isRail ? (
                <PackageSpecList
                  values={pyprojectDependencyValues}
                  tone="uv"
                  emptyLabel="No dependencies listed in pyproject.toml."
                  loading={loading}
                  framed={false}
                  className="mt-2"
                />
              ) : (
                <div className="mt-2 text-xs text-muted-foreground">
                  {pyprojectDeps.dependencies.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {pyprojectDeps.dependencies.map((dep) => (
                        <span key={dep} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                          {dep}
                        </span>
                      ))}
                    </div>
                  )}
                  {pyprojectDeps.dev_dependencies.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-muted-foreground">dev:</span>
                      {pyprojectDeps.dev_dependencies.map((dep) => (
                        <span key={dep} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                          {dep}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* Project-managed state: read-only view when using uv run */}
        {isUsingProjectEnv && (
          <div className="mb-3 flex items-start gap-2 rounded bg-muted/80 px-2 py-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1 leading-5">
              <div>
                Using <code className="rounded bg-muted px-1">{pyprojectPath}</code>
              </div>
              {isRail && pyprojectDependencyValues.length > 0 && (
                <PackageSpecList
                  values={pyprojectDependencyValues}
                  tone="uv"
                  emptyLabel="No dependencies listed in pyproject.toml."
                  loading={loading}
                  framed={false}
                  className="pt-1"
                />
              )}
            </div>
          </div>
        )}

        {/* Python version */}
        {isUsingProjectEnv ? (
          requiresPython && (
            <div className="mb-2 text-xs text-muted-foreground">
              Python: <span className="font-mono">{requiresPython}</span>
            </div>
          )
        ) : readOnly ? (
          requiresPython ? (
            <div className="mb-2 text-xs text-muted-foreground">
              Python: <span className="font-mono">{requiresPython}</span>
            </div>
          ) : null
        ) : (
          <label
            className={cn(
              "mb-3 flex items-center gap-2 text-xs text-muted-foreground",
              isRail && "flex-col items-stretch gap-1.5",
            )}
          >
            <span className="shrink-0">Python</span>
            <input
              type="text"
              value={pythonSpec}
              onChange={(e) => setPythonSpec(e.target.value)}
              onBlur={commitPythonSpec}
              onKeyDown={handlePythonKeyDown}
              placeholder=">=3.13"
              data-testid="uv-python-input"
              className={cn(
                "rounded border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary",
                isRail ? "w-full" : "w-40",
              )}
              disabled={loading}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {/* Dependencies list (read-only when using project env) */}
        {!isUsingProjectEnv &&
          (isRail ? (
            <PackageSpecList
              values={dependencies}
              tone="uv"
              emptyLabel="No inline dependencies. Add packages to create an isolated environment."
              loading={loading}
              onRemove={readOnly ? undefined : onRemove}
              className="mb-3"
            />
          ) : dependencies.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {dependencies.map((dep) => (
                <div
                  key={dep}
                  className="flex max-w-full items-center gap-1 rounded border bg-background px-2 py-1 text-xs"
                >
                  <span className="min-w-0 truncate font-mono">{dep}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => onRemove(dep)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      disabled={loading}
                      title={`Remove ${dep}`}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mb-3 text-xs text-muted-foreground">
              No inline dependencies. Add packages to create an isolated environment.
            </div>
          ))}

        {/* Add dependency input (hidden when using project env) */}
        {!readOnly && !isUsingProjectEnv && (
          <div className="flex gap-2">
            <input
              type="text"
              value={newDep}
              onChange={(e) => setNewDep(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="package or package>=version"
              data-testid="deps-add-input"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={loading}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={loading || !newDep.trim()}
              data-testid="deps-add-button"
              className="flex items-center gap-1 rounded bg-uv px-2 py-1 text-xs text-white transition-colors hover:bg-uv/90 disabled:opacity-50"
            >
              <Plus className="size-3" />
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
