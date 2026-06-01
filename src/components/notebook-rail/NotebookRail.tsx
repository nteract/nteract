import { ChevronLeft, ChevronRight, ListTree, Package, type LucideIcon } from "lucide-react";
import { useMemo, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  buildNotebookOutlineTree,
  resolveNotebookOutlineSelection,
  type NotebookOutlineItem,
  type NotebookOutlineTreeNode,
} from "runtimed";
import { cn } from "@/lib/utils";

export type NotebookRailPanelId = "outline" | "packages";

export interface NotebookRailProps {
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  outlineItems: readonly NotebookOutlineItem[];
  outlineCellIds?: readonly string[];
  activeOutlineItemId?: string | null;
  selectedOutlineItemId?: string | null;
  selectedOutlineCellId?: string | null;
  packagesSummary?: string | null;
  packagesPanel: ReactNode;
  onActivePanelChange: (panelId: NotebookRailPanelId) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelectOutlineItem?: (item: NotebookOutlineItem) => void;
  onNavigateOutlineItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getOutlineItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
  className?: string;
}

const railButtons: Array<{
  id: NotebookRailPanelId;
  label: string;
  icon: LucideIcon;
}> = [
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
  packagesSummary = null,
  packagesPanel,
  onActivePanelChange,
  onCollapsedChange,
  onSelectOutlineItem,
  onNavigateOutlineItem,
  getOutlineItemHref,
  className,
}: NotebookRailProps) {
  const title = activePanelId === "outline" ? "Outline" : "Packages";
  const summary = activePanelId === "packages" ? packagesSummary : null;

  return (
    <aside
      className={cn("flex min-h-0 shrink-0 border-r bg-background", className)}
      data-testid="notebook-rail"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-muted/40 px-2 py-3">
        <NotebookRailButton
          label={collapsed ? "Expand rail" : "Collapse rail"}
          icon={collapsed ? ChevronRight : ChevronLeft}
          active={false}
          onClick={() => onCollapsedChange(!collapsed)}
        />
        {railButtons.map((item) => (
          <NotebookRailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={!collapsed && activePanelId === item.id}
            onClick={() => {
              if (!collapsed && activePanelId === item.id) {
                onCollapsedChange(true);
                return;
              }
              onActivePanelChange(item.id);
              onCollapsedChange(false);
            }}
          />
        ))}
      </div>

      {!collapsed && (
        <div
          className="flex min-h-0 w-80 max-w-[34vw] min-w-64 flex-col bg-background max-sm:w-[calc(100vw-3rem)] max-sm:min-w-0 max-sm:max-w-none"
          data-slot="notebook-rail-panel"
        >
          <div className="border-b px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Notebook
                </p>
                <h2 className="mt-1 truncate text-sm font-semibold text-foreground">{title}</h2>
              </div>
              {summary && (
                <span className="max-w-full self-start truncate rounded-full border bg-muted px-2 py-1 text-[11px] text-muted-foreground sm:shrink-0">
                  {summary}
                </span>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
            ) : (
              packagesPanel
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

export interface NotebookRailButtonProps {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function NotebookRailButton({
  label,
  icon: Icon,
  active = false,
  disabled = false,
  onClick,
}: NotebookRailButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md border text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:border-transparent hover:bg-transparent",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

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
    "relative flex min-h-8 w-full items-center gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-sm transition-colors",
    "cursor-pointer select-none touch-manipulation [-webkit-user-drag:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
    "before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-transparent before:transition-colors",
    selected
      ? "bg-primary/8 text-foreground before:bg-primary"
      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
  );
  const content = (
    <>
      <span data-slot="notebook-outline-item-title" className="min-w-0 flex-1 truncate">
        {item.title}
      </span>
      {item.statusLabel ? (
        <span
          data-slot="notebook-outline-item-meta"
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            selected ? "bg-primary/10 text-foreground/70" : "bg-muted text-muted-foreground",
          )}
        >
          {item.statusLabel}
        </span>
      ) : item.detail ? (
        <span
          data-slot="notebook-outline-item-meta"
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            selected ? "bg-primary/10 text-foreground/70" : "bg-muted text-muted-foreground",
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
