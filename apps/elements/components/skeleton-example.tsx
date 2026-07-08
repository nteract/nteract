import { CircleDashed, FileCode2, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import { CellSkeleton } from "@/components/cell/CellSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

const textLines = ["w-full", "w-11/12", "w-3/4", "w-5/6"] as const;

export function SkeletonExample() {
  return (
    <div className="not-prose space-y-6" data-testid="skeleton-example">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <CircleDashed className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Skeleton primitive</h2>
            <p className="mt-1 text-xs leading-5">
              Deterministic loading geometry for surfaces that already know the shape of the content
              they are waiting on.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <SkeletonFixture title="Single bar">
          <Skeleton className="h-3 w-72 max-w-full" />
        </SkeletonFixture>

        <SkeletonFixture title="Text-line stack">
          <div className="space-y-2">
            {textLines.map((width, index) => (
              <Skeleton
                key={width}
                className={cnForLine(width)}
                style={{ animationDelay: `${index * 75}ms` }}
              />
            ))}
          </div>
        </SkeletonFixture>

        <SkeletonFixture title="Avatar row">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full" style={{ animationDelay: "75ms" }} />
            </div>
          </div>
        </SkeletonFixture>

        <SkeletonFixture title="Card block">
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-5/6" style={{ animationDelay: "75ms" }} />
              <Skeleton className="h-3 w-2/3" style={{ animationDelay: "150ms" }} />
            </div>
          </div>
        </SkeletonFixture>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="flex items-start justify-between gap-3 border-b border-fd-border p-4">
          <div className="flex min-w-0 items-center gap-2">
            <Rows3 className="size-4 flex-none text-fd-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">CellSkeleton composition</h2>
              <div className="mt-1 break-words font-mono text-[11px] leading-4 text-fd-muted-foreground [overflow-wrap:anywhere]">
                src/components/cell/CellSkeleton.tsx
              </div>
            </div>
          </div>
          <FileCode2 className="size-4 shrink-0 text-fd-muted-foreground" aria-hidden="true" />
        </div>
        <div className="bg-background p-4">
          <div className="rounded-lg border border-fd-border bg-fd-background">
            <CellSkeleton />
          </div>
        </div>
      </section>
    </div>
  );
}

function SkeletonFixture({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-fd-border bg-fd-card">
      <div className="border-b border-fd-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="bg-background p-4">{children}</div>
    </section>
  );
}

function cnForLine(width: (typeof textLines)[number]) {
  return `h-3 ${width}`;
}
