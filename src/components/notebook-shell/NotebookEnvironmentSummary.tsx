import { CheckCircle2, Lock, Package, RefreshCw, Server, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { notebookActorIdentityFromRuntime } from "./actor-projection";
import type { NotebookShellCapabilities } from "./capabilities";
import type { NotebookPackageViewModel } from "./view-model";

export interface NotebookEnvironmentSummaryProps {
  capabilities: NotebookShellCapabilities;
  packages: NotebookPackageViewModel;
  runtimeLabel?: string | null;
  packageSourceLabel?: string | null;
  syncLabel?: string | null;
  trustLabel?: string | null;
  showPackageDetails?: boolean;
  className?: string;
}

export function NotebookEnvironmentSummary({
  capabilities,
  packages,
  runtimeLabel = null,
  packageSourceLabel = null,
  syncLabel = null,
  trustLabel = null,
  showPackageDetails = true,
  className,
}: NotebookEnvironmentSummaryProps) {
  const packageAccessLabel = capabilities.canManagePackages
    ? "Package edits available"
    : capabilities.canViewPackages
      ? "Package metadata read only"
      : "Package metadata hidden";
  const runtimeStateLabel =
    runtimeLabel ?? (capabilities.canExecute ? "Runtime ready" : "No runtime");
  const runtimeActor = notebookActorIdentityFromRuntime(capabilities.runtime, capabilities.auth);
  const runtimeDetail = capabilities.runtime.canWriteRuntimeState
    ? `Runtime author: ${runtimeActor?.label ?? "connected runtime"}`
    : capabilities.runtime.connected
      ? `Runtime connected through ${accessSourceLabel(capabilities.runtime.source)}`
      : null;

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
            {accessLevelLabel(capabilities.access.level)} access through{" "}
            {accessSourceLabel(capabilities.access.source)}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
          {capabilities.access.isPublic ? "Public" : "Private"}
        </span>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2">
        <SummaryFact
          icon={<Server className="size-3.5" aria-hidden="true" />}
          label="Runtime"
          value={runtimeStateLabel}
          detail={runtimeDetail}
          muted={!capabilities.canExecute && !capabilities.runtime.connected}
        />
        <SummaryFact
          icon={<Package className="size-3.5" aria-hidden="true" />}
          label="Packages"
          value={packages.summary ?? "No package metadata"}
          detail={packageSourceLabel ?? packageAccessLabel}
          muted={!capabilities.canViewPackages}
        />
        <SummaryFact
          icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          label="Sync"
          value={syncLabel ?? "Sync status not reported"}
          muted={!syncLabel}
        />
        <SummaryFact
          icon={
            trustLabel?.toLowerCase().includes("untrusted") ? (
              <ShieldAlert className="size-3.5" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
            )
          }
          label="Trust"
          value={trustLabel ?? "Trust state not required"}
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

function accessLevelLabel(level: NotebookShellCapabilities["access"]["level"]): string {
  switch (level) {
    case "none":
      return "No";
    case "viewer":
      return "Viewer";
    case "editor":
      return "Editor";
    case "owner":
      return "Owner";
  }
}

function accessSourceLabel(source: NotebookShellCapabilities["access"]["source"]): string {
  switch (source) {
    case "cloud":
      return "cloud";
    case "local":
      return "local";
    case "fixture":
      return "fixture";
    case "unknown":
      return "unknown host";
  }
}
