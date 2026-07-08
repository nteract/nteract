import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const sizes = [
  { label: "Small", size: "sm" },
  { label: "Default", size: "default" },
  { label: "Large", size: "lg" },
] as const;

export function SpinnerExample() {
  return (
    <div className="not-prose space-y-6" data-testid="spinner-example">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Spinner primitive</h2>
            <p className="mt-1 text-xs leading-5">
              Colorless currentColor motion for compact status slots where a skeleton has no room.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {sizes.map((item) => (
          <div key={item.size} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="flex h-16 items-center justify-center text-fd-foreground">
              <Spinner size={item.size} label={`${item.label} loading`} />
            </div>
            <div className="border-t border-fd-border pt-3">
              <h3 className="text-sm font-semibold">{item.label}</h3>
              <p className="mt-1 text-xs text-fd-muted-foreground">size={item.size}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled>
            <Spinner size="default" label="Saving notebook" />
            Saving
          </Button>
          <p className="text-xs leading-5 text-fd-muted-foreground">
            Use this pattern for inline action progress. Use Skeleton when the pending content shape
            is known.
          </p>
        </div>
      </section>
    </div>
  );
}
