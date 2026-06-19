import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const isolatedBarrelImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@\/components\/isolated["']/g;
const namedExport = /export\s+(?:type\s+)?\{([^}]*)\}/g;
const declarationExport =
  /export\s+(?:interface|class|function|const|let|var|type|enum)\s+([A-Za-z_$][\w$]*)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

function importedName(specifier: string): string | null {
  const name = specifier
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim()
    .replace(/^type\s+/, "")
    .split(/\s+as\s+/)[0]
    .trim();
  return name || null;
}

function namedSpecifiers(block: string): string[] {
  return block.split(",").map(importedName).filter(Boolean) as string[];
}

function collectIsolatedBarrelImports(files: string[]): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();

  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    const relativePath = relative(process.cwd(), filePath);

    for (const match of source.matchAll(isolatedBarrelImport)) {
      for (const name of namedSpecifiers(match[1] ?? "")) {
        const users = imports.get(name) ?? new Set<string>();
        users.add(relativePath);
        imports.set(name, users);
      }
    }
  }

  return imports;
}

function collectShimExports(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  const exports = new Set<string>();

  for (const match of source.matchAll(namedExport)) {
    for (const name of namedSpecifiers(match[1] ?? "")) {
      exports.add(name);
    }
  }

  for (const match of source.matchAll(declarationExport)) {
    if (match[1]) exports.add(match[1]);
  }

  return exports;
}

describe("Elements isolated shim boundary", () => {
  it("exports every isolated barrel name imported by shared consumers", () => {
    const roots = ["src/components", "apps/elements/components"];
    const consumerFiles = roots.flatMap((root) => sourceFiles(join(process.cwd(), root)));
    const imports = collectIsolatedBarrelImports(consumerFiles);
    const shimExports = collectShimExports(
      join(process.cwd(), "apps/elements/components/isolated/index.tsx"),
    );

    const missing = [...imports.entries()]
      .filter(([name]) => !shimExports.has(name))
      .map(([name, users]) => `${name} imported by ${[...users].sort().join(", ")}`)
      .sort();

    expect(missing).toEqual([]);
  });
});
