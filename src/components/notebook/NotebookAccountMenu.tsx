import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotebookActorAvatar } from "./NotebookIdentity";
import type { NotebookActorIdentity } from "./capabilities";

// The hover surface stays rounded-md (never a pill), but the focus ring hugs
// the circular avatar instead of this box — so it is drawn on the Avatar via
// `group-focus-visible:` rather than on the trigger.
export const NOTEBOOK_ACCOUNT_MENU_TRIGGER_CLASS =
  "group inline-flex h-8 shrink-0 items-center justify-center rounded-md px-0.5 text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none";

export interface NotebookAccountMenuProps {
  actor: NotebookActorIdentity;
  detail?: string;
  accountDetail?: string | null;
  showStatus?: boolean;
  statusClassName?: string;
  triggerExtra?: ReactNode;
  triggerClassName?: string;
  triggerProps?: ComponentProps<"button"> & Record<`data-${string}`, string | undefined>;
  align?: "start" | "center" | "end";
  children: ReactNode;
}

export function NotebookAccountMenu({
  actor,
  detail,
  accountDetail,
  showStatus = false,
  statusClassName,
  triggerExtra,
  triggerClassName,
  triggerProps,
  align = "end",
  children,
}: NotebookAccountMenuProps) {
  const triggerCopy = detail ?? actor.label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(NOTEBOOK_ACCOUNT_MENU_TRIGGER_CLASS, triggerClassName)}
        data-slot="notebook-account-menu-trigger"
        data-actor-kind={actor.kind}
        title={triggerCopy}
        {...triggerProps}
      >
        <span aria-hidden="true">
          <NotebookActorAvatar
            actor={actor}
            className="border-0 ring-ring ring-offset-1 ring-offset-background group-focus-visible:ring-2"
            size="default"
            showStatus={showStatus}
            statusClassName={statusClassName}
          />
        </span>
        <span className="sr-only">{triggerCopy}</span>
        {triggerExtra}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-56">
        <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{actor.label}</span>
          {accountDetail ? (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {accountDetail}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
