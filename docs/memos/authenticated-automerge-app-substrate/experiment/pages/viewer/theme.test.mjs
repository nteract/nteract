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

// WCAG relative luminance. Hex for the selection tokens; the neutral
// foreground tokens are achromatic oklch, whose luminance is L^3.
function luminanceOfHex(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test("own text selection is an explicit token pair readable in both themes", async () => {
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  const tokens = await readFile(
    new URL("../../../../../../src/styles/notebook-tokens.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /(^|\n)::selection \{\s*color: var\(--selection-foreground\);\s*background: var\(--selection\);/,
  );
  const light = css.match(/:root \{[^}]*--selection: (#[0-9a-f]{6});/)?.[1];
  const dark = css.match(/:root\.dark \{[^}]*--selection: (#[0-9a-f]{6});/)?.[1];
  assert.ok(light && dark, "light and dark --selection tokens");
  assert.match(css, /--selection-foreground: var\(--foreground\);/);
  const foreground = [...tokens.matchAll(/--foreground: oklch\(([\d.]+) 0 0\);/g)].map(
    (match) => Number(match[1]) ** 3,
  );
  assert.equal(foreground.length, 2, "light and dark --foreground");
  assert.ok(contrast(luminanceOfHex(light), foreground[0]) >= 4.5);
  assert.ok(contrast(luminanceOfHex(dark), foreground[1]) >= 4.5);
});
