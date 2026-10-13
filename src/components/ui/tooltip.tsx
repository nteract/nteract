import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Tooltip timing for one group of triggers. Mount a provider around each
 * group (a toolbar, a rail) so moving between neighbors skips the open
 * delay. A `Tooltip` outside every provider throws.
 */
function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Inverted label surface: foreground fill with background text, so a short
 * hint reads apart from popover and hover-card panels.
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs leading-snug text-balance text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 origin-(--radix-tooltip-content-transform-origin)",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
