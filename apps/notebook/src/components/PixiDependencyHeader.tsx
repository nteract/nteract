import { Check, FileText, Info, Plus, RefreshCw, Terminal, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { EnvSyncState } from "./runtime-surface-types";
import { addPixiDependency, removePixiDependency, usePixiDeps } from "../lib/notebook-metadata";
import type { PixiInfo } from "../hooks/usePixiDetection";
import { PixiIcon } from "./icons";
import { PackageSpecList } from "./PackageSpecList";

interface PixiDependencyHeaderProps {
  pixiInfo: PixiInfo | null;
  envSource: string | null;
  variant?: "header" | "rail";
  syncState?: EnvSyncState | null;
  onSyncNow?: () => Promise<boolean>;
  justSynced?: boolean;
}

export function PixiDependencyHeader({
  pixiInfo,
  envSource,
  variant = "header",
  syncState,
  onSyncNow,
  justSynced,
}: PixiDependencyHeaderProps) {
  const pixiDeps = usePixiDeps();
  const isInlineMode = envSource === "pixi:inline" || envSource === "pixi:prewarmed";
  const [newDep, setNewDep] = useState("");
  const [loading, setLoading] = useState(false);
  const isRail = variant === "rail";
  const pixiDependencyValues = pixiInfo
    ? [...pixiInfo.dependencies, ...pixiInfo.pypi_dependencies]
    : [];

  const handleAdd = useCallback(async () => {
    if (newDep.trim()) {
      setLoading(true);
      try {
        await addPixiDependency(newDep.trim());
      } finally {
        setLoading(false);
      }
      setNewDep("");
    }
  }, [newDep]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd],
  );

  const handleRemove = useCallback(async (pkg: string) => {
    setLoading(true);
    try {
      await removePixiDependency(pkg);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div
      className={cn(isRail ? "space-y-3" : "border-b bg-amber-50/30 dark:bg-amber-950/10")}
      data-variant={variant}
    >
      <div className={cn(!isRail && "px-3 py-3")}>
        {/* Pixi badge */}
        <div
          className={cn(
            "mb-2 flex items-center gap-2",
            isRail &&
              "mb-3 flex-wrap justify-between gap-x-2 gap-y-1 rounded-md border bg-background px-3 py-2 shadow-sm shadow-black/[0.02]",
          )}
        >
          <div className={cn("flex min-w-0 items-center gap-2", isRail && "shrink-0")}>
            <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <PixiIcon className="h-2.5 w-2.5" />
              Pixi
            </span>
            <span
              className={cn(
                "text-xs text-muted-foreground",
                isRail ? "whitespace-nowrap" : "truncate",
              )}
            >
              {isInlineMode ? "Dependencies" : "Environment"}
            </span>
          </div>
          {isRail && !isInlineMode && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              Project
            </span>
          )}
        </div>

        {/* Success feedback after sync */}
        {justSynced && (
          <div className="mb-3 flex items-center gap-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>Kernel restarted — environment updated</span>
          </div>
        )}

        {/* Sync state drift banner */}
        {syncState?.status === "dirty" && onSyncNow && (
          <div
            className={cn(
              "mb-3 rounded bg-amber-500/10 text-xs text-amber-700 dark:text-amber-400",
              isRail
                ? "flex flex-col gap-2 px-3 py-2"
                : "flex items-center justify-between px-2 py-1.5",
            )}
          >
            <div className="flex items-start gap-2">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span>Dependencies changed.</span>
            </div>
            <button
              type="button"
              onClick={onSyncNow}
              disabled={loading}
              className={cn(
                "flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50",
                isRail && "self-start py-1",
              )}
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              Restart
            </button>
          </div>
        )}

        {/* pixi.toml detected banner (pixi:toml mode) */}
        {pixiInfo && !isInlineMode && (
          <div className="mb-3 rounded bg-muted/80 px-2 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span>
                Using <code className="rounded bg-muted px-1">{pixiInfo.relative_path}</code>
                {pixiInfo.workspace_name && (
                  <span className="text-muted-foreground ml-1">({pixiInfo.workspace_name})</span>
                )}
              </span>
            </div>

            {isRail ? (
              <PackageSpecList
                values={pixiDependencyValues}
                tone="pixi"
                emptyLabel="No dependencies listed in pixi.toml."
                loading={loading}
                framed={false}
                className="mt-2"
              />
            ) : pixiInfo.dependencies.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {pixiInfo.dependencies.map((dep) => (
                  <span
                    key={dep}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground"
                  >
                    {dep}
                  </span>
                ))}
              </div>
            ) : null}
            {!isRail && pixiInfo.pypi_dependencies.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wide self-center">
                  PyPI
                </span>
                {pixiInfo.pypi_dependencies.map((dep) => (
                  <span
                    key={dep}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground"
                  >
                    {dep}
                  </span>
                ))}
              </div>
            ) : null}

            {(pixiInfo.python || pixiInfo.channels.length > 0) && (
              <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                {pixiInfo.python && (
                  <div>
                    Python <span className="font-mono">{pixiInfo.python}</span>
                  </div>
                )}
                {pixiInfo.channels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <span>Channels</span>
                    {pixiInfo.channels.map((channel) => (
                      <span key={channel} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {channel}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Inline deps list + add/remove (pixi:inline / pixi:prewarmed mode) */}
        {isInlineMode && (
          <>
            {/* Current inline deps */}
            {isRail ? (
              <PackageSpecList
                values={pixiDeps?.dependencies ?? []}
                tone="pixi"
                emptyLabel="No Pixi dependencies yet."
                loading={loading}
                onRemove={handleRemove}
                className="mb-2"
              />
            ) : pixiDeps && pixiDeps.dependencies.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pixiDeps.dependencies.map((dep) => (
                  <div
                    key={dep}
                    className="flex max-w-full items-center gap-1 rounded border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs dark:border-amber-800 dark:bg-amber-900/30"
                  >
                    <span className="min-w-0 truncate">{dep}</span>
                    <button
                      type="button"
                      onClick={() => handleRemove(dep)}
                      disabled={loading}
                      className="text-amber-500/50 hover:text-amber-700 dark:hover:text-amber-300 transition-colors disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Add dep input */}
            <div className="mb-3 flex gap-1.5">
              <input
                type="text"
                value={newDep}
                onChange={(e) => setNewDep(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add conda package..."
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={loading || !newDep.trim()}
                className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
            </div>
          </>
        )}

        {/* No pixi.toml and no inline deps — show init tip */}
        {!pixiInfo && (!pixiDeps || pixiDeps.dependencies.length === 0) && (
          <div className="mb-3 flex items-start gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              No <code className="rounded bg-muted px-1">pixi.toml</code> found. Add packages above
              or run <code className="rounded bg-muted px-1">pixi init</code> in your terminal.
            </span>
          </div>
        )}

        {/* Tip for pixi:toml mode */}
        {!isInlineMode && !isRail && (
          <div className="flex items-start gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            <Terminal className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Manage dependencies with{" "}
              <code className="rounded bg-muted px-1">pixi add &lt;package&gt;</code> in your
              terminal.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
