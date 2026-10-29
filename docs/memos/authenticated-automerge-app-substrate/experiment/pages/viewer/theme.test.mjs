import assert from "node:assert/strict";
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
