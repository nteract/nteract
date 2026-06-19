import {
  EnvironmentPackageSummaryPanel,
  type EnvironmentPackageSummaryPanelProps,
} from "@/components/environment";
import { NotebookPackagesPanel } from "@/components/notebook-rail";
import { cn } from "@/lib/utils";

export interface NotebookPackageSummaryPanelProps extends EnvironmentPackageSummaryPanelProps {}

export function NotebookPackageSummaryPanel({
  readOnly = true,
  className,
  ...props
}: NotebookPackageSummaryPanelProps) {
  return (
    <NotebookPackagesPanel readOnly={readOnly}>
      <EnvironmentPackageSummaryPanel
        className={cn("-my-3", className)}
        readOnly={readOnly}
        {...props}
      />
    </NotebookPackagesPanel>
  );
}
