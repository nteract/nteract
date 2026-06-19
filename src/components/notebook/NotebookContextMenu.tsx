import { Fragment, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export type NotebookContextSurfaceKind =
  | "notebook"
  | "cell"
  | "source"
  | "markdown"
  | "output"
  | "package"
  | "selection";

export interface NotebookContextSurface {
  kind: NotebookContextSurfaceKind;
  title: string;
  description?: ReactNode;
  detail?: ReactNode;
}

export interface NotebookContextMenuAction {
  id: string;
  label: string;
  description?: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  separatorBefore?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onSelect?: () => void;
}

export interface NotebookContextMenuGroup {
  id: string;
  label?: string;
  actions: readonly NotebookContextMenuAction[];
}

export interface NotebookContextMenuProps {
  surface?: NotebookContextSurface;
  groups: readonly NotebookContextMenuGroup[];
  children: ReactNode;
  contentClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

export function NotebookContextMenu({
  surface,
  groups,
  children,
  contentClassName,
  onOpenChange,
}: NotebookContextMenuProps) {
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter(Boolean),
    }))
    .filter((group) => group.actions.length > 0);

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className={cn("w-72 p-1.5", contentClassName)}
        data-slot="notebook-context-menu"
        data-context-kind={surface?.kind}
      >
        {surface ? (
          <ContextMenuLabel className="px-2 py-2">
            <span className="block text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
              {surface.kind}
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-foreground">
              {surface.title}
            </span>
            {surface.description ? (
              <span className="mt-1 block whitespace-normal text-xs font-normal leading-5 text-muted-foreground">
                {surface.description}
              </span>
            ) : null}
            {surface.detail ? (
              <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                {surface.detail}
              </span>
            ) : null}
          </ContextMenuLabel>
        ) : null}

        {visibleGroups.map((group, index) => (
          <div key={group.id}>
            {index > 0 ? <ContextMenuSeparator /> : null}
            {group.label ? (
              <ContextMenuLabel className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground">
                {group.label}
              </ContextMenuLabel>
            ) : null}
            {group.actions.map((action) => (
              <Fragment key={action.id}>
                {action.separatorBefore ? <ContextMenuSeparator /> : null}
                <ContextMenuItem
                  disabled={action.disabled}
                  variant={action.destructive ? "destructive" : "default"}
                  className="items-start gap-2 py-2"
                  onSelect={() => action.onSelect?.()}
                >
                  {action.icon ? (
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{action.label}</span>
                    {action.description ? (
                      <span className="mt-0.5 block whitespace-normal text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                  {action.shortcut ? (
                    <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>
                  ) : null}
                </ContextMenuItem>
              </Fragment>
            ))}
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
