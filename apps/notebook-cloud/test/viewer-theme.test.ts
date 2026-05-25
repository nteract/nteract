import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_THEME_STORAGE_KEY,
  isCloudThemeMode,
  resolveCloudThemeMode,
  storedCloudThemeMode,
} from "../viewer/theme.ts";

describe("cloud viewer theme state", () => {
  it("accepts the shared light/dark/system theme modes", () => {
    assert.equal(isCloudThemeMode("light"), true);
    assert.equal(isCloudThemeMode("dark"), true);
    assert.equal(isCloudThemeMode("system"), true);
    assert.equal(isCloudThemeMode("cream"), false);
    assert.equal(isCloudThemeMode(null), false);
  });

  it("resolves system theme from the caller-provided media state", () => {
    assert.equal(resolveCloudThemeMode("light", true), "light");
    assert.equal(resolveCloudThemeMode("dark", false), "dark");
    assert.equal(resolveCloudThemeMode("system", true), "dark");
    assert.equal(resolveCloudThemeMode("system", false), "light");
  });

  it("reads a valid stored cloud theme and falls back to system for invalid values", () => {
    const validStorage = {
      getItem: (key: string) => (key === CLOUD_THEME_STORAGE_KEY ? "dark" : null),
    };
    const invalidStorage = {
      getItem: (key: string) => (key === CLOUD_THEME_STORAGE_KEY ? "sepia" : null),
    };

    assert.equal(storedCloudThemeMode(validStorage), "dark");
    assert.equal(storedCloudThemeMode(invalidStorage), "system");
    assert.equal(storedCloudThemeMode(undefined), "system");
  });
});
