"use client";

import { ChevronDown, Palette } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";

type NotebookPalette = "classic" | "cream";

const storageKey = "notebook-color-theme";
const paletteChangeEvent = "notebook-color-theme-change";

const options: Array<{
  value: NotebookPalette;
  label: string;
}> = [
  {
    value: "classic",
    label: "Classic",
  },
  {
    value: "cream",
    label: "Cream",
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

export function NotebookPaletteToggle({ className }: { className?: string }) {
  const selectId = useId();
  const [palette, setPalette] = useState<NotebookPalette>("classic");

  useEffect(() => {
    const stored = readStoredPalette();
    setPalette(stored);
    applyPalette(stored);

    const syncPalette = (value: string | null) => {
      if (!isNotebookPalette(value)) return;
      setPalette(value);
      applyPalette(value);
    };

    const handlePaletteChange = (event: Event) => {
      syncPalette((event as CustomEvent<string>).detail);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        syncPalette(event.newValue);
      }
    };

    window.addEventListener(paletteChangeEvent, handlePaletteChange);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(paletteChangeEvent, handlePaletteChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const selectPalette = (value: NotebookPalette) => {
    setPalette(value);
    applyPalette(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // localStorage can be unavailable in private or locked-down contexts.
    }
    window.dispatchEvent(new CustomEvent(paletteChangeEvent, { detail: value }));
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-fd-border bg-fd-secondary/50 px-2 py-1 text-fd-muted-foreground",
        className,
      )}
      aria-label="Notebook flavor"
    >
      <Palette className="size-4 flex-none" aria-hidden="true" />
      <label className="sr-only" htmlFor={selectId}>
        Notebook flavor
      </label>
      <div className="relative min-w-0 flex-1">
        <select
          id={selectId}
          value={palette}
          onChange={(event) => selectPalette(event.target.value as NotebookPalette)}
          className="h-8 w-full appearance-none rounded-md bg-fd-background py-0 pe-8 ps-3 text-sm font-medium text-fd-foreground shadow-sm outline-none transition-colors hover:bg-fd-accent focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
