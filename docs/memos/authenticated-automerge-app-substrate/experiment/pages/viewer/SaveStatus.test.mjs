import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import {
  LINKS,
  OVERLAY_FLAGS,
  overlayStatus,
  syncStatus,
  viewerSyncStatusMachine,
} from "./sync-status-machine.mjs";

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
function render({ label, key }, compact = false) {
  const element = createElement(SaveStatus, { status: label, statusKey: key, compact });
  return JSDOM.fragment(renderToStaticMarkup(element)).querySelector('[role="status"]');
}

// Every status the machine and its overlays render, by label. A quiet save
// shares the Saving label, so it is listed as "Saving (quiet)".
const STATUSES = new Map();
const named = (status) => (status.key === "quiet" ? `${status.label} (quiet)` : status.label);
for (const name of viewerSyncStatusMachine.states)
  for (const link of LINKS)
    for (const localCopy of [false, true]) {
      const dirty = name === "quiet" || name === "saving";
      const state = {
        name,
        revision: 1,
        pending: dirty,
        link,
        ...(name === "quiet" && { armed: 1 }),
      };
      const status = syncStatus(state, { localCopy });
      STATUSES.set(named(status), status);
    }
for (const flag of OVERLAY_FLAGS) STATUSES.set(overlayStatus(flag).label, overlayStatus(flag));

// How each status is drawn: its class, its icon on desktop, and on phones
// whether the dot is shown and whether it pulses.
const DRAWN = {
  Connecting: { kind: "working", icon: true, dot: true, pulse: false },
  Reconnecting: { kind: "working", icon: true, dot: true, pulse: false },
  Connected: { kind: "plain", icon: false, dot: true, pulse: false },
  Syncing: { kind: "working", icon: true, dot: true, pulse: false },
  "Saving (quiet)": { kind: "quiet" },
  Saving: { kind: "working", icon: true, dot: true, pulse: true },
  Saved: { kind: "saved", icon: true, dot: false, pulse: false },
  "Saved locally": { kind: "attention", icon: true, dot: true, pulse: false },
  Offline: { kind: "attention", icon: true, dot: true, pulse: false },
  Deleted: { kind: "attention", icon: true, dot: true, pulse: false },
  "Access removed": { kind: "attention", icon: true, dot: true, pulse: false },
  "Access changed": { kind: "attention", icon: true, dot: true, pulse: false },
  "Sign in to sync": { kind: "attention", icon: true, dot: true, pulse: false },
  Unsaved: { kind: "error", icon: true, dot: true, pulse: false },
  "Local save failed": { kind: "error", icon: true, dot: true, pulse: false },
};

test("the table covers every status the machine renders", () => {
  assert.deepEqual([...STATUSES.keys()].sort(), Object.keys(DRAWN).sort());
});

for (const [label, status] of STATUSES) {
  const drawn = DRAWN[label];
  const saved = drawn.kind === "saved";
  if (drawn.kind === "quiet") {
    // Nothing to see or hear, in the same live region the next status uses.
    for (const compact of [false, true])
      test(`${compact ? "phone" : "desktop"}: ${label}`, () => {
        const element = render(status, compact);
        assert.ok(element.classList.contains("save-status--quiet"));
        assert.equal(element.classList.contains("save-status--dot"), compact);
        assert.equal(element.getAttribute("aria-live"), "polite");
        assert.equal(element.getAttribute("aria-atomic"), "true");
        assert.equal(element.textContent, "");
        assert.equal(element.children.length, 0);
        assert.equal(element.getAttribute("aria-label"), null);
        assert.equal(element.getAttribute("title"), null);
      });
    continue;
  }

  test(`desktop: ${label}`, () => {
    const element = render(status);
    assert.ok(element.classList.contains(`save-status--${drawn.kind}`));
    assert.equal(element.getAttribute("aria-live"), "polite");
    assert.equal(element.getAttribute("aria-atomic"), "true");
    assert.equal(!!element.querySelector("svg"), drawn.icon);
    if (drawn.icon) assert.equal(element.querySelector("svg").getAttribute("aria-hidden"), "true");
    if (saved) {
      // Quiet, with the same accessible meaning.
      assert.equal(element.getAttribute("aria-label"), "All changes saved");
      assert.equal(element.title, "All changes saved");
      assert.equal(element.querySelector(".sr-only").textContent, "Saved");
      assert.equal(element.querySelector(".save-status-label"), null);
    } else {
      // Visible, and never claiming saved.
      assert.equal(element.querySelector(".save-status-label").textContent, label);
      assert.equal(element.querySelector(".sr-only"), null);
      assert.equal(element.getAttribute("aria-label"), null);
      assert.equal(element.getAttribute("title"), null);
    }
  });

  test(`phone: ${label}`, () => {
    const element = render(status, true);
    assert.ok(element.classList.contains("save-status--dot"));
    assert.ok(element.classList.contains(`save-status--${drawn.kind}`));
    assert.equal(element.getAttribute("aria-live"), "polite");
    assert.equal(element.getAttribute("aria-atomic"), "true");
    assert.equal(element.dataset.status, label);
    // The label stays for screen readers, never as visible text.
    assert.equal(element.querySelector(".sr-only").textContent, label);
    assert.equal(element.querySelector(".save-status-label"), null);
    assert.equal(element.getAttribute("aria-label"), saved ? "All changes saved" : null);
    assert.equal(element.title, saved ? "All changes saved" : label);
    const dot = element.querySelector(".status-dot");
    assert.equal(!!dot, drawn.dot);
    if (dot) {
      assert.equal(dot.getAttribute("aria-hidden"), "true");
      assert.equal(dot.classList.contains("is-pulsing"), drawn.pulse);
    }
  });
}

test("the key, not the label, decides how a status is drawn", () => {
  // A reworded Saving label still pulses.
  const reworded = render({ label: "Saving your edits", key: "saving" }, true);
  assert.ok(reworded.querySelector(".status-dot.is-pulsing"));
  // The Saving label with another key does not.
  assert.equal(
    render({ label: "Saving", key: "syncing" }, true).querySelector(".is-pulsing"),
    null,
  );
  // A Saved label without the saved key is not quiet.
  assert.ok(!render({ label: "Saved", key: "connected" }).classList.contains("save-status--saved"));
});

test("a status without a known key is drawn plain and never as saved", () => {
  for (const status of [
    { label: "Read only" },
    { label: "A future status", key: "future" },
    { label: "Saved", key: "toString" },
  ]) {
    for (const compact of [false, true]) {
      const element = render(status, compact);
      assert.ok(element.classList.contains("save-status--plain"), status.label);
      assert.equal(element.getAttribute("aria-label"), null);
      assert.equal(element.querySelector(".is-pulsing"), null);
    }
    assert.equal(render(status).querySelector(".save-status-label").textContent, status.label);
    assert.equal(render(status).querySelector("svg"), null);
  }
});

test("the saving pulse changes size, never opacity", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./save-status.css", import.meta.url), "utf8");
  const pulse = css.match(/@keyframes save-status-pulse\s*\{([\s\S]*?)\n\}/);
  assert.ok(pulse, "save-status.css defines the pulse");
  assert.match(pulse[1], /transform:/);
  assert.doesNotMatch(pulse[1], /opacity/);
});
