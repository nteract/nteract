import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useRailPanelSlot } from "./rail-panel-slot";

export const RAIL_TAKEOVER_MEDIA_QUERY = "(max-width: 599.98px)";
export const RAIL_TAKEOVER_STAGE_CLASS_NAME = "max-[599.98px]:hidden";
export const RAIL_TAKEOVER_PANEL_CLASS_NAMES =
  "max-[599.98px]:w-[calc(100vw-3rem)] max-[599.98px]:min-w-0 max-[599.98px]:max-w-none";

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
  const panelSlotNode = useRailPanelSlot();
  const panel = collapsed ? null : (
    <div
      className={cn(
        "flex min-h-0 max-w-[calc(100vw-3rem)] flex-col border-r bg-background",
        panelClassName,
        RAIL_TAKEOVER_PANEL_CLASS_NAMES,
      )}
      data-slot={panelSlot}
    >
      <div className="border-b px-4 py-3">
        <div className="flex flex-col gap-1.5">
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
  );

  const strip = (
    <aside
      className={cn("flex min-h-0 shrink-0 bg-background", className)}
      data-testid={dataTestId}
      data-collapsed={collapsed ? "true" : "false"}
      data-panel-hosted={panelSlotNode ? "true" : "false"}
    >
      <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-background px-2 py-3">
        {leadingSlot ? <div className="mb-4 flex flex-col items-center">{leadingSlot}</div> : null}
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

      {panelSlotNode ? null : panel}
    </aside>
  );

  return panelSlotNode && panel ? (
    <>
      {strip}
      {createPortal(panel, panelSlotNode)}
    </>
  ) : (
    strip
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
        "flex size-9 items-center justify-center rounded-xl text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
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
