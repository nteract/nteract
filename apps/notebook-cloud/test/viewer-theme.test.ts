import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  outputDocumentUrlForTheme,
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

  it("ignores invalid stored theme values", () => {
    const storage = new Map<string, string>();
    storage.set(CLOUD_VIEWER_THEME_STORAGE_KEY, "sepia");

    assert.equal(storedCloudViewerTheme(storageLike(storage)), "system");
  });

  it("adds the resolved theme to hosted output document URLs", () => {
    assert.equal(
      outputDocumentUrlForTheme(
        "https://outputs.example/frame/",
        "light",
        "https://cloud.test/n/demo",
      ),
      "https://outputs.example/frame/?nteract_theme=light",
    );
    assert.equal(
      outputDocumentUrlForTheme("/frame/?existing=1", "dark", "https://cloud.test/n/demo"),
      "https://cloud.test/frame/?existing=1&nteract_theme=dark",
    );
    assert.equal(outputDocumentUrlForTheme(null, "light", "https://cloud.test/n/demo"), undefined);
  });
});

function storageLike(values: Map<string, string>): Pick<Storage, "getItem"> {
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
  };
}
