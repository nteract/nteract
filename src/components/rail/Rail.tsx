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

export interface RailProps<PanelId extends string = string> {
  activePanelId: PanelId;
  collapsed: boolean;
  items: readonly RailItem<PanelId>[];
  panelTitle: string;
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
  return (
    <aside
      className={cn(
        "grid min-h-0 shrink-0 grid-cols-[3.5rem_auto] grid-rows-[auto_minmax(0,1fr)] border-r bg-background",
        !collapsed && "max-[599.98px]:border-r-0",
        className,
      )}
      data-testid={dataTestId}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div
        className={cn(
          "col-start-1 row-start-1 flex w-14 items-start justify-center bg-background pt-2",
          RAIL_HEADER_HEIGHT_CLASS_NAME,
        )}
        data-slot="rail-toolbar-corner"
      >
        {leadingSlot}
      </div>

      <div
        className={cn(
          "col-start-1 row-start-2 flex min-h-0 w-14 flex-col items-center gap-1 bg-background px-2 py-3",
          !collapsed && "border-r",
        )}
        data-slot="rail-navigation"
      >
        {items.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={!collapsed && activePanelId === item.id}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              if (!collapsed && activePanelId === item.id) {
                onCollapsedChange(true);
                return;
              }
              onActivePanelChange(item.id);
              onCollapsedChange(false);
            }}
          />
        ))}
        {trailingSlot ? (
          <div className="mt-auto flex flex-col items-center pt-4">{trailingSlot}</div>
        ) : null}
      </div>

      {!collapsed && (
        <div
          className={cn(
            "col-start-2 row-span-2 row-start-1 grid min-h-0 max-w-[calc(100vw-3.5rem)] grid-rows-[auto_minmax(0,1fr)] bg-background",
            panelClassName,
            RAIL_TAKEOVER_PANEL_CLASS_NAMES,
          )}
          data-slot={panelSlot}
        >
          <div
            className={cn("flex items-end border-b px-4", RAIL_HEADER_HEIGHT_CLASS_NAME)}
            data-slot="rail-panel-header"
          >
            <div className="flex h-10 w-full flex-col justify-center gap-1.5">
              <div
                className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                data-slot={panelTitleRowSlot}
              >
                <h2 className="text-sm font-semibold text-foreground">{panelTitle}</h2>
                {panelAction}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
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
}

export function RailButton({
  label,
  icon: Icon,
  dataSlot,
  active = false,
  disabled = false,
  onClick,
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
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
