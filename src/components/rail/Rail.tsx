import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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
  panelEyebrow?: string;
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
  panelEyebrow,
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
      className={cn("flex min-h-0 shrink-0 border-r bg-background", className)}
      data-testid={dataTestId}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-muted/40 px-2 py-3">
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
      </div>

      {!collapsed && (
        <div
          className={cn(
            "flex min-h-0 max-w-[calc(100vw-3rem)] flex-col bg-background",
            panelClassName,
            RAIL_TAKEOVER_PANEL_CLASS_NAMES,
          )}
          data-slot={panelSlot}
        >
          <div className="border-b px-4 py-3">
            <div className="flex flex-col gap-1.5">
              {panelEyebrow && (
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {panelEyebrow}
                  </p>
                </div>
              )}
              <div
                className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                data-slot={panelTitleRowSlot}
              >
                <h2 className="text-sm font-semibold text-foreground">{panelTitle}</h2>
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
