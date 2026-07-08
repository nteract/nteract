import { FileText, GitBranch, Rows3 } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const notebookSections = [
  { label: "Input", value: "8 cells" },
  { label: "Output", value: "12 frames" },
  { label: "Comments", value: "3 open" },
] as const;

export function SeparatorExample() {
  return (
    <div className="not-prose space-y-6" data-testid="separator-example">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <Rows3 className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Separator primitive</h2>
            <p className="mt-1 text-xs leading-5">
              Token-native rules for dividing nearby notebook content without inventing local border
              colors.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card">
        <div className="flex items-start gap-3 p-4">
          <FileText
            className="mt-0.5 size-4 flex-none text-fd-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Notebook summary</h3>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              Horizontal separators split stacked regions while staying on the shared border token.
            </p>
          </div>
        </div>
        <Separator />
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          {notebookSections.map((section) => (
            <div key={section.label}>
              <div className="text-xs font-medium uppercase tracking-normal text-fd-muted-foreground">
                {section.label}
              </div>
              <div className="mt-1 text-sm font-semibold">{section.value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-fd-card p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <GitBranch className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            main
          </span>
          <div className="h-5">
            <Separator orientation="vertical" />
          </div>
          <span className="text-fd-muted-foreground">runtime attached</span>
          <div className="h-5">
            <Separator orientation="vertical" />
          </div>
          <span className="text-fd-muted-foreground">autosaved just now</span>
        </div>
      </section>
    </div>
  );
}
