import { cn } from "@/lib/utils";
import type { NotebookPackageSection, NotebookPackageViewModel } from "./package-view-model";

export interface EnvironmentPackageSummaryPanelProps {
  packages: NotebookPackageViewModel;
  readOnly?: boolean;
  className?: string;
}

export function EnvironmentPackageSummaryPanel({
  packages,
  readOnly = true,
  className,
}: EnvironmentPackageSummaryPanelProps) {
  const packageEntries = packageListEntries(packages.sections);

  return (
    <div
      className={cn("space-y-1", className)}
      data-slot="environment-package-summary-panel"
      data-read-only={readOnly ? "true" : "false"}
    >
      {packageEntries.length === 0 ? (
        <div className="border-y border-dashed border-border/80 px-1 py-4 text-sm text-muted-foreground">
          No declared packages.
        </div>
      ) : (
        <ul
          className="divide-y divide-border/70 border-y border-border/70"
          aria-label="Declared packages"
        >
          {packageEntries.map((entry) => (
            <li key={entry.key} className="min-w-0 px-1 py-2">
              <code className="block truncate bg-transparent font-mono text-[12px] leading-5 text-foreground">
                {entry.name}
              </code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface PackageListEntry {
  key: string;
  name: string;
}

function packageListEntries(sections: readonly NotebookPackageSection[]): PackageListEntry[] {
  return sections.flatMap((section) => {
    const declared = section.dependencies.map((name, index) => ({
      key: `${section.manager}:dependencies:${index}:${name}`,
      name,
    }));
    const pypi = section.details
      .filter((detail) => detail.label === "PyPI")
      .flatMap((detail) =>
        detail.values.map((name, index) => ({
          key: `${section.manager}:pypi:${index}:${name}`,
          name,
        })),
      );

    return [...declared, ...pypi];
  });
}
