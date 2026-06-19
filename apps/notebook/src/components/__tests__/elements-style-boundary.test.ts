import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const elementsComponentsDir = join(process.cwd(), "apps/elements/components");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

function matchingLines(pattern: RegExp): string[] {
  const matches: string[] = [];

  for (const filePath of sourceFiles(elementsComponentsDir)) {
    const relativePath = filePath.slice(`${process.cwd()}/`.length);
    const lines = readFileSync(filePath, "utf8").split("\n");

    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        matches.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  return matches;
}

describe("Elements visual style boundary", () => {
  it("does not use rounded pill labels for fixture metadata", () => {
    expect(matchingLines(/rounded-full[^\n]*(?:border|px-2|py-1|py-0\.5|text-\[11px\])/)).toEqual(
      [],
    );
  });

  it("does not use colored rounded callout boxes in fixture pages", () => {
    expect(
      matchingLines(
        /rounded-(?:lg|md)[^\n]*border-(?:emerald|sky|amber)-500\/(?:25|30)[^\n]*bg-(?:emerald|sky|amber)-500\/10/,
      ),
    ).toEqual([]);
  });

  it("keeps catalog-only labels out of production cell gutters", () => {
    expect(matchingLines(/rightGutterContent=\{\s*<span/)).toEqual([]);
  });
});
