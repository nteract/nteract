// Convention 3: chroma carries meaning. This ratchets raw Tailwind palette
// classes in src/components/** per the fix train in
// .context/elements-audit-2026-07-07.md.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const componentsDir = join(process.cwd(), "src/components");

const RAW_TAILWIND_PALETTE_CLASS =
  /(?:^|[\s"'`:[])(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

// SANCTIONED: raw palette that is permanently allowed by an external contract.
const SANCTIONED_RAW_PALETTE_FILES = ["src/components/outputs/ansi-output.tsx"];

// RATCHET: current raw-palette debt. Remove entries as slices 3-4 tokenize them.
const RATCHET_RAW_PALETTE_FILES = [
  "src/components/cell/CellInsertionRibbon.tsx",
  "src/components/cell/CodeCellCurrentLine.tsx",
  "src/components/cell/CompactExecutionButton.tsx",
  "src/components/cell/gutter-colors.ts",
  "src/components/environment/CondaDependencyPanel.tsx",
  "src/components/environment/DenoDependencyPanel.tsx",
  "src/components/environment/PackageSpecList.tsx",
  "src/components/environment/PixiDependencyPanel.tsx",
  "src/components/environment/UvDependencyPanel.tsx",
  "src/components/isolated/IsolationTest.tsx",
  "src/components/markdown/markdown-typography.ts",
  "src/components/notebook/DebugBanner.tsx",
  "src/components/notebook/EnvBuildDecisionDialog.tsx",
  "src/components/notebook/KernelLaunchErrorBanner.tsx",
  "src/components/notebook/NotebookCommandToolbar.tsx",
  "src/components/notebook/NotebookConnectionIdentity.tsx",
  "src/components/notebook/NotebookEditModeButton.tsx",
  "src/components/notebook/NotebookIdentity.tsx",
  "src/components/notebook/NotebookNotice.tsx",
  "src/components/notebook/NotebookWorkstationsPanel.tsx",
  "src/components/notebook/PoolErrorBanner.tsx",
  "src/components/notebook/TrustDialog.tsx",
  "src/components/outputs/json-output.tsx",
  "src/components/outputs/media-router.tsx",
  "src/components/outputs/traceback-output.tsx",
  "src/components/widgets/controls/box-widget.tsx",
  "src/components/widgets/controls/button-style-utils.ts",
  "src/components/widgets/controls/controller-widget.tsx",
  "src/components/widgets/controls/float-progress.tsx",
  "src/components/widgets/controls/gridbox-widget.tsx",
  "src/components/widgets/controls/hbox-widget.tsx",
  "src/components/widgets/controls/int-progress.tsx",
  "src/components/widgets/controls/valid-widget.tsx",
  "src/components/widgets/controls/vbox-widget.tsx",
  "src/components/workstations/WorkstationsManagementPage.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : sourceFiles(fullPath);
      }

      if (!/\.(ts|tsx)$/.test(entry.name)) return [];
      if (/\.test\./.test(entry.name)) return [];

      return [fullPath];
    })
    .sort();
}

function rawPaletteMatches(): Map<string, string[]> {
  const matches = new Map<string, string[]>();

  for (const filePath of sourceFiles(componentsDir)) {
    const relativePath = filePath.slice(`${process.cwd()}/`.length);
    const lines = readFileSync(filePath, "utf8").split("\n");

    lines.forEach((line, index) => {
      if (RAW_TAILWIND_PALETTE_CLASS.test(line)) {
        const fileMatches = matches.get(relativePath) ?? [];
        fileMatches.push(`${index + 1}: ${line.trim()}`);
        matches.set(relativePath, fileMatches);
      }
    });
  }

  return matches;
}

function duplicateEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  entries.forEach((entry) => {
    if (seen.has(entry)) duplicates.add(entry);
    seen.add(entry);
  });

  return [...duplicates].sort();
}

describe("component chroma boundary", () => {
  it("keeps raw Tailwind palette classes inside sanctioned files and ratchet debt", () => {
    const matchesByFile = rawPaletteMatches();
    const matchedFiles = [...matchesByFile.keys()].sort();
    const ratchetFiles = new Set(RATCHET_RAW_PALETTE_FILES);
    const allowedFiles = new Set([...SANCTIONED_RAW_PALETTE_FILES, ...RATCHET_RAW_PALETTE_FILES]);

    expect(
      duplicateEntries([...SANCTIONED_RAW_PALETTE_FILES, ...RATCHET_RAW_PALETTE_FILES]),
    ).toEqual([]);
    expect(SANCTIONED_RAW_PALETTE_FILES.filter((filePath) => ratchetFiles.has(filePath))).toEqual(
      [],
    );

    expect(
      matchedFiles.flatMap((filePath) => {
        if (allowedFiles.has(filePath)) return [];
        return (matchesByFile.get(filePath) ?? []).map((line) => `${filePath}:${line}`);
      }),
    ).toEqual([]);

    expect(RATCHET_RAW_PALETTE_FILES.filter((filePath) => !matchesByFile.has(filePath))).toEqual(
      [],
    );
    expect([...allowedFiles].filter((filePath) => !matchesByFile.has(filePath)).sort()).toEqual([]);
  });
});
