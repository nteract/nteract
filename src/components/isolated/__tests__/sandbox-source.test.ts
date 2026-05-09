import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SOURCE_ROOT = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "renderer-plugins") {
        return [];
      }
      return sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe("iframe sandbox source restrictions", () => {
  it("does not add allow-same-origin to sandbox code paths", () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return source
        .split("\n")
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .filter(({ line }) =>
          /sandbox\s*=|sandbox\s*:|SANDBOX_ATTRS|["']allow-same-origin["']/.test(line),
        )
        .filter(({ line }) => line.includes("allow-same-origin"))
        .map(({ index }) => `${relative(process.cwd(), path)}:${index}`);
    });

    expect(offenders).toEqual([]);
  });
});
