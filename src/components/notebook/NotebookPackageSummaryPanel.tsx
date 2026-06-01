import {
  EnvironmentPackageSummaryPanel,
  type EnvironmentPackageSummaryPanelProps,
} from "@/components/environment";
import { NotebookPackagesPanel } from "@/components/notebook-rail";

export interface NotebookPackageSummaryPanelProps extends EnvironmentPackageSummaryPanelProps {}

export function NotebookPackageSummaryPanel({
  readOnly = true,
  ...props
}: NotebookPackageSummaryPanelProps) {
  return (
    <NotebookPackagesPanel readOnly={readOnly}>
      <EnvironmentPackageSummaryPanel readOnly={readOnly} {...props} />
    </NotebookPackagesPanel>
  );
}
