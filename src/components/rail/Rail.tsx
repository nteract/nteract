import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const RAIL_TAKEOVER_MEDIA_QUERY = "(max-width: 599.98px)";
export const RAIL_TAKEOVER_STAGE_CLASS_NAME = "max-[599.98px]:hidden";
export const RAIL_TAKEOVER_PANEL_CLASS_NAMES =
  "max-[599.98px]:w-[calc(100vw-3.5rem)] max-[599.98px]:min-w-0 max-[599.98px]:max-w-none";
const RAIL_HEADER_HEIGHT_CLASS_NAME = "h-[var(--nb-rail-header-height)]";

export interface RailItem<PanelId extends string = string> {
  id: PanelId;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

export type RailToolbarPlacement = "integrated" | "external";

export interface RailProps<PanelId extends string = string> {
  activePanelId: PanelId;
  collapsed: boolean;
  items: readonly RailItem<PanelId>[];
  toolbarPlacement?: RailToolbarPlacement;
  externalToolbarItemId?: PanelId;
  panelTitle: ReactNode;
  children: ReactNode;
  onActivePanelChange: (panelId: PanelId) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Rendered inline with the panel title, right-aligned. */
  panelAction?: ReactNode;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  panelClassName?: string;
  className?: string;
  dataTestId?: string;
  panelSlot?: string;
  panelTitleRowSlot?: string;
}

export function Rail<PanelId extends string = string>({
  activePanelId,
  collapsed,
  items,
  toolbarPlacement = "integrated",
  externalToolbarItemId,
  panelTitle,
  panelAction,
  leadingSlot,
  trailingSlot,
  panelClassName,
  children,
  onActivePanelChange,
  onCollapsedChange,
  className,
  dataTestId = "rail",
  panelSlot = "rail-panel",
  panelTitleRowSlot = "rail-panel-title-row",
}: RailProps<PanelId>) {
  const showPanelHeader = panelTitle != null || panelAction != null;
  const hasIntegratedToolbar = toolbarPlacement === "integrated";
  const cornerItem = hasIntegratedToolbar && !leadingSlot ? (items[0] ?? null) : null;
  const navigationItems = cornerItem ? items.slice(1) : items;
  const handleItemClick = (item: RailItem<PanelId>) => {
    if (item.disabled) return;
    if (!collapsed && activePanelId === item.id) {
      onCollapsedChange(true);
      return;
    }
    onActivePanelChange(item.id);
    onCollapsedChange(false);
  };

  return (
    <aside
      className={cn(
        "grid h-full min-h-0 shrink-0 grid-cols-[3.5rem_auto] bg-background",
        hasIntegratedToolbar ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]",
        className,
      )}
      data-testid={dataTestId}
      data-collapsed={collapsed ? "true" : "false"}
      data-toolbar-placement={toolbarPlacement}
    >
      {hasIntegratedToolbar ? (
        <div
          className={cn(
            "col-start-1 row-start-1 flex w-14 items-start justify-center bg-background pt-2",
            RAIL_HEADER_HEIGHT_CLASS_NAME,
          )}
          data-slot="rail-toolbar-corner"
        >
          {leadingSlot ??
            (cornerItem ? (
              <RailButton
                label={cornerItem.label}
                icon={cornerItem.icon}
                active={!collapsed && activePanelId === cornerItem.id}
                disabled={cornerItem.disabled}
                onClick={() => handleItemClick(cornerItem)}
              />
            ) : null)}
        </div>
      ) : null}

      <div
        className={cn(
          "col-start-1 flex min-h-0 w-14 flex-col items-center gap-1 border-r bg-background px-2 py-3",
          hasIntegratedToolbar ? "row-start-2" : "row-start-1",
        )}
        data-slot="rail-navigation"
      >
        {!hasIntegratedToolbar && leadingSlot ? (
          <div className="mb-4 flex flex-col items-center">{leadingSlot}</div>
        ) : null}
        {navigationItems.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={!collapsed && activePanelId === item.id}
            disabled={item.disabled}
            className={
              !hasIntegratedToolbar && item.id === externalToolbarItemId
                ? "hidden max-[599.98px]:flex"
                : undefined
            }
            onClick={() => handleItemClick(item)}
          />
        ))}
        {trailingSlot ? (
          <div className="mt-auto flex flex-col items-center pt-4">{trailingSlot}</div>
        ) : null}
      </div>

      {!collapsed && (
        <div
          className={cn(
            "col-start-2 row-start-1 grid min-h-0 max-w-[calc(100vw-3.5rem)] bg-background",
            hasIntegratedToolbar
              ? "row-span-2 grid-rows-[auto_minmax(0,1fr)]"
              : showPanelHeader
                ? "grid-rows-[auto_minmax(0,1fr)]"
                : "grid-rows-[minmax(0,1fr)]",
            !hasIntegratedToolbar && "border-r max-[599.98px]:border-r-0",
            panelClassName,
            RAIL_TAKEOVER_PANEL_CLASS_NAMES,
          )}
          data-slot={panelSlot}
        >
          {hasIntegratedToolbar || showPanelHeader ? (
            <div
              className={cn("flex items-end border-b px-4", RAIL_HEADER_HEIGHT_CLASS_NAME)}
              data-slot="rail-panel-header"
            >
              {showPanelHeader ? (
                <div className="flex h-10 w-full flex-col justify-center gap-1.5">
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                    data-slot={panelTitleRowSlot}
                  >
                    {panelTitle != null ? (
                      <h2 className="text-sm font-semibold text-foreground">{panelTitle}</h2>
                    ) : null}
                    {panelAction}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto p-3",
              hasIntegratedToolbar && "border-r max-[599.98px]:border-r-0",
            )}
            data-slot="rail-panel-content"
          >
            {children}
          </div>
        </div>
      )}
    </aside>
  );
}

export interface RailButtonProps {
  label: string;
  icon: LucideIcon;
  dataSlot?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function RailButton({
  label,
  icon: Icon,
  dataSlot,
  active = false,
  disabled = false,
  onClick,
  className,
}: RailButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-slot={dataSlot}
      className={cn(
        "flex size-9 items-center justify-center rounded-md text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "bg-foreground text-background"
          : "text-foreground/70 hover:bg-muted hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
