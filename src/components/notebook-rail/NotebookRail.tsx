import {
  Cloud,
  File,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  ListTree,
  Package,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  buildNotebookOutlineTree,
  resolveNotebookOutlineSelection,
  type NotebookOutlineItem,
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

export type NotebookRailPanelId = "content" | "outline" | "packages";

export type NotebookContentItemKind =
  | "notebook"
  | "file"
  | "folder"
  | "local"
  | "remote"
  | "shared";

export interface NotebookContentItem {
  id: string;
  kind: NotebookContentItemKind;
  title: string;
  detail?: string | null;
  meta?: string | null;
  href?: string | null;
  disabled?: boolean;
}

export interface NotebookContentSection {
  id: string;
  title: string;
  summary?: string | null;
  emptyLabel?: string | null;
  items: readonly NotebookContentItem[];
}

export const NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY = RAIL_TAKEOVER_MEDIA_QUERY;
export const NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME = RAIL_TAKEOVER_STAGE_CLASS_NAME;
export const NOTEBOOK_RAIL_TAKEOVER_PANEL_CLASS_NAMES = RAIL_TAKEOVER_PANEL_CLASS_NAMES;
const NOTEBOOK_RAIL_OUTLINE_PANEL_CLASS_NAME = "w-[clamp(15rem,20vw,18rem)] min-w-60";
const NOTEBOOK_RAIL_PACKAGES_PANEL_CLASS_NAME = "w-[clamp(15rem,20vw,17rem)] min-w-60";
const NOTEBOOK_RAIL_CONTENT_PANEL_CLASS_NAME = "w-[clamp(16rem,22vw,20rem)] min-w-64";

export interface NotebookRailProps {
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  contentSections?: readonly NotebookContentSection[];
  contentSummary?: string | null;
  outlineItems: readonly NotebookOutlineItem[];
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
  getOutlineItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
  className?: string;
}

const notebookRailButtons: Array<RailItem<NotebookRailPanelId>> = [
  { id: "content", label: "Content", icon: FolderOpen },
  { id: "outline", label: "Outline", icon: ListTree },
  { id: "packages", label: "Packages", icon: Package },
];

export function NotebookRail({
  activePanelId,
  collapsed,
  contentSections,
  contentSummary = null,
  outlineItems,
  outlineCellIds,
  activeOutlineItemId = null,
  selectedOutlineItemId = null,
  selectedOutlineCellId = null,
  packagesSummary = null,
  packagesPanel,
  onActivePanelChange,
  onCollapsedChange,
  onOpenContentItem,
  onSelectOutlineItem,
  onNavigateOutlineItem,
  getOutlineItemHref,
  className,
}: NotebookRailProps) {
  const hasContentPanel = contentSections !== undefined || activePanelId === "content";
  const railButtons = hasContentPanel
    ? notebookRailButtons
    : notebookRailButtons.filter((item) => item.id !== "content");
  const title =
    activePanelId === "content" ? "Content" : activePanelId === "outline" ? "Outline" : "Packages";
  const summary =
    activePanelId === "content"
      ? contentSummary
      : activePanelId === "packages"
        ? packagesSummary
        : null;
  const panelClassName =
    activePanelId === "content"
      ? NOTEBOOK_RAIL_CONTENT_PANEL_CLASS_NAME
      : activePanelId === "packages"
        ? NOTEBOOK_RAIL_PACKAGES_PANEL_CLASS_NAME
        : NOTEBOOK_RAIL_OUTLINE_PANEL_CLASS_NAME;

  return (
    <Rail
      activePanelId={activePanelId}
      collapsed={collapsed}
      items={railButtons}
      panelEyebrow="Notebook"
      panelTitle={title}
      panelSummary={summary}
      panelClassName={panelClassName}
      className={className}
      dataTestId="notebook-rail"
      collapseButtonSlot="notebook-rail-collapse-button"
      panelSlot="notebook-rail-panel"
      panelTitleRowSlot="notebook-rail-panel-title-row"
      onActivePanelChange={onActivePanelChange}
      onCollapsedChange={onCollapsedChange}
    >
      {activePanelId === "content" ? (
        <NotebookContentPanel sections={contentSections ?? []} onOpenItem={onOpenContentItem} />
      ) : activePanelId === "outline" ? (
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
      ) : (
        packagesPanel
      )}
    </Rail>
  );
}

export interface NotebookContentPanelProps {
  sections: readonly NotebookContentSection[];
  onOpenItem?: (item: NotebookContentItem) => void;
}

export function NotebookContentPanel({ sections, onOpenItem }: NotebookContentPanelProps) {
  if (sections.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground"
        data-testid="notebook-content-panel"
      >
        No content sources yet.
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="notebook-content-panel">
      {sections.map((section) => (
        <section key={section.id} className="space-y-2" aria-labelledby={`content-${section.id}`}>
          <div className="flex min-w-0 items-center justify-between gap-2 px-1">
            <h3
              id={`content-${section.id}`}
              className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            >
              {section.title}
            </h3>
            {section.summary ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{section.summary}</span>
            ) : null}
          </div>
          {section.items.length === 0 ? (
            <div className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
              {section.emptyLabel ?? "Nothing here yet."}
            </div>
          ) : (
            <div className="space-y-1">
              {section.items.map((item) => (
                <NotebookContentRow key={item.id} item={item} onOpenItem={onOpenItem} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function NotebookContentRow({
  item,
  onOpenItem,
}: {
  item: NotebookContentItem;
  onOpenItem?: (item: NotebookContentItem) => void;
}) {
  const Icon = notebookContentItemIcon(item.kind);
  const content = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="line-clamp-2 block break-words text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]"
          data-slot="content-item-title"
        >
          {item.title}
        </span>
        {item.detail ? (
          <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {item.detail}
          </span>
        ) : null}
      </span>
      {item.meta ? (
        <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {item.meta}
        </span>
      ) : null}
    </>
  );
  const className = cn(
    "flex min-h-10 w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
    item.disabled
      ? "cursor-not-allowed opacity-50"
      : "hover:bg-muted/70 hover:[&_[data-slot=content-item-title]]:text-foreground",
  );

  if (item.href && !item.disabled) {
    return (
      <a href={item.href} className={className} aria-label={item.title}>
        {content}
      </a>
    );
  }

  if (onOpenItem && !item.disabled) {
    return (
      <button type="button" onClick={() => onOpenItem(item)} className={className}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}

function notebookContentItemIcon(kind: NotebookContentItemKind): LucideIcon {
  switch (kind) {
    case "notebook":
      return FileText;
    case "folder":
      return Folder;
    case "local":
      return HardDrive;
    case "remote":
      return Cloud;
    case "shared":
      return Share2;
    case "file":
    default:
      return File;
  }
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
  onSelectItem,
  onNavigateItem,
  getItemHref,
}: NotebookOutlinePanelProps) {
  const tree = useMemo(() => buildNotebookOutlineTree(items), [items]);

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        No headings yet.
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
      aria-label="Notebook outline"
      data-testid="notebook-outline-panel"
      data-drag-policy="navigation-only"
      onDragStartCapture={handleDragStart}
    >
      <ol className="space-y-0.5">
        {tree.map((node) => (
          <NotebookOutlineNode
            key={node.item.id}
            node={node}
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
  selectedItemId,
  onSelectItem,
  onNavigateItem,
  getItemHref,
}: {
  node: NotebookOutlineTreeNode;
  selectedItemId: string | null;
  onSelectItem?: (item: NotebookOutlineItem) => void;
  onNavigateItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
}) {
  const item = node.item;
  const selected = selectedItemId === item.id;
  const itemHref = getItemHref?.(item) ?? item.href ?? null;
  const className = cn(
    "relative flex min-h-8 w-full items-start gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-sm transition-colors",
    "cursor-pointer select-none touch-manipulation [-webkit-user-drag:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
    "before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-transparent before:transition-colors",
    selected
      ? "font-medium text-foreground before:bg-primary"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
  );
  const content = (
    <>
      <span
        data-slot="notebook-outline-item-title"
        className="line-clamp-2 min-w-0 flex-1 break-words leading-snug [overflow-wrap:anywhere]"
      >
        {item.title}
      </span>
      {item.statusLabel ? (
        <span
          data-slot="notebook-outline-item-meta"
          className={cn(
            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            selected ? "bg-muted text-foreground/70" : "bg-muted text-muted-foreground",
          )}
        >
          {item.statusLabel}
        </span>
      ) : item.detail ? (
        <span
          data-slot="notebook-outline-item-meta"
          className={cn(
            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            selected ? "bg-muted text-foreground/70" : "bg-muted text-muted-foreground",
          )}
        >
          {item.detail}
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
      <li data-outline-level={item.level}>
        <a
          href={itemHref}
          draggable={false}
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
    <li data-outline-level={item.level}>
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
