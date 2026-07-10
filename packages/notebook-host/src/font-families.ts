export const DEFAULT_FONT_FAMILIES = [
  "Arial",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Inter",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
] as const;

const GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fantasy",
  "fangsong",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

export function uniqueSortedFontFamilies(fontFamilies: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const fontFamily of fontFamilies) {
    const trimmed = fontFamily.trim();
    if (!trimmed || trimmed.startsWith(".") || /[^\x00-\x7F]/.test(trimmed)) continue;
    const key = trimmed.toLocaleLowerCase();
    if (!byKey.has(key)) byKey.set(key, trimmed);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export function stripCssFamilyQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed;
  return trimmed
    .slice(1, -1)
    .replace(/\\(["'\\])/g, "$1")
    .trim();
}

export function singleFontFamilyFromCssValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(",")) return null;
  return stripCssFamilyQuotes(trimmed);
}

export function fontFamilyNameToCssValue(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return "";
  if (GENERIC_FONT_FAMILIES.has(trimmed.toLocaleLowerCase())) return trimmed;
  if (/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/["\\]/g, "\\$&")}"`;
}
