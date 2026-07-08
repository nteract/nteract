import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Ratified loading skeleton: shimmer, not pulse, theme-aware via color-mix,
 * and the shared convergence target for the cloud and Sift shimmers.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("nb-skeleton animate-skeleton-shimmer rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
