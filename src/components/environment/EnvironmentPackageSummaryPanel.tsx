import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NotebookPackageViewModel } from "./package-view-model";

export interface EnvironmentPackageSummaryPanelProps {
  packages: NotebookPackageViewModel;
  readOnly?: boolean;
  header?: ReactNode;
  className?: string;
}

export function EnvironmentPackageSummaryPanel({
  packages,
  readOnly = true,
  header = null,
  className,
}: EnvironmentPackageSummaryPanelProps) {
  return (
    <div className={cn("space-y-3", className)} data-slot="environment-package-summary-panel">
      {header}
      {packages.sections.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          No package details yet.
        </div>
      ) : (
        packages.sections.map((section) => (
          <section
            key={section.manager}
            className="rounded-md border bg-background px-3 py-3 shadow-sm shadow-black/[0.02]"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{section.label}</h3>
                <p className="text-xs text-muted-foreground">
                  {section.dependencies.length === 1
                    ? "1 declared dependency"
                    : `${section.dependencies.length} declared dependencies`}
                </p>
              </div>
              {readOnly ? (
                <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  View only
                </span>
              ) : null}
            </div>

            {section.dependencies.length > 0 ? (
              <PackageValueList values={section.dependencies} />
            ) : (
              <p className="text-xs text-muted-foreground">No inline dependencies yet.</p>
            )}

            {section.details.length > 0 ? (
              <dl className="mt-3 space-y-2 text-xs">
                {section.details.map((detail) => (
                  <div key={detail.label} className="space-y-1">
                    <dt className="font-medium text-muted-foreground">{detail.label}</dt>
                    <dd>
                      <PackageValueList values={detail.values} />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}

function PackageValueList({ values }: { values: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value, index) => (
        <code key={`${value}:${index}`} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
          {value}
        </code>
      ))}
    </div>
  );
}
