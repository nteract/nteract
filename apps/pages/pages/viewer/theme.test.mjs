import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { applyTheme, createThemeStore, MODE_KEY, readThemePreferences } from "./theme.mjs";

function environment({ mode, dark = false, blocked = false } = {}) {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://pages.test",
  });
  const media = new window.EventTarget();
  media.matches = dark;
  window.matchMedia = () => media;
  if (mode) window.localStorage.setItem(MODE_KEY, mode);
  if (blocked)
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  return { window, media, root: window.document.documentElement };
}

test("first paint applies explicit mode regardless of system preference", () => {
  const { window, root } = environment({ mode: "light", dark: true });
  applyTheme(readThemePreferences(window), window);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.ok(root.classList.contains("light"));
  assert.ok(!root.classList.contains("dark"));
  window.close();
});

test("system mode follows OS changes; explicit mode does not; returning to system resolves immediately", () => {
  const { window, media, root } = environment();
  const store = createThemeStore(window);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  media.matches = true;
  media.dispatchEvent(new window.Event("change"));
  assert.deepEqual(store.getSnapshot(), { mode: "system", resolved: "dark" });
  store.setMode("light");
  media.dispatchEvent(new window.Event("change"));
  assert.equal(root.dataset.theme, "light");
  assert.equal(changes, 2);
  store.setMode("system");
  assert.equal(root.dataset.theme, "dark");
  unsubscribe();
  media.matches = false;
  media.dispatchEvent(new window.Event("change"));
  assert.equal(changes, 3, "unmounted subscribers detach browser listeners");
  window.close();
});

test("preferences propagate between tabs and cleared/invalid storage returns to defaults", () => {
  const { window, root } = environment({ mode: "dark" });
  const store = createThemeStore(window);
  const unsubscribe = store.subscribe(() => {});
  window.localStorage.setItem(MODE_KEY, "light");
  window.dispatchEvent(new window.StorageEvent("storage", { key: MODE_KEY }));
  assert.equal(root.dataset.theme, "light");
  store.setMode("invalid");
  assert.equal(store.getSnapshot().mode, "light");
  window.localStorage.setItem(MODE_KEY, "invalid");
  window.dispatchEvent(new window.StorageEvent("storage", { key: MODE_KEY }));
  assert.equal(store.getSnapshot().mode, "system");
  window.localStorage.clear();
  window.dispatchEvent(new window.StorageEvent("storage", { key: null }));
  assert.deepEqual(store.getSnapshot(), { mode: "system", resolved: "light" });
  unsubscribe();
  window.close();
});

test("blocked local storage still allows an in-memory mode, including subsequent OS changes", () => {
  const { window, media, root } = environment({ blocked: true });
  const store = createThemeStore(window);
  const unsubscribe = store.subscribe(() => {});
  store.setMode("dark");
  media.dispatchEvent(new window.Event("change"));
  assert.equal(root.dataset.theme, "dark");
  store.setMode("system");
  assert.equal(root.dataset.theme, "light");
  unsubscribe();
  window.close();
});

// Custom properties declared in top-level rules (not inside @media or other
// at-rules) whose selector list includes one of `selectors`, in source order,
// so a later rule overrides an earlier one as the cascade does at equal
// specificity.
function declarations(css, selectors) {
  const values = new Map();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0,
    start = 0,
    selector = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{") {
      if (depth === 0) {
        selector = source.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth > 0) continue;
      const list = selector.split(",").map((part) => part.trim());
      if (!selector.startsWith("@") && list.some((part) => selectors.includes(part)))
        for (const [, name, value] of source.slice(start, i).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
          values.set(name, value.trim());
      start = i + 1;
    }
  }
  return values;
}
function resolve(theme, name, depth = 0) {
  const value = theme.get(name);
  assert.ok(value, `${name} is declared`);
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  return alias && depth < 8 ? resolve(theme, alias[1], depth + 1) : value;
}
// WCAG relative luminance for a hex color or an achromatic oklch color, whose
// luminance is L^3. Anything else fails, so a token change re-checks this test.
function luminance(color) {
  const neutral = color.match(/^oklch\(([\d.]+) 0 0\)$/);
  if (neutral) return Number(neutral[1]) ** 3;
  assert.match(color, /^#[0-9a-f]{6}$/i, `${color} is hex or neutral oklch`);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test("own text selection resolves to a readable token pair in each theme", async () => {
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  const tokens = await readFile(
    new URL("../../../../../../src/styles/notebook-tokens.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /(^|\n)::selection \{\s*color: var\(--selection-foreground\);\s*background: var\(--selection\);/,
  );
  // Light: :root everywhere. Dark: light, then the dark rules on top. The
  // shared tokens file is read first; the viewer's style.css loads after it.
  const light = new Map([...declarations(tokens, [":root"]), ...declarations(css, [":root"])]);
  const dark = new Map([
    ...light,
    ...declarations(tokens, [".dark", ":root.dark"]),
    ...declarations(css, [".dark", ":root.dark"]),
  ]);
  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const ratio = contrast(
      luminance(resolve(theme, "--selection")),
      luminance(resolve(theme, "--selection-foreground")),
    );
    assert.ok(ratio >= 4.5, `${name} selection contrast ${ratio.toFixed(2)} >= 4.5`);
  }
});

test("Wordgard cell and node selections keep the text's own color", async () => {
  const css = (await readFile(new URL("./style.css", import.meta.url), "utf8")).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = css.match(/([^{}]+)\{\s*color: currentColor;\s*\}/);
  assert.ok(rule, "a currentColor ::selection rule");
  const selectors = rule[1].split(",").map((part) => part.trim());
  for (const context of [".wg-selected-cell", ".wg-selected-node"])
    for (const selector of [`${context}::selection`, `${context} ::selection`])
      assert.ok(selectors.includes(selector), selector);
  assert.match(
    css,
    /\.wg-selected-cell :focus::selection,\s*\.wg-selected-cell :focus ::selection \{\s*color: HighlightText;/,
  );
});

test("the iOS caret fallback is gated to iOS and leaves collaborator carets alone", async () => {
  const css = (await readFile(new URL("./style.css", import.meta.url), "utf8")).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const block = css.match(/@supports \(-webkit-touch-callout: none\) \{([\s\S]*?\})\s*\}/)?.[1];
  assert.ok(block, "an @supports (-webkit-touch-callout: none) block");
  assert.match(
    block,
    /\.wordgard-document > wg-scroller > wg-content \{\s*caret-color: var\(--foreground\);/,
  );
  assert.match(block, /wg-cursor-layer > \.wg-cursor-v \{\s*visibility: hidden;/);
  assert.doesNotMatch(block, /wordgard-caret-layer|wg-cursor-h/);
  assert.doesNotMatch(css.replace(block, ""), /caret-color/);
});
