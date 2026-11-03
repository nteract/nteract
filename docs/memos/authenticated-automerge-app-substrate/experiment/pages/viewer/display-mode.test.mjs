import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DISPLAY,
  DISPLAY_KEY,
  DISPLAY_MODES,
  readDisplayMode,
  writeDisplayMode,
} from "./display-mode.mjs";

function memoryBrowser(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => void values.set(key, String(value)),
    },
  };
}
const blockedBrowser = () => ({
  get localStorage() {
    throw new Error("blocked");
  },
});

test("the key, modes and default are the stored contract", () => {
  assert.equal(DISPLAY_KEY, "nteract.pages.view");
  assert.deepEqual(DISPLAY_MODES, ["list", "grid"]);
  assert.equal(DEFAULT_DISPLAY, "list");
});

test("a stored mode reads back; anything else is the list", () => {
  assert.equal(readDisplayMode(memoryBrowser({ [DISPLAY_KEY]: "grid" })), "grid");
  assert.equal(readDisplayMode(memoryBrowser({ [DISPLAY_KEY]: "list" })), "list");
  assert.equal(readDisplayMode(memoryBrowser()), "list");
  assert.equal(readDisplayMode(memoryBrowser({ [DISPLAY_KEY]: "table" })), "list");
  assert.equal(readDisplayMode(memoryBrowser({ [DISPLAY_KEY]: "GRID" })), "list");
  assert.equal(readDisplayMode(undefined), "list");
  assert.equal(readDisplayMode({}), "list");
  assert.equal(readDisplayMode(blockedBrowser()), "list");
});

test("writing stores a valid mode and refuses others", () => {
  const browser = memoryBrowser();
  assert.equal(writeDisplayMode(browser, "grid"), "grid");
  assert.equal(browser.values.get(DISPLAY_KEY), "grid");
  assert.equal(readDisplayMode(browser), "grid");
  assert.equal(writeDisplayMode(browser, "cards"), null);
  assert.equal(browser.values.get(DISPLAY_KEY), "grid", "an unknown mode writes nothing");
});

test("blocked storage still switches for this visit", () => {
  assert.equal(writeDisplayMode(blockedBrowser(), "grid"), "grid");
  const throwing = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    },
  };
  assert.equal(writeDisplayMode(throwing, "list"), "list");
  assert.equal(writeDisplayMode(undefined, "grid"), "grid");
});
