import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useRailPanelSlot } from "./rail-panel-slot";

export const RAIL_TAKEOVER_MEDIA_QUERY = "(max-width: 599.98px)";
export const RAIL_TAKEOVER_STAGE_CLASS_NAME = "max-[599.98px]:hidden";
// 3.5rem is the `w-14` icon strip below; takeover width must stay in lockstep.
export const RAIL_TAKEOVER_PANEL_CLASS_NAMES =
  "max-[599.98px]:w-[calc(100vw-3.5rem)] max-[599.98px]:min-w-0 max-[599.98px]:max-w-none";

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
  /** Omit when the active rail control already names the panel. */
  panelTitle?: string;
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
  const showPanelHeader = panelTitle != null || panelAction != null;
  const panel = collapsed ? null : (
    <div
      className={cn(
        "flex min-h-0 max-w-[calc(100vw-3.5rem)] flex-col border-r bg-muted/20",
        panelClassName,
        RAIL_TAKEOVER_PANEL_CLASS_NAMES,
      )}
      data-slot={panelSlot}
    >
      {showPanelHeader ? (
        <div className="border-b px-4 py-3" data-slot="rail-panel-header">
          <div className="flex flex-col gap-1.5">
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
        </div>
      ) : null}
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
      {/* Keep `w-14` paired with the 3.5rem takeover calculation above.
          The explicit rows mirror the shell's command row and body: the
          leading cell stays borderless, while the body cell owns the
          collapsed drawer boundary. */}
      <div
        className="grid min-h-0 w-14 shrink-0 grid-rows-[2.5rem_minmax(0,1fr)] bg-background"
        data-slot="rail-strip-grid"
      >
        <div className="flex min-h-0 items-center justify-center" data-slot="rail-leading-slot">
          {leadingSlot}
        </div>
        <div
          className={cn(
            "flex min-h-0 flex-col items-center gap-1 px-2 py-3",
            collapsed && "border-r",
          )}
          data-slot="rail-body"
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
