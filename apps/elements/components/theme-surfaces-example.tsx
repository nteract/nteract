"use client";

import { AnsiOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
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

const ansiSwatches = [
  { label: "black", fg: "ansi-black-fg", bg: "ansi-black-bg", code: "30" },
  { label: "red", fg: "ansi-red-fg", bg: "ansi-red-bg", code: "31" },
  { label: "green", fg: "ansi-green-fg", bg: "ansi-green-bg", code: "32" },
  { label: "yellow", fg: "ansi-yellow-fg", bg: "ansi-yellow-bg", code: "33" },
  { label: "blue", fg: "ansi-blue-fg", bg: "ansi-blue-bg", code: "34" },
  { label: "magenta", fg: "ansi-magenta-fg", bg: "ansi-magenta-bg", code: "35" },
  { label: "cyan", fg: "ansi-cyan-fg", bg: "ansi-cyan-bg", code: "36" },
  { label: "white", fg: "ansi-white-fg", bg: "ansi-white-bg", code: "37" },
];

const brightAnsiSwatches = [
  { label: "bright black", fg: "ansi-bright-black-fg", code: "90" },
  { label: "bright red", fg: "ansi-bright-red-fg", code: "91" },
  { label: "bright green", fg: "ansi-bright-green-fg", code: "92" },
  { label: "bright yellow", fg: "ansi-bright-yellow-fg", code: "93" },
  { label: "bright blue", fg: "ansi-bright-blue-fg", code: "94" },
  { label: "bright magenta", fg: "ansi-bright-magenta-fg", code: "95" },
  { label: "bright cyan", fg: "ansi-bright-cyan-fg", code: "96" },
  { label: "bright white", fg: "ansi-bright-white-fg", code: "97" },
];

const notebookOutputPreview = [
  "\u001b[33m0.79131883437586\u001b[0m",
  "\u001b[90m[\u001b[0m \u001b[33m1\u001b[0m, \u001b[33m2\u001b[0m, \u001b[33m3\u001b[0m \u001b[90m]\u001b[0m",
  '\u001b[32m"hey"\u001b[0m',
  "\u001b[31mNameError\u001b[0m: name 'wasdfasdf' is not defined",
].join("\n");

const terminalPreview = [
  "\u001b[32mtraining\u001b[0m fold=01 mae=\u001b[33m8.91\u001b[0m",
  "\u001b[33mvalidating\u001b[0m fold=02 mae=\u001b[33m8.42\u001b[0m",
  "\u001b[34mexported\u001b[0m forecast.parquet",
].join("\n");

export function ThemeSurfacesExample() {
  return (
    <div className="not-prose space-y-5 rounded-lg border border-fd-border bg-fd-card p-4">
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

      <div className="space-y-4 border-t border-border pt-4 text-foreground">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">ANSI output palette</h3>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              Output renderers use the shared ANSI variables for classic, cream, light, and dark.
            </div>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">src/styles/ansi.css</div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 rounded-lg border border-border bg-background p-4">
            <div className="mb-3 text-xs font-semibold text-muted-foreground">
              Notebook output values
            </div>
            <AnsiOutput className="text-[13px] leading-7">{notebookOutputPreview}</AnsiOutput>
          </div>

          <div className="min-w-0 rounded-lg border border-border bg-background p-4">
            <div className="mb-3 text-xs font-semibold text-muted-foreground">Stream output</div>
            <AnsiStreamOutput className="py-0" streamName="stdout" text={terminalPreview} />
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 text-xs font-semibold text-muted-foreground">Standard colors</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {ansiSwatches.map((swatch) => (
                <div
                  key={swatch.label}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                >
                  <span className={["size-3 rounded-sm", swatch.bg].join(" ")} />
                  <span className={["truncate text-sm font-medium", swatch.fg].join(" ")}>
                    {swatch.label}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">{swatch.code}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 text-xs font-semibold text-muted-foreground">Bright colors</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {brightAnsiSwatches.map((swatch) => (
                <div
                  key={swatch.label}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                >
                  <span className={["truncate text-sm font-medium", swatch.fg].join(" ")}>
                    {swatch.label}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">{swatch.code}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
