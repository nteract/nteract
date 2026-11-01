import test from "node:test";
import assert from "node:assert/strict";
import { GLIDE_DEFAULTS, readFlag, readGlideSettings } from "./feature-flags.mjs";

function browser(search = "", stored = {}, extra = {}) {
  return {
    location: { search },
    localStorage: { getItem: (key) => (Object.hasOwn(stored, key) ? stored[key] : null) },
    ...extra,
  };
}

test("a flag reads the URL first, then localStorage under pages.<name>", () => {
  assert.equal(readFlag("glide", browser("?glide=1")), "1");
  assert.equal(readFlag("glide", browser("", { "pages.glide": "1" })), "1");
  assert.equal(readFlag("glide", browser("?glide=0", { "pages.glide": "1" })), "0");
  assert.equal(readFlag("glide", browser()), null);
  const refusing = {
    location: { search: "" },
    get localStorage() {
      throw Error("SecurityError");
    },
  };
  assert.equal(readFlag("glide", refusing), null);
});

test("glide is off by default and keeps every default when off", () => {
  assert.equal(readGlideSettings(browser()), GLIDE_DEFAULTS);
  assert.equal(readGlideSettings(browser("?glide=0&glide.duration=900")).enabled, false);
  assert.deepEqual(readGlideSettings(browser("?glide=1")), { ...GLIDE_DEFAULTS, enabled: true });
});

test("glide knobs read from the URL or localStorage and fall back when invalid", () => {
  assert.deepEqual(
    readGlideSettings(
      browser("?glide=on&glide.duration=500&glide.maxJump=0&glide.ghost=1200", {
        "pages.glide.easing": "linear",
      }),
    ),
    { enabled: true, durationMs: 500, easing: "linear", maxJumpPx: 0, ghostFadeMs: 1200 },
  );
  const invalid = readGlideSettings(
    browser(
      "?glide=1&glide.duration=-4&glide.maxJump=lots&glide.ghost=1.5&glide.easing=" +
        encodeURIComponent("ease; color: red"),
    ),
  );
  assert.deepEqual(invalid, { ...GLIDE_DEFAULTS, enabled: true });
  // A browser's own CSS parser decides which easings are valid.
  const css = { supports: (_property, value) => value === "steps(4)" };
  assert.equal(
    readGlideSettings(browser("?glide=1&glide.easing=steps(4)", {}, { CSS: css })).easing,
    "steps(4)",
  );
  assert.equal(
    readGlideSettings(browser("?glide=1&glide.easing=bouncy", {}, { CSS: css })).easing,
    GLIDE_DEFAULTS.easing,
  );
});
