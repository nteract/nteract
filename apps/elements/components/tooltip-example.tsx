import { ChevronsRight, Code, Info, LetterText, RotateCcw, Square } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const commandControls = [
  { label: "Add code cell", icon: Code },
  { label: "Add markdown cell", icon: LetterText },
  { label: "Run all cells", icon: ChevronsRight },
  { label: "Restart kernel", icon: RotateCcw },
  { label: "Interrupt kernel", icon: Square },
] as const;

const iconButtonClass =
  "rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function TooltipExample() {
  return (
    <div className="not-prose space-y-6" data-testid="tooltip-example">
      <section className="border-l border-fd-border py-1 pl-4 text-fd-muted-foreground">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Tooltip primitive</h2>
            <p className="mt-1 text-xs leading-5">
              Short inverted hints for icon controls. They open on hover and on keyboard focus, and
              close on Escape.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-fd-border bg-background p-4">
        <h3 className="text-sm font-semibold">Command group</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          One provider per group. After the first hint opens, neighbors open without the delay.
        </p>
        <TooltipProvider>
          <div className="mt-3 flex items-center gap-1" data-testid="tooltip-example-group">
            {commandControls.map(({ label, icon: Icon }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <button type="button" aria-label={label} className={iconButtonClass}>
                    <Icon className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      </section>

      <section className="rounded-lg border border-fd-border bg-background p-4 pb-12">
        <h3 className="text-sm font-semibold">Pinned open</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Held open so the surface can be reviewed in both themes without hovering.
        </p>
        <TooltipProvider>
          <div className="mt-3">
            <Tooltip open>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Restart kernel and run all cells"
                  className={iconButtonClass}
                >
                  <span className="flex items-center">
                    <RotateCcw className="size-3.5" />
                    <ChevronsRight className="-ml-1 size-3.5" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                Restart kernel and run all cells
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </section>
    </div>
  );
}
