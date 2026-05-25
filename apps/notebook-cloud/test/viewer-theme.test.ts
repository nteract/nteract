import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  resolveCloudViewerTheme,
  storedCloudViewerTheme,
} from "../viewer/theme.ts";

describe("cloud viewer theme helpers", () => {
  it("uses the cloud-specific storage key", () => {
    assert.equal(CLOUD_VIEWER_THEME_STORAGE_KEY, "nteract.cloud.viewer.theme");
  });

  it("resolves explicit and system themes", () => {
    assert.equal(resolveCloudViewerTheme("light", true), "light");
    assert.equal(resolveCloudViewerTheme("dark", false), "dark");
    assert.equal(resolveCloudViewerTheme("system", true), "dark");
    assert.equal(resolveCloudViewerTheme("system", false), "light");
  });

  it("reads valid stored themes and ignores invalid stored values", () => {
    const storage = new Map<string, string>();
    storage.set(CLOUD_VIEWER_THEME_STORAGE_KEY, "dark");

    assert.equal(storedCloudViewerTheme(storageLike(storage)), "dark");

    storage.set(CLOUD_VIEWER_THEME_STORAGE_KEY, "sepia");
    assert.equal(storedCloudViewerTheme(storageLike(storage)), "system");
    assert.equal(storedCloudViewerTheme(undefined), "system");
  });
});

function storageLike(values: Map<string, string>): Pick<Storage, "getItem"> {
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
  };
}
