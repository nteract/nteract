import { cellContentColumnInset, notebookCellLayoutVars } from "@/components/cell/cell-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const skeletonCells = [
  { height: "2.5rem", delay: "0ms" },
  { height: "5rem", delay: "75ms" },
  { height: "2rem", delay: "150ms" },
];

function SkeletonCell({ height, delay }: { height: string; delay: string }) {
  return (
    <div className={cn("flex py-4", notebookCellLayoutVars)}>
      <div className="w-1 self-stretch rounded-sm bg-muted/40" />

      <div className={cn("min-w-0 flex-1 py-3 pr-3", cellContentColumnInset)}>
        <Skeleton style={{ minHeight: height, animationDelay: delay }} />
      </div>
    </div>
  );
}

export function CellSkeleton() {
  return (
    <div>
      {skeletonCells.map((cell, index) => (
        <SkeletonCell key={index} height={cell.height} delay={cell.delay} />
      ))}
    </div>
  );
}
