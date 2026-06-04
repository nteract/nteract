import {
  NotebookRail,
  type NotebookContentItem,
  type NotebookContentSection,
  type NotebookRailPanelId,
} from "@/components/notebook-rail";
import type { ReactNode } from "react";
import type { NotebookOutlineItem } from "runtimed";
import type { NotebookViewModel } from "./view-model";

export interface NotebookDocumentRailProps {
  viewModel: Pick<NotebookViewModel, "outlineItems" | "packages">;
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  contentSections?: readonly NotebookContentSection[];
  contentSummary?: string | null;
  outlineCellIds?: readonly string[];
  activeOutlineItemId?: string | null;
  selectedOutlineItemId?: string | null;
  selectedOutlineCellId?: string | null;
  packagesSummary?: string | null;
  packagesPanel: ReactNode;
  onActivePanelChange: (panelId: NotebookRailPanelId) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenContentItem?: (item: NotebookContentItem) => void;
  onSelectOutlineItem?: (item: NotebookOutlineItem) => void;
  onNavigateOutlineItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  className?: string;
}

export function NotebookDocumentRail({
  viewModel,
  activePanelId,
  collapsed,
  contentSections,
  contentSummary,
  outlineCellIds,
  activeOutlineItemId = null,
  selectedOutlineItemId = null,
  selectedOutlineCellId = null,
  packagesSummary,
  packagesPanel,
  onActivePanelChange,
  onCollapsedChange,
  onOpenContentItem,
  onSelectOutlineItem,
  onNavigateOutlineItem,
  className,
}: NotebookDocumentRailProps) {
  return (
    <NotebookRail
      activePanelId={activePanelId}
      collapsed={collapsed}
      contentSections={contentSections}
      contentSummary={contentSummary}
      outlineItems={viewModel.outlineItems}
      outlineCellIds={outlineCellIds}
      activeOutlineItemId={activeOutlineItemId}
      selectedOutlineItemId={selectedOutlineItemId}
      selectedOutlineCellId={selectedOutlineCellId}
      packagesSummary={packagesSummary === undefined ? viewModel.packages.summary : packagesSummary}
      packagesPanel={packagesPanel}
      onActivePanelChange={onActivePanelChange}
      onCollapsedChange={onCollapsedChange}
      onOpenContentItem={onOpenContentItem}
      onSelectOutlineItem={onSelectOutlineItem}
      onNavigateOutlineItem={onNavigateOutlineItem}
      className={className}
    />
  );
}
