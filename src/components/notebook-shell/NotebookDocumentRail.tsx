import { NotebookRail, type NotebookRailPanelId } from "@/components/notebook-rail";
import type { ReactNode } from "react";
import type { NotebookOutlineItem } from "runtimed";
import type { NotebookViewModel } from "./view-model";

export interface NotebookDocumentRailProps {
  viewModel: Pick<NotebookViewModel, "outlineItems" | "packages">;
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  selectedOutlineItemId?: string | null;
  packagesPanel: ReactNode;
  onActivePanelChange: (panelId: NotebookRailPanelId) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelectOutlineItem?: (item: NotebookOutlineItem) => void;
  onNavigateOutlineItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  className?: string;
}

export function NotebookDocumentRail({
  viewModel,
  activePanelId,
  collapsed,
  selectedOutlineItemId = null,
  packagesPanel,
  onActivePanelChange,
  onCollapsedChange,
  onSelectOutlineItem,
  onNavigateOutlineItem,
  className,
}: NotebookDocumentRailProps) {
  return (
    <NotebookRail
      activePanelId={activePanelId}
      collapsed={collapsed}
      outlineItems={viewModel.outlineItems}
      selectedOutlineItemId={selectedOutlineItemId}
      packagesSummary={viewModel.packages.summary}
      packagesPanel={packagesPanel}
      onActivePanelChange={onActivePanelChange}
      onCollapsedChange={onCollapsedChange}
      onSelectOutlineItem={onSelectOutlineItem}
      onNavigateOutlineItem={onNavigateOutlineItem}
      className={className}
    />
  );
}
