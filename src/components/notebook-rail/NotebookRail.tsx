import { ListTree, Package, Server } from "lucide-react";
import { useMemo, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  buildNotebookOutlineTree,
  resolveNotebookOutlineSelection,
  type NotebookOutlineItem,
  type NotebookOutlineTitleSegment,
  type NotebookOutlineTreeNode,
} from "runtimed";
import {
  Rail,
  RAIL_TAKEOVER_MEDIA_QUERY,
  RAIL_TAKEOVER_PANEL_CLASS_NAMES,
  RAIL_TAKEOVER_STAGE_CLASS_NAME,
  type RailItem,
} from "@/components/rail";
import { cn } from "@/lib/utils";

export type NotebookRailPanelId = "outline" | "packages" | "workstations";

export const NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY = RAIL_TAKEOVER_MEDIA_QUERY;
export const NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME = RAIL_TAKEOVER_STAGE_CLASS_NAME;
export const NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES = RAIL_TAKEOVER_PANEL_CLASS_NAMES;
const NOTEBOOK_RAIL_PANEL_CLASS_NAME = "w-[clamp(18rem,22vw,20rem)] min-w-72";
const NOTEBOOK_OUTLINE_PANEL_SHIFT_PX = 4;
const NOTEBOOK_OUTLINE_BODY_PADDING_PX = 12;
const NOTEBOOK_OUTLINE_NESTED_STEP_PX = 21;

export interface NotebookRailProps {
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  outlineItems: readonly NotebookOutlineItem[];
  outlineCellIds?: readonly string[];
  activeOutlineItemId?: string | null;
  selectedOutlineItemId?: string | null;
  selectedOutlineCellId?: string | null;
  packagesPanel: ReactNode;
  workstationsPanel?: ReactNode;
  onActivePanelChange: (panelId: NotebookRailPanelId) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelectOutlineItem?: (item: NotebookOutlineItem) => void;
  onNavigateOutlineItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getOutlineItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
  className?: string;
}

const baseRailButtons: Array<RailItem<NotebookRailPanelId>> = [
  { id: "outline", label: "Outline", icon: ListTree },
  { id: "packages", label: "Packages", icon: Package },
];

export function NotebookRail({
  activePanelId,
  collapsed,
  outlineItems,
  outlineCellIds,
  activeOutlineItemId = null,
  selectedOutlineItemId = null,
  selectedOutlineCellId = null,
  packagesPanel,
  workstationsPanel,
  onActivePanelChange,
  onCollapsedChange,
  onSelectOutlineItem,
  onNavigateOutlineItem,
  getOutlineItemHref,
  className,
}: NotebookRailProps) {
  const railButtons = workstationsPanel
    ? [...baseRailButtons, { id: "workstations" as const, label: "Workstations", icon: Server }]
    : baseRailButtons;
  const title =
    activePanelId === "packages"
      ? "Packages"
      : activePanelId === "workstations"
        ? "Workstations"
        : "Outline";
  return (
    <Rail
      activePanelId={activePanelId}
      collapsed={collapsed}
      items={railButtons}
      panelEyebrow="Notebook"
      panelTitle={title}
      panelClassName={NOTEBOOK_RAIL_PANEL_CLASS_NAME}
      className={className}
      dataTestId="notebook-rail"
      panelSlot="notebook-rail-panel"
      panelTitleRowSlot="notebook-rail-panel-title-row"
      onActivePanelChange={onActivePanelChange}
      onCollapsedChange={onCollapsedChange}
    >
      {activePanelId === "outline" ? (
        <NotebookOutlinePanel
          items={outlineItems}
          cellIds={outlineCellIds}
          activeItemId={activeOutlineItemId}
          selectedItemId={selectedOutlineItemId}
          selectedCellId={selectedOutlineCellId}
          onSelectItem={onSelectOutlineItem}
          onNavigateItem={onNavigateOutlineItem}
          getItemHref={getOutlineItemHref}
        />
      ) : activePanelId === "packages" ? (
        packagesPanel
      ) : (
        workstationsPanel
      )}
    </Rail>
  );
}

export {
  RailButton as NotebookRailButton,
  type RailButtonProps as NotebookRailButtonProps,
} from "@/components/rail";

export interface NotebookOutlinePanelProps {
  items: readonly NotebookOutlineItem[];
  cellIds?: readonly string[];
  activeItemId?: string | null;
  selectedItemId?: string | null;
  selectedCellId?: string | null;
  ariaLabel?: string;
  emptyMessage?: string;
  onSelectItem?: (item: NotebookOutlineItem) => void;
  onNavigateItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
}

export function NotebookOutlinePanel({
  items,
  cellIds,
  activeItemId = null,
  selectedItemId = null,
  selectedCellId = null,
  ariaLabel = "Notebook outline",
  emptyMessage = "Add Markdown headings to structure your notebook. They will appear here.",
  onSelectItem,
  onNavigateItem,
  getItemHref,
}: NotebookOutlinePanelProps) {
  const tree = useMemo(() => buildNotebookOutlineTree(items), [items]);

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  const resolvedSelectedItemId = resolveNotebookOutlineSelection(items, {
    selectedItemId,
    selectedCellId,
    cellIds,
  });
  const activeSelectedItemId =
    activeItemId && items.some((item) => item.id === activeItemId) ? activeItemId : null;
  const currentItemId = resolvedSelectedItemId ?? activeSelectedItemId;
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
  };

  return (
    <nav
      aria-label={ariaLabel}
      className="-ml-1"
      data-testid="notebook-outline-panel"
      data-drag-policy="navigation-only"
      onDragStartCapture={handleDragStart}
    >
      <ol className="space-y-0.5">
        {tree.map((node) => (
          <NotebookOutlineNode
            key={node.item.id}
            node={node}
            depth={0}
            selectedItemId={currentItemId}
            onSelectItem={onSelectItem}
            onNavigateItem={onNavigateItem}
            getItemHref={getItemHref}
          />
        ))}
      </ol>
    </nav>
  );
}

function NotebookOutlineNode({
  node,
  depth,
  selectedItemId,
  onSelectItem,
  onNavigateItem,
  getItemHref,
}: {
  node: NotebookOutlineTreeNode;
  depth: number;
  selectedItemId: string | null;
  onSelectItem?: (item: NotebookOutlineItem) => void;
  onNavigateItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
}) {
  const item = node.item;
  const selected = selectedItemId === item.id;
  const itemHref = getItemHref?.(item) ?? item.href ?? null;
  const isCodeCellOutlineItem = item.kind === "cell" && item.cellType === "code";
  const isMarkdownCellOutlineItem = item.kind === "cell" && item.cellType === "markdown";
  const isImageOutputItem = item.kind === "output" && item.imagePreview;
  const metaLabel =
    isCodeCellOutlineItem || isMarkdownCellOutlineItem || isImageOutputItem
      ? null
      : (item.statusLabel ?? item.detail ?? null);
  const className = cn(
    "relative flex min-h-8 w-full items-start gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-sm transition-colors",
    "cursor-pointer select-none touch-manipulation [-webkit-user-drag:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
    selected
      ? "font-medium text-foreground"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
  );
  const content = (
    <>
      {isImageOutputItem ? (
        <img
          src={item.imagePreview?.src}
          alt=""
          data-slot="notebook-outline-item-image"
          className="mt-0.5 max-h-12 max-w-full rounded border border-border bg-muted object-contain"
        />
      ) : null}
      {isImageOutputItem ? null : (
        <span
          data-slot="notebook-outline-item-title"
          className={cn(
            "min-w-0 flex-1 leading-snug",
            isCodeCellOutlineItem
              ? "truncate font-mono text-[13px] tracking-normal"
              : "line-clamp-2 break-words [overflow-wrap:anywhere]",
          )}
        >
          <NotebookOutlineTitle item={item} />
        </span>
      )}
      {metaLabel ? (
        <span
          data-slot="notebook-outline-item-meta"
          className={cn(
            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            selected ? "bg-muted text-foreground/70" : "bg-muted text-muted-foreground",
          )}
        >
          {metaLabel}
        </span>
      ) : null}
    </>
  );
  const children =
    node.children.length > 0 ? (
      <ol className="ml-3 border-l border-border/70 pl-2">
        {node.children.map((child) => (
          <NotebookOutlineNode
            key={child.item.id}
            node={child}
            depth={depth + 1}
            selectedItemId={selectedItemId}
            onSelectItem={onSelectItem}
            onNavigateItem={onNavigateItem}
            getItemHref={getItemHref}
          />
        ))}
      </ol>
    ) : null;

  if (itemHref) {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onSelectItem?.(item);
      if (onNavigateItem?.(item, itemHref) === true) {
        event.preventDefault();
      }
    };

    return (
      <li className="relative" data-outline-level={item.level}>
        <NotebookOutlineSelectedMarker selected={selected} depth={depth} />
        <a
          href={itemHref}
          draggable={false}
          aria-label={isImageOutputItem ? item.title : undefined}
          aria-current={selected ? "location" : undefined}
          onDragStart={(event) => event.preventDefault()}
          onClick={handleClick}
          className={className}
        >
          {content}
        </a>
        {children}
      </li>
    );
  }

  return (
    <li className="relative" data-outline-level={item.level}>
      <NotebookOutlineSelectedMarker selected={selected} depth={depth} />
      <button
        type="button"
        aria-current={selected ? "location" : undefined}
        onClick={() => onSelectItem?.(item)}
        className={className}
      >
        {content}
      </button>
      {children}
    </li>
  );
}

function NotebookOutlineSelectedMarker({ selected, depth }: { selected: boolean; depth: number }) {
  if (!selected) return null;

  const leftPx =
    NOTEBOOK_OUTLINE_BODY_PADDING_PX -
    NOTEBOOK_OUTLINE_PANEL_SHIFT_PX +
    depth * NOTEBOOK_OUTLINE_NESTED_STEP_PX;

  return (
    <span
      aria-hidden="true"
      data-slot="notebook-outline-selected-marker"
      className="absolute bottom-1.5 top-1.5 z-10 w-0.5 rounded-full bg-primary"
      style={{ left: `-${leftPx}px` }}
    />
  );
}

function NotebookOutlineTitle({ item }: { item: NotebookOutlineItem }) {
  if (item.kind === "cell" && item.cellType === "code") return item.title;
  if (!item.titleSegments || item.titleSegments.length === 0) return item.title;

  return item.titleSegments.map((segment, index) => (
    <NotebookOutlineTitleSegmentView key={`${index}:${segment.text}`} segment={segment} />
  ));
}

function NotebookOutlineTitleSegmentView({ segment }: { segment: NotebookOutlineTitleSegment }) {
  const className = outlineTitleSegmentClassName(segment.semantic);
  if (!className) return <>{segment.text}</>;
  return (
    <span
      className={className}
      title={segment.title ?? undefined}
      data-inline-semantic={segment.semantic ?? undefined}
    >
      {segment.text}
    </span>
  );
}

function outlineTitleSegmentClassName(semantic: string | null | undefined): string | null {
  switch (semantic) {
    case "strong":
      return "font-semibold text-foreground";
    case "emphasis":
      return "italic";
    case "delete":
      return "line-through decoration-muted-foreground/70";
    case "inline-code":
      return "rounded border border-border/70 bg-muted/80 px-1 py-0.5 font-mono text-[0.9em] text-foreground";
    case "math-source":
      return "font-serif";
    default:
      return null;
  }
}

export interface NotebookPackagesPanelProps {
  children: ReactNode;
  readOnly?: boolean;
}

export function NotebookPackagesPanel({ children, readOnly = false }: NotebookPackagesPanelProps) {
  return (
    <div
      className="space-y-3"
      data-testid="notebook-packages-panel"
      data-read-only={readOnly ? "true" : "false"}
    >
      {children}
    </div>
  );
}
