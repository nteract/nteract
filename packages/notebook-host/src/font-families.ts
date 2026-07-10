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
    // The system font list contains a lot of noise. We reduce it three primary ways,
    // and may add more filters here as new noise sources are identified:
    //
    // - Dot-prefix fonts: skip names starting with "." (e.g. ".SF NS Text"),
    //   which are private macOS system internals not meant for user selection.
    //
    // - Non-Latin names: skip names containing characters outside U+0020–U+024F
    //   (ASCII plus diacritic Latin like "Naïve"). Fonts named in Arabic, Thai,
    //   CJK, Indic, etc. are hard for most users to identify in a picker UI.
    //
    // - Noto script-variant fonts: skip "Noto Sans <Script>", "Noto Serif <Script>",
    //   and "Noto Mono <Script>" (e.g. "Noto Sans Arabic"). These are Google's
    //   per-script coverage fonts and flood the list with dozens of near-identical
    //   entries. The base "Noto Sans", "Noto Serif", and "Noto Mono" are kept.
    if (!trimmed) continue;
    if (trimmed.startsWith(".")) continue;
    if (/[^\u0020-\u024F]/.test(trimmed)) continue;
    if (/^Noto (?:Sans|Serif|Mono) \S/.test(trimmed)) continue;
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
