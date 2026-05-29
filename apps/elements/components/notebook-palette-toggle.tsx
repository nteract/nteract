"use client";

import { useEffect, useState } from "react";
import { Palette } from "lucide-react";

type NotebookPalette = "classic" | "cream";

const storageKey = "notebook-color-theme";

const options: Array<{
  value: NotebookPalette;
  label: string;
  swatch: string;
}> = [
  {
    value: "classic",
    label: "Classic",
    swatch: "bg-white",
  },
  {
    value: "cream",
    label: "Cream",
    swatch: "bg-[#f5f2ec]",
  },
];

function isNotebookPalette(value: string | null): value is NotebookPalette {
  return value === "classic" || value === "cream";
}

function readStoredPalette(): NotebookPalette {
  try {
    const stored = localStorage.getItem(storageKey);
    return isNotebookPalette(stored) ? stored : "classic";
  } catch {
    return "classic";
  }
}

function applyPalette(value: NotebookPalette) {
  document.documentElement.setAttribute("data-color-theme", value);
}

export function NotebookPaletteToggle() {
  const [palette, setPalette] = useState<NotebookPalette>("classic");

  useEffect(() => {
    const stored = readStoredPalette();
    setPalette(stored);
    applyPalette(stored);
  }, []);

  const selectPalette = (value: NotebookPalette) => {
    setPalette(value);
    applyPalette(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // localStorage can be unavailable in private or locked-down contexts.
    }
  };

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-fd-border bg-fd-secondary/50 p-0.5 text-fd-muted-foreground"
      aria-label="Notebook palette"
    >
      <Palette className="ml-1 size-3.5" aria-hidden="true" />
      {options.map((option) => {
        const isActive = palette === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            title={`${option.label} notebook palette`}
            onClick={() => selectPalette(option.value)}
            className={[
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              isActive
                ? "bg-fd-background text-fd-foreground shadow-sm"
                : "hover:bg-fd-accent hover:text-fd-accent-foreground",
            ].join(" ")}
          >
            <span
              className={[
                "size-2.5 rounded-full border",
                option.swatch,
                option.value === "cream" ? "border-[#d8cec3]" : "border-fd-border",
              ].join(" ")}
              aria-hidden="true"
            />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
