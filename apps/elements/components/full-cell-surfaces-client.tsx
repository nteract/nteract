"use client";

import dynamic from "next/dynamic";

const FullCellSurfacesExample = dynamic(
  () => import("./full-cell-surfaces-example").then((mod) => mod.FullCellSurfacesExample),
  {
    ssr: false,
    loading: () => (
      <div className="not-prose rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground">
        Loading full cell fixtures...
      </div>
    ),
  },
);

export function FullCellSurfacesClient() {
  return <FullCellSurfacesExample />;
}
