import { Check, ExternalLink, FileText, Info, Package, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { DenoConfigInfo } from "../hooks/useDenoConfig";

interface DenoDependencyHeaderProps {
  denoConfigInfo: DenoConfigInfo | null;
  flexibleNpmImports: boolean;
  onSetFlexibleNpmImports: (enabled: boolean) => void;
  variant?: "header" | "rail";
  readOnly?: boolean;
  // Sync state props - shows banner when config drifts from running kernel
  syncState?: { status: "synced" | "dirty" } | null;
  syncing?: boolean;
  onSyncNow?: () => Promise<boolean>;
  /** Show success feedback after sync completed */
  justSynced?: boolean;
}

export function DenoDependencyHeader({
  denoConfigInfo,
  flexibleNpmImports,
  onSetFlexibleNpmImports,
  variant = "header",
  readOnly = false,
  syncState,
  syncing,
  onSyncNow,
  justSynced,
}: DenoDependencyHeaderProps) {
  const isRail = variant === "rail";

  return (
    <div
      className={cn(isRail ? "space-y-3" : "border-b bg-emerald-50/30 dark:bg-emerald-950/10")}
      data-variant={variant}
    >
      <div className={cn(!isRail && "px-3 py-3")}>
        {/* Deno badge */}
        <div
          className={cn(
            "mb-2 flex items-center gap-2",
            isRail &&
              "mb-3 flex-wrap justify-between gap-x-2 gap-y-1 rounded-md border bg-background px-3 py-2 shadow-sm shadow-black/[0.02]",
          )}
        >
          <div className={cn("flex min-w-0 items-center gap-2", isRail && "shrink-0")}>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              Deno
            </span>
            <span
              className={cn(
                "text-xs text-muted-foreground",
                isRail ? "whitespace-nowrap" : "truncate",
              )}
            >
              Dependencies
            </span>
          </div>
          {isRail && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {denoConfigInfo ? "Config" : "Imports"}
            </span>
          )}
        </div>

        {/* Success feedback after sync completed */}
        {justSynced && (
          <div className="mb-3 flex items-center gap-2 rounded bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5 shrink-0" />
            <span>Kernel restarted — configuration applied</span>
          </div>
        )}

        {/* Config drift notice - kernel restart needed */}
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
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span>Configuration changed — restart kernel to apply</span>
            </div>
            <button
              type="button"
              onClick={onSyncNow}
              disabled={syncing}
              className={cn(
                "flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50",
                isRail && "self-start py-1",
              )}
            >
              <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
              Restart
            </button>
          </div>
        )}

        {/* deno.json detected banner */}
        {denoConfigInfo && (
          <div className="mb-3 rounded bg-muted/80 px-2 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span>
                Using <code className="rounded bg-muted px-1">{denoConfigInfo.relative_path}</code>
                {denoConfigInfo.name && (
                  <span className="text-muted-foreground ml-1">({denoConfigInfo.name})</span>
                )}
              </span>
            </div>
            {(denoConfigInfo.has_imports || denoConfigInfo.has_tasks) && (
              <div className="mt-1.5 flex gap-2 text-muted-foreground">
                {denoConfigInfo.has_imports && (
                  <span className="rounded bg-muted px-1.5 py-0.5">imports</span>
                )}
                {denoConfigInfo.has_tasks && (
                  <span className="rounded bg-muted px-1.5 py-0.5">tasks</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* No config file - explain how Deno handles deps */}
        {!denoConfigInfo && (
          <div className="mb-3 flex items-start gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              No <code className="rounded bg-muted px-1">deno.json</code> found. Deno can import
              modules directly without configuration.
            </span>
          </div>
        )}

        {/* Auto-install npm packages setting */}
        <div
          className={cn(
            "mb-3 flex items-start gap-2.5",
            isRail && "rounded-md border bg-background px-3 py-2",
          )}
        >
          <Checkbox
            id="flexible-npm-imports"
            checked={flexibleNpmImports}
            onCheckedChange={(checked) => {
              if (!readOnly) onSetFlexibleNpmImports(checked === true);
            }}
            className="mt-0.5"
            disabled={readOnly}
          />
          <Label
            htmlFor="flexible-npm-imports"
            className={cn(
              "flex-1 flex-col items-start gap-1",
              readOnly ? "cursor-default" : "cursor-pointer",
            )}
          >
            <span className="text-xs font-medium text-foreground">Auto-install npm packages</span>
            <p className="text-xs text-muted-foreground font-normal">
              Packages download automatically when you import them. Disable to use your
              project&apos;s node_modules instead.
            </p>
          </Label>
        </div>

        {/* Import examples */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Import modules directly in your code:
          </div>

          {/* npm packages */}
          <div className="rounded border bg-background px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Package className="h-3 w-3" />
              <span className="font-medium">npm packages</span>
            </div>
            <code className="text-xs text-emerald-600 dark:text-emerald-400">
              import _ from "npm:lodash@4";
            </code>
          </div>

          {/* JSR (recommended) */}
          <div className="rounded border bg-background px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Package className="h-3 w-3" />
              <span className="font-medium">JSR</span>
              <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                recommended
              </span>
            </div>
            <code className="text-xs text-emerald-600 dark:text-emerald-400">
              import &#123; assert &#125; from "jsr:@std/assert";
            </code>
          </div>

          {/* URL imports */}
          <div className="rounded border bg-background px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <ExternalLink className="h-3 w-3" />
              <span className="font-medium">URL imports</span>
            </div>
            <code className="text-xs text-emerald-600 dark:text-emerald-400 break-all">
              import &#123; serve &#125; from "https://deno.land/std/http/server.ts";
            </code>
          </div>
        </div>

        {/* Tip for import maps */}
        {!denoConfigInfo && (
          <div className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium">Tip:</span> Create a{" "}
            <code className="rounded bg-muted px-1">deno.json</code> with an{" "}
            <code className="rounded bg-muted px-1">"imports"</code> field to use shorter import
            specifiers.
          </div>
        )}
      </div>
    </div>
  );
}
