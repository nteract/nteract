import { NotebookPackagesPanel } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";
import type { NotebookPackageViewModel } from "./view-model";

export interface NotebookPackageSummaryPanelProps {
  packages: NotebookPackageViewModel;
  readOnly?: boolean;
  className?: string;
}

export function NotebookPackageSummaryPanel({
  packages,
  readOnly = true,
  className,
}: NotebookPackageSummaryPanelProps) {
  return (
    <NotebookPackagesPanel readOnly={readOnly}>
      <div className={cn("space-y-3", className)} data-slot="notebook-package-summary-panel">
        {packages.sections.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No package metadata in this notebook.
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
                      ? "1 dependency"
                      : `${section.dependencies.length} dependencies`}
                  </p>
                </div>
                {readOnly ? (
                  <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    Read only
                  </span>
                ) : null}
              </div>

              {section.dependencies.length > 0 ? (
                <PackageValueList values={section.dependencies} />
              ) : (
                <p className="text-xs text-muted-foreground">No inline dependencies.</p>
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
    </NotebookPackagesPanel>
  );
}

function PackageValueList({ values }: { values: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <code key={value} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
          {value}
        </code>
      ))}
    </div>
  );
}
