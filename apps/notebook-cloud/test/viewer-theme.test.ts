import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  resolveCloudViewerTheme,
  storedCloudViewerTheme,
} from "../viewer/theme.ts";
import {
  viewerThemeBootstrapScript,
  viewerThemeFirstPaintStyle,
} from "../src/viewer-theme-bootstrap.ts";

describe("cloud viewer theme helpers", () => {
  it("uses the cloud-specific storage key", () => {
    assert.equal(CLOUD_VIEWER_THEME_STORAGE_KEY, "nteract.cloud.viewer.theme");
  });

  it("ships a light default surface that class changes can flip before the bundle CSS loads", () => {
    const css = viewerThemeFirstPaintStyle();

    assert.match(css, /html \{\s+--background: oklch\(1 0 0\);/);
    assert.match(css, /--foreground: oklch\(0\.145 0 0\);/);
    assert.match(css, /html\.light,\s+html\[data-theme="light"\] \{/);
    assert.match(css, /html\.dark,\s+html\[data-theme="dark"\] \{/);
    assert.match(css, /--background: oklch\(0\.145 0 0\);/);
    assert.match(css, /body,\s+#root \{\s+min-height: 100%;/);
    assert.match(css, /background: var\(--background\);/);
    assert.match(css, /color: var\(--foreground\);/);
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

  it("seeds the saved light theme before CSS can apply system dark fallback", () => {
    const result = runBootstrapTheme({ storedTheme: "light", systemPrefersDark: true });

    assert.equal(result.datasetTheme, "light");
    assert.equal(result.colorScheme, "light");
    assert.deepEqual(result.classes, ["light"]);
  });

  it("falls back to system theme when no explicit stored theme is available", () => {
    const result = runBootstrapTheme({ storedTheme: "invalid", systemPrefersDark: true });

    assert.equal(result.datasetTheme, "dark");
    assert.equal(result.colorScheme, "dark");
    assert.deepEqual(result.classes, ["dark"]);
  });

  it("uses a palette storage key distinct from the mode key", () => {
    assert.equal(CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY, "nteract.cloud.viewer.color-theme");
    assert.notEqual(CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY, CLOUD_VIEWER_THEME_STORAGE_KEY);
  });

  it("seeds a saved cream palette before the bundle CSS loads", () => {
    const result = runBootstrapTheme({
      storedTheme: "dark",
      systemPrefersDark: false,
      storedPalette: "cream",
    });

    assert.equal(result.colorTheme, "cream");
    assert.equal(result.datasetTheme, "dark");
  });

  it("leaves the palette attribute off for classic and unknown values", () => {
    for (const storedPalette of ["classic", "sepia", null]) {
      const result = runBootstrapTheme({
        storedTheme: "light",
        systemPrefersDark: false,
        storedPalette,
      });
      assert.equal(result.colorTheme, undefined, `palette ${String(storedPalette)}`);
    }
  });
});

function storageLike(values: Map<string, string>): Pick<Storage, "getItem"> {
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
  };
}

function runBootstrapTheme({
  storedTheme,
  systemPrefersDark,
  storedPalette = null,
}: {
  storedTheme: string | null;
  systemPrefersDark: boolean;
  storedPalette?: string | null;
}): {
  classes: string[];
  datasetTheme: string | undefined;
  colorScheme: string | undefined;
  colorTheme: string | undefined;
} {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const root = {
    classList: {
      toggle(name: string, enabled: boolean): void {
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
    setAttribute(name: string, value: string): void {
      attributes.set(name, value);
    },
    removeAttribute(name: string): void {
      attributes.delete(name);
    },
    dataset: {} as { theme?: string },
    style: {} as { colorScheme?: string },
  };

  vm.runInNewContext(viewerThemeBootstrapScript(), {
    document: { documentElement: root },
    window: {
      localStorage: {
        getItem(key: string): string | null {
          if (key === CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY) {
            return storedPalette;
          }
          assert.equal(key, CLOUD_VIEWER_THEME_STORAGE_KEY);
          return storedTheme;
        },
      },
      matchMedia(query: string): { matches: boolean } {
        assert.equal(query, "(prefers-color-scheme: dark)");
        return { matches: systemPrefersDark };
      },
    },
  });

  return {
    classes: Array.from(classes).sort(),
    datasetTheme: root.dataset.theme,
    colorScheme: root.style.colorScheme,
    colorTheme: attributes.get("data-color-theme"),
  };
}
