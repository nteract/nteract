import { ChevronLeft, ChevronRight, ListTree, Package, type LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { resolveNotebookOutlineSelection, type NotebookOutlineItem } from "runtimed";
import { cn } from "@/lib/utils";

export type NotebookRailPanelId = "outline" | "packages";

export interface NotebookRailProps {
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  outlineItems: readonly NotebookOutlineItem[];
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
  const summary =
    activePanelId === "outline"
      ? outlineItems.length === 1
        ? "1 item"
        : `${outlineItems.length} items`
      : packagesSummary;

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
              onActivePanelChange(item.id);
              onCollapsedChange(false);
            }}
          />
        ))}
      </div>

      {!collapsed && (
        <div
          className="flex min-h-0 w-80 max-w-[34vw] min-w-64 flex-col bg-background"
          data-slot="notebook-rail-panel"
        >
          <div className="border-b px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Notebook
                </p>
                <h2 className="mt-1 truncate text-sm font-semibold text-foreground">{title}</h2>
              </div>
              {summary && (
                <span className="shrink-0 rounded-full border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  {summary}
                </span>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {activePanelId === "outline" ? (
              <NotebookOutlinePanel
                items={outlineItems}
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
  selectedItemId?: string | null;
  selectedCellId?: string | null;
  onSelectItem?: (item: NotebookOutlineItem) => void;
  onNavigateItem?: (item: NotebookOutlineItem, href: string) => boolean | void;
  getItemHref?: (item: NotebookOutlineItem) => string | null | undefined;
}

export function NotebookOutlinePanel({
  items,
  selectedItemId = null,
  selectedCellId = null,
  onSelectItem,
  onNavigateItem,
  getItemHref,
}: NotebookOutlinePanelProps) {
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
  });

  return (
    <nav className="space-y-1" aria-label="Notebook outline" data-testid="notebook-outline-panel">
      {items.map((item) => {
        const selected = resolvedSelectedItemId === item.id;
        const itemHref = getItemHref?.(item) ?? item.href ?? null;
        const className = cn(
          "flex min-h-8 w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          selected
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        );
        const style = {
          paddingLeft: `${8 + Math.min(Math.max(item.level - 1, 0), 4) * 14}px`,
        };
        const content = (
          <>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.statusLabel ? (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                  selected ? "bg-primary-foreground/15" : "bg-muted text-muted-foreground",
                )}
              >
                {item.statusLabel}
              </span>
            ) : item.detail ? (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                  selected ? "bg-primary-foreground/15" : "bg-muted text-muted-foreground",
                )}
              >
                {item.detail}
              </span>
            ) : null}
          </>
        );

        if (itemHref) {
          const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
            onSelectItem?.(item);
            if (onNavigateItem?.(item, itemHref) === true) {
              event.preventDefault();
            }
          };

          return (
            <a
              key={item.id}
              href={itemHref}
              aria-current={selected ? "location" : undefined}
              onClick={handleClick}
              className={className}
              style={style}
            >
              {content}
            </a>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? "location" : undefined}
            onClick={() => onSelectItem?.(item)}
            className={className}
            style={style}
          >
            {content}
          </button>
        );
      })}
    </nav>
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
