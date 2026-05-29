import { NotebookPaletteToggle } from "@/components/notebook-palette-toggle";

const surfaces = [
  {
    label: "background",
    className: "bg-background text-foreground",
    value: "--background",
  },
  {
    label: "card",
    className: "bg-card text-card-foreground",
    value: "--card",
  },
  {
    label: "muted",
    className: "bg-muted text-muted-foreground",
    value: "--muted",
  },
  {
    label: "primary",
    className: "bg-primary text-primary-foreground",
    value: "--primary",
  },
];

const accents = [
  { label: "python", className: "bg-sky-500" },
  { label: "idle", className: "bg-green-500" },
  { label: "deno", className: "bg-emerald-500" },
  { label: "ai", className: "bg-purple-500" },
  { label: "error", className: "bg-red-500" },
];

export function ThemeSurfacesExample() {
  return (
    <div className="not-prose space-y-4 rounded-lg border border-fd-border bg-fd-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fd-foreground">Notebook palette</h2>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            Shared notebook tokens under the docs shell.
          </p>
        </div>
        <NotebookPaletteToggle />
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {surfaces.map((surface) => (
          <div
            key={surface.label}
            className={["min-h-24 rounded-lg border border-border p-3", surface.className].join(
              " ",
            )}
          >
            <div className="text-sm font-semibold">{surface.label}</div>
            <div className="mt-6 font-mono text-[11px] opacity-70">{surface.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-2 rounded-lg border border-border bg-background p-3 text-foreground">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">Notebook accents</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Tailwind palette variables stay theme-aware for notebook states.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {accents.map((accent) => (
              <span
                key={accent.label}
                title={accent.label}
                className={["size-3 rounded-full", accent.className].join(" ")}
              />
            ))}
          </div>
        </div>
        <div className="h-2 rounded-full bg-gradient-to-r from-sky-500 via-emerald-500 to-purple-500" />
      </div>
    </div>
  );
}
