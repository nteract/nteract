import { CheckCircle2, Lock, Package, RefreshCw, Server, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookShellCapabilities } from "./capabilities";
import {
  createNotebookEnvironmentSurface,
  type NotebookEnvironmentSurface,
} from "./environment-surface";
import type { NotebookPackageViewModel } from "./view-model";

export interface NotebookEnvironmentSummaryProps {
  capabilities: NotebookShellCapabilities;
  packages: NotebookPackageViewModel;
  environment?: NotebookEnvironmentSurface;
  runtimeLabel?: string | null;
  packageSourceLabel?: string | null;
  syncLabel?: string | null;
  trustLabel?: string | null;
  showPackageDetails?: boolean;
  className?: string;
}

export function NotebookEnvironmentSummary({
  capabilities,
  environment,
  packages,
  runtimeLabel = null,
  packageSourceLabel = null,
  syncLabel = null,
  trustLabel = null,
  showPackageDetails = true,
  className,
}: NotebookEnvironmentSummaryProps) {
  const surface =
    environment ??
    createNotebookEnvironmentSurface({
      capabilities,
      packages,
      runtimeLabel,
      packageSourceLabel,
      syncLabel,
      trustLabel,
    });

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      data-slot="notebook-environment-summary"
      data-can-execute={capabilities.canExecute}
      data-can-manage-packages={capabilities.canManagePackages}
      data-access-level={capabilities.access.level}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold">Notebook environment</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {surface.access.label} access through {surface.access.sourceLabel}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {surface.access.visibilityLabel}
        </span>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2">
        <SummaryFact
          icon={<Server className="size-3.5" aria-hidden="true" />}
          label="Runtime"
          value={surface.runtime.label}
          detail={surface.runtime.detail}
          muted={surface.runtime.muted}
        />
        <SummaryFact
          icon={<Package className="size-3.5" aria-hidden="true" />}
          label="Packages"
          value={surface.packages.summary}
          detail={surface.packages.sourceLabel}
          muted={surface.packages.muted}
        />
        <SummaryFact
          icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          label="Sync"
          value={surface.sync.label}
          muted={surface.sync.muted}
        />
        <SummaryFact
          icon={
            surface.trust.attention ? (
              <ShieldAlert className="size-3.5" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
            )
          }
          label="Trust"
          value={surface.trust.label}
        />
      </div>

      {showPackageDetails ? (
        <div className="border-t border-border px-4 py-3">
          {packages.sections.length === 0 ? (
            <p className="text-xs text-muted-foreground">No package manager metadata available.</p>
          ) : (
            <div className="space-y-3">
              {packages.sections.map((section) => (
                <div key={section.manager} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">{section.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {section.dependencies.length === 1
                        ? "1 dependency"
                        : `${section.dependencies.length} dependencies`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ...section.dependencies,
                      ...section.details.flatMap((detail) => detail.values),
                    ]
                      .slice(0, 8)
                      .map((value, index) => (
                        <code
                          key={`${section.manager}:${value}:${index}`}
                          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {value}
                        </code>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SummaryFact({
  detail,
  icon,
  label,
  muted = false,
  value,
}: {
  detail?: string | null;
  icon: ReactNode;
  label: string;
  muted?: boolean;
  value: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-background p-3",
        muted && "bg-muted/40 text-muted-foreground",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
        {muted ? <Lock className="size-3.5" aria-hidden="true" /> : icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-semibold">{value}</div>
      {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
    </div>
  );
}
