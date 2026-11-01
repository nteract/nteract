import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./SaveStatus.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { SaveStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
function render(status) {
  const fragment = JSDOM.fragment(renderToStaticMarkup(createElement(SaveStatus, { status })));
  return fragment.querySelector('[role="status"]');
}

test("the acknowledged Saved state is quiet and retains its accessible meaning", () => {
  const status = render("Saved");
  assert.equal(status.getAttribute("aria-label"), "All changes saved");
  assert.equal(status.title, "All changes saved");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.getAttribute("aria-atomic"), "true");
  assert.equal(status.querySelector(".sr-only").textContent, "Saved");
  assert.equal(status.querySelector(".save-status-label"), null);
  assert.equal(status.querySelector("svg").getAttribute("aria-hidden"), "true");
  assert.ok(status.classList.contains("save-status--saved"));
});

test("connection, local-only, permission, and failure states remain visible and never claim saved", () => {
  for (const value of [
    "Connecting",
    "Connected",
    "Reconnecting",
    "Syncing",
    "Saving",
    "Saved locally",
    "Offline",
    "Unsaved",
    "Local save failed",
    "Sign in to sync",
    "Access changed",
    "Access removed",
    "Deleted",
    "Read only",
    "A future status",
  ]) {
    const status = render(value);
    assert.equal(status.querySelector(".save-status-label").textContent, value);
    assert.equal(status.querySelector(".sr-only"), null);
    assert.equal(status.getAttribute("aria-label"), null);
    assert.equal(status.getAttribute("title"), null);
    assert.ok(!status.classList.contains("save-status--saved"), value);
  }
  assert.ok(render("Local save failed").classList.contains("save-status--error"));
  assert.ok(render("Unsaved").classList.contains("save-status--error"));
  assert.ok(render("Saved locally").classList.contains("save-status--attention"));
  assert.ok(render("Saving").classList.contains("save-status--working"));
  assert.ok(render("Syncing").classList.contains("save-status--working"));
  assert.equal(render("Connected").querySelector("svg"), null);
});
