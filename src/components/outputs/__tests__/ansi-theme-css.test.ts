import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const ansiCss = readFileSync(join(process.cwd(), "src/styles/ansi.css"), "utf8");
const rootCss = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

const ANSI_FOREGROUND_VARIABLES = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
];

function getCssBlock(selector: string): string {
  const blockStart = ansiCss.indexOf(`${selector} {`);
  expect(blockStart).toBeGreaterThanOrEqual(0);

  const bodyStart = ansiCss.indexOf("{", blockStart) + 1;
  let depth = 1;
  for (let index = bodyStart; index < ansiCss.length; index++) {
    if (ansiCss[index] === "{") depth++;
    if (ansiCss[index] === "}") depth--;
    if (depth === 0) return ansiCss.slice(bodyStart, index);
  }

  throw new Error(`Could not find CSS block for ${selector}`);
}

function getAnsiForegroundVars(selector: string): Map<string, string> {
  const block = getCssBlock(selector);
  const vars = new Map<string, string>();

  for (const match of block.matchAll(/(--ansi-[\w-]+):\s*(#[0-9a-f]{6});/gi)) {
    const [, name, value] = match;
    if (!name.endsWith("-bg")) {
      vars.set(name, value);
    }
  }

  return vars;
}

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );

  return (lighter + 0.05) / (darker + 0.05);
}

describe("ANSI theme CSS", () => {
  it("defines classic and cream palettes for light and dark notebooks", () => {
    for (const selector of [
      ":root",
      ".dark",
      '[data-color-theme="cream"]',
      '[data-color-theme="cream"].dark',
    ]) {
      const vars = getAnsiForegroundVars(selector);
      expect([...vars.keys()].sort()).toEqual([...ANSI_FOREGROUND_VARIABLES].sort());
    }
  });

  it("keeps ANSI foreground colors readable on each notebook surface", () => {
    const palettes = [
      { selector: ":root", background: "#ffffff" },
      { selector: ".dark", background: "#0d1117" },
      { selector: '[data-color-theme="cream"]', background: "#f5f2ec" },
      { selector: '[data-color-theme="cream"].dark', background: "#1a1816" },
    ];

    for (const { selector, background } of palettes) {
      for (const [name, foreground] of getAnsiForegroundVars(selector)) {
        expect(contrastRatio(foreground, background), `${selector} ${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it("keeps the root stylesheet from shadowing the shared ANSI palette", () => {
    expect(rootCss).toContain('@import "./styles/ansi.css";');
    expect(rootCss).not.toMatch(/--ansi-yellow:/);
    expect(rootCss).not.toMatch(/\.ansi-red-fg/);
  });
});
