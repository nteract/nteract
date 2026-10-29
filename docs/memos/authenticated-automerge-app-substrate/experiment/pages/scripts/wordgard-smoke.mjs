// Real local OIDC and two independent browser contexts; no public Pages mutations.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-wordgard-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const report = { origin, completed: [], errors, fixtures: [] };
let stage = "boot",
  a,
  b;
const diagram = `graph TD
  A[Ingest] --> B{Valid?}
  B -->|Yes| C[Transform]
  B -->|No| D[Quarantine]
  C --> E[(Warehouse)]
  C --> F[Metrics]
  F --> G[Dashboard]
  E --> G`;
const table =
  // Unsupported inline syntax intentionally keeps this a preserved-preview fixture.
  "| Name | Status |\n| --- | --- |\n| Pages | **Ready** |\n| Notes | [Guide](/llms.txt) |\n\n~~Preserved extension~~";
const content = (page) => page.locator("wg-content");
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20000 });
function checkpoint(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}
// Keep the exact token, key and payload for a fixture retry, including its driver.
// No retry authority is silently regenerated after an uncertain mutation.
const requestsByPage = new WeakMap();
async function call(page, operation, args = {}) {
  if (args.idempotency_key && !args.retry_token) {
    let requests = requestsByPage.get(page);
    if (!requests) requestsByPage.set(page, (requests = new Map()));
    const requestKey = JSON.stringify([operation, args.idempotency_key]);
    const fingerprint = JSON.stringify(args);
    let request = requests.get(requestKey);
    if (!request) {
      const catalog = ["create_page", "delete_page", "purge_page"].includes(operation);
      const authority = await rawCall(
        page,
        catalog ? "list_pages" : "read_page",
        catalog ? {} : { page_id: args.page_id },
      );
      assert.equal(typeof authority.retry_token, "string");
      assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
      request = {
        fingerprint,
        args: structuredClone({
          ...args,
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + args.idempotency_key,
        }),
      };
      requests.set(requestKey, request);
    }
    assert.equal(request.fingerprint, fingerprint, "fixture retry preserves its original payload");
    args = request.args;
  }
  return rawCall(page, operation, args);
}
async function rawCall(page, operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pages-Driver": "Wordgard browser fixture",
        },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args },
  );
}
async function selectText(page, text, collapse = false, block = 0) {
  const editor = content(page).nth(block);
  await editor.focus();
  await editor.evaluate(
    (el, { text, collapse }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest(
            ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
          )
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let joined = "",
        node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: joined.length });
        joined += node.textContent;
      }
      const start = joined.indexOf(text);
      if (start < 0) throw Error("Missing selection text: " + text + "; found " + joined);
      const at = (offset, startBoundary = false) => {
        const entry = nodes.find(
          ({ node, start }) =>
            offset >= start &&
            (startBoundary
              ? offset < start + node.textContent.length
              : offset <= start + node.textContent.length),
        );
        if (!entry) throw Error("Missing selection offset " + offset);
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      // At adjacent text-node boundaries, start in the following node so a
      // paragraph separator is not accidentally included in the passage.
      range.setStart(...at(start, true));
      range.setEnd(...at(start + text.length));
      if (collapse) range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    },
    { text, collapse },
  );
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toBe(collapse ? "" : text);
  // Let the editor observe the browser's asynchronous selectionchange event.
  await page.waitForTimeout(50);
}
async function assertQuietBlock(page) {
  await expect(
    page.getByRole("button", { name: "Comment on this block", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".comment-block")).toHaveCount(0);
  const editor = content(page).first();
  await editor.focus();
  await expect(editor).toBeFocused();
  const outlines = await editor.evaluate((element) =>
    [element, element.closest(".wordgard-document"), element.closest(".page-block")].map((node) => {
      const style = getComputedStyle(node);
      return { width: style.outlineWidth, style: style.outlineStyle };
    }),
  );
  assert.ok(
    outlines.every(({ width, style }) => width === "0px" || ["none", "hidden"].includes(style)),
    `focused editor has no rendered surrounding outline: ${JSON.stringify(outlines)}`,
  );
}
async function assertStableSelectionToolbar(page) {
  const text = "The fox crossed";
  const geometry = async (from, to) =>
    content(page)
      .first()
      .evaluate(
        (element, { text, from, to }) => {
          const nodes = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let joined = "",
            node;
          while ((node = walker.nextNode())) {
            nodes.push({ node, start: joined.length });
            joined += node.textContent;
          }
          const start = joined.indexOf(text);
          if (start < 0) throw Error("Selection fixture text missing");
          const point = (offset) => {
            const entry = nodes.find(
              ({ node, start }) => offset >= start && offset < start + node.textContent.length,
            );
            const range = document.createRange();
            range.setStart(entry.node, offset - entry.start);
            range.setEnd(entry.node, offset - entry.start + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + 1, y: rect.top + rect.height / 2 };
          };
          return { start: point(start + from), end: point(start + to) };
        },
        { text, from, to },
      );
  for (const width of [1280, 900, 863, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("textbox", { name: "Page title" }).focus();
    await page.evaluate(() => {
      getSelection().removeAllRanges();
      scrollTo(0, 0);
    });
    const toolbar = page.locator("[role='toolbar'][aria-label='Text formatting']");
    await expect(toolbar).not.toBeVisible();
    assert.equal(
      await toolbar.evaluate((element) => {
        const control = element.querySelector("button:not(:disabled),select:not(:disabled)");
        control?.focus();
        return document.activeElement === control;
      }),
      false,
      "hidden formatting controls cannot take focus",
    );
    await page.evaluate(() => {
      const editor = document.querySelector("wg-content");
      const node = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode();
      const first = document.createRange();
      first.setStart(node, 0);
      first.setEnd(node, 1);
      const toolbar = document.querySelector("[role='toolbar'][aria-label='Text formatting']");
      const records = [];
      let running = true;
      const sample = () => {
        const style = getComputedStyle(toolbar);
        records.push({
          y: first.getBoundingClientRect().top + scrollY,
          inFlow: !toolbar.hidden && style.visibility !== "hidden" && style.position !== "fixed",
        });
      };
      const tick = () => {
        if (!running) return;
        sample();
        requestAnimationFrame(tick);
      };
      const observer = new MutationObserver(sample);
      observer.observe(toolbar, {
        attributes: true,
        attributeFilter: ["hidden", "class", "style"],
      });
      sample();
      requestAnimationFrame(tick);
      window.stopSelectionToolbarTrace = () => {
        running = false;
        observer.disconnect();
        sample();
        return records;
      };
    });
    for (const [from, to] of [
      [0, text.length],
      [4, text.length],
    ]) {
      const { start, end } = await geometry(from, to);
      assert.equal(
        await page.evaluate(
          ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("wg-content"),
          start,
        ),
        true,
        "contextual formatting must not intercept the text being reselected",
      );
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      // Keep the pointer down across a frame: the old implementation briefly
      // put the floating toolbar back into document flow during reselection.
      await page.waitForTimeout(50);
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => getSelection().toString()))
        .toBe(text.slice(from, to));
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toHaveClass(/is-floating/);
      for (const name of [
        "Undo",
        "Redo",
        "Insert table",
        "Insert image",
        "Bulleted list",
        "Numbered list",
        "Task list",
      ])
        await expect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(0);
      const placement = await toolbar.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const range = getSelection().getRangeAt(0).getBoundingClientRect();
        return { width: box.width, gap: Math.max(range.top - box.bottom, box.top - range.bottom) };
      });
      assert.ok(placement.width <= 420, "selection controls remain compact at half-window widths");
      assert.ok(
        placement.gap >= 8 && placement.gap <= 12,
        "formatting stays beside the selected passage",
      );
      await page.waitForTimeout(50);
    }
    const records = await page.evaluate(() => window.stopSelectionToolbarTrace());
    report.selectionToolbarFrames ??= [];
    report.selectionToolbarFrames.push({ width, records });
    assert.ok(
      records.every((record) => Math.abs(record.y - records[0].y) <= 1),
      "selection does not shift document text",
    );
    assert.ok(
      records.every((record) => !record.inFlow),
      "automatic formatting never flashes in document flow",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("textbox", { name: "Page title" }).focus();
}
async function insertAfter(page, anchor, text, block = 0) {
  await selectText(page, anchor, true, block);
  await page.keyboard.insertText(text);
}
async function previewDiagram(page, block = 0) {
  const preview = content(page)
    .nth(block)
    .getByRole("button", { name: "Preview diagram", exact: true });
  if (await preview.isVisible()) await preview.click();
  await expect(content(page).nth(block).locator(".wordgard-diagram svg.pele")).toBeVisible({
    timeout: 30000,
  });
  await expect(content(page).nth(block).locator("pre:visible")).toHaveCount(0);
}
async function editDiagram(page, block = 0) {
  await content(page).nth(block).getByRole("button", { name: "Edit diagram", exact: true }).click();
  await expect(content(page).nth(block).locator("pre")).toBeVisible();
  await expect(content(page).nth(block).locator(".wordgard-diagram")).toHaveCount(0);
}
async function diagramControls(page, mode, block = 0) {
  const editor = content(page).nth(block);
  const toggle = editor.getByRole("button", {
    name: mode === "source" ? "Preview diagram" : "Edit diagram",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Copy diagram code", exact: true }),
  ).toBeVisible();
  const geometry = await toggle.evaluate((button) => {
    const host = button.closest("pre,.wordgard-diagram");
    const actions = button.closest(".wordgard-diagram-actions");
    const copy = actions.querySelector('[aria-label="Copy diagram code"]');
    const bounds = host.getBoundingClientRect();
    const control = button.getBoundingClientRect();
    const clipboard = copy.getBoundingClientRect();
    const language = host.querySelector(".wg-code-language")?.getBoundingClientRect();
    return {
      top: control.top - bounds.top,
      right: bounds.right - clipboard.right,
      toggle: { width: control.width, height: control.height },
      copy: { width: clipboard.width, height: clipboard.height },
      actionsOverlap: control.right > clipboard.left,
      languageOverlaps: !!language && language.right > control.left,
      inBounds: control.left >= bounds.left && clipboard.right <= bounds.right,
      mobile: innerWidth <= 600,
    };
  });
  assert.ok(geometry.top >= 0 && geometry.top <= 12, "diagram actions occupy the top corner");
  assert.ok(geometry.right >= 0 && geometry.right <= 12, "diagram actions occupy the right corner");
  assert.equal(geometry.actionsOverlap, false, "source/preview and copy controls do not overlap");
  assert.equal(geometry.languageOverlaps, false, "language menu does not overlap diagram actions");
  assert.equal(geometry.inBounds, true, "diagram controls stay within their block");
  for (const target of [geometry.toggle, geometry.copy]) {
    const minimum = geometry.mobile ? 40 : 32;
    assert.ok(
      target.width >= minimum && target.height >= minimum,
      "diagram actions have usable hit targets",
    );
    assert.ok(target.width <= 48 && target.height <= 48, "diagram controls remain compact");
  }
  return geometry;
}
function sameDiagramCorner(preview, source) {
  assert.ok(Math.abs(preview.top - source.top) <= 4, "preview and source keep the same top offset");
  assert.ok(
    Math.abs(preview.right - source.right) <= 4,
    "preview and source keep the same right offset",
  );
}
async function copyDiagram(page, expected, block = 0) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText("not copied yet"));
  const copy = content(page)
    .nth(block)
    .getByRole("button", { name: "Copy diagram code", exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  await expect(copy).toBeFocused();
}
async function deniedDiagramCopy(page, block = 0, delayed = false) {
  await page.evaluate((delayed) => {
    if (Object.hasOwn(navigator.clipboard, "writeText"))
      throw Error("Unexpected clipboard override in fixture");
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        if (delayed)
          await new Promise((resolve) => {
            window.finishDiagramCopy = resolve;
          });
        throw new DOMException("Clipboard denied by fixture", "NotAllowedError");
      },
    });
  }, delayed);
  try {
    const editor = content(page).nth(block);
    const copy = editor.getByRole("button", { name: "Copy diagram code", exact: true });
    await copy.click();
    const status = editor.locator(".wordgard-diagram-actions").getByRole("status");
    if (delayed) {
      await expect(copy).toBeFocused();
      await expect(copy).toHaveAttribute("aria-busy", "true");
      await copy.press("Tab");
      await page.evaluate(() => window.finishDiagramCopy());
      await expect(copy).not.toHaveAttribute("aria-busy");
      await expect(status).toBeEmpty();
      return;
    }
    await expect(status).toHaveText("Couldn’t copy. Try again.");
    await expect(status).toBeVisible();
    await expect(copy).toBeFocused();
    await copy.press("Tab");
    await expect(status).toBeEmpty();
  } finally {
    await page.evaluate(() => {
      delete navigator.clipboard.writeText;
      delete window.finishDiagramCopy;
    });
  }
}
async function textOf(page, block) {
  const editors = block === undefined ? content(page) : content(page).nth(block);
  return editors.evaluateAll((elements) =>
    elements
      .map((el) => {
        const clone = el.cloneNode(true);
        clone
          .querySelectorAll(".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button")
          .forEach((n) => n.remove());
        clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
        return clone.textContent;
      })
      .join("\n"),
  );
}
// Use the actual editor geometry without changing its document or selection.
async function cursorGeometry(page, text, { reveal = false } = {}) {
  return content(page)
    .first()
    .evaluate(
      (el, { text, reveal }) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.parentElement.closest(
              ".wordgard-widget,.wordgard-diagram-actions,select,button",
            )
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          },
        });
        const nodes = [];
        let joined = "",
          node;
        while ((node = walker.nextNode())) {
          nodes.push({ node, start: joined.length });
          joined += node.textContent;
        }
        const start = joined.indexOf(text);
        if (start < 0) throw Error("Missing caret target " + text);
        const end = start + text.length;
        const target = nodes.find(
          ({ node, start }) => end >= start && end <= start + node.textContent.length,
        );
        if (reveal) target.node.parentElement.scrollIntoView({ block: "center" });
        const editor = el.closest(".wordgard-document").wg;
        const expected = editor.coordsAtPos(editor.posAtDOM(target.node, end - target.start));
        const host = el.closest(".wordgard-editor");
        const carets = host.querySelectorAll(".wordgard-caret-layer .peer-caret");
        const actual = carets.length === 1 ? carets[0].getBoundingClientRect() : null;
        return {
          count: carets.length,
          insideContent: el.querySelectorAll(".peer-caret").length,
          expected: { left: expected.left, top: expected.top, height: expected.height },
          actual: actual && { left: actual.left, top: actual.top, height: actual.height },
          scrollY,
        };
      },
      { text, reveal },
    );
}
async function alignedCursor(page, text) {
  await expect(page.locator(".wordgard-caret-layer .peer-caret")).toHaveCount(1);
  await expect(page.locator("wg-content .peer-caret")).toHaveCount(0);
  await expect
    .poll(async () => {
      const geometry = await cursorGeometry(page, text);
      if (!geometry.actual) return Infinity;
      return Math.max(
        Math.abs(geometry.actual.left - geometry.expected.left),
        Math.abs(geometry.actual.top - geometry.expected.top),
        Math.abs(geometry.actual.height - geometry.expected.height),
      );
    })
    .toBeLessThan(2);
  return cursorGeometry(page, text);
}
async function create(markdown, title) {
  const result = await call(a, "create_page", {
    title,
    markdown,
    idempotency_key: crypto.randomUUID(),
  });
  report.fixtures.push(result.page_id);
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + result.page_id);
    await expect(content(page).first()).toBeVisible();
    await saved(page);
  }
  return result;
}
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto(origin + "/api/auth/login");
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
    assert.equal(
      await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).editor),
      "wordgard",
    );
  }
  const proseFixture = await create(
    "The **fox** crossed the garden.\n\nSecond writer starts here.\n\nOpen [Pages implementation notes](/llms.txt).",
    "Wordgard prose fixture " + Date.now(),
  );
  await expect(content(a)).toContainText("The fox crossed the garden");
  checkpoint("Wordgard boot with local OIDC and two contexts");

  stage = "contextual formatting preserves pointer selection and document layout";
  const selectionBefore = await call(a, "read_page", { page_id: proseFixture.page_id });
  await assertStableSelectionToolbar(a);
  const selectionAfter = await call(a, "read_page", { page_id: proseFixture.page_id });
  assert.deepEqual(selectionAfter.heads.slice().sort(), selectionBefore.heads.slice().sort());
  checkpoint(stage);

  stage = "quiet editor and comments list without automatic composition";
  await selectText(a, "fox");
  await assertQuietBlock(a);
  await a.screenshot({ path: output + "/quiet-editor-desktop.png", fullPage: true });
  const commentsToggle = a.getByRole("button", { name: "Comments", exact: true });
  await commentsToggle.click();
  await expect(a.locator("#page-comments")).toBeVisible();
  await expect(a.locator(".comment-composer")).toHaveCount(0);
  await expect(a.locator(".comments-empty")).toContainText("No comments yet.");
  await a.getByRole("button", { name: "Close comments", exact: true }).click();
  await expect(commentsToggle).toBeFocused();
  await a.setViewportSize({ width: 390, height: 844 });
  await selectText(a, "fox");
  await assertQuietBlock(a);
  await a.screenshot({ path: output + "/quiet-editor-mobile.png", fullPage: true });
  await commentsToggle.click();
  await expect(a.locator(".comment-composer")).toHaveCount(0);
  await a.keyboard.press("Escape");
  await expect(commentsToggle).toBeFocused();
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.setViewportSize({ width: 1280, height: 900 });
  checkpoint(stage);

  stage = "toolbar keyboard state";
  await selectText(a, "fox");
  const bold = a.getByRole("button", { name: "Bold", exact: true });
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("ControlOrMeta+b");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  await expect(content(b).locator("strong")).toHaveCount(0);
  await a.keyboard.press("ControlOrMeta+b");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(content(b).locator("strong")).toHaveText("fox");
  checkpoint(stage);

  stage = "concurrent typing and remote cursor";
  await Promise.all([
    insertAfter(a, "garden.", " A writes."),
    insertAfter(b, "here.", " B writes."),
  ]);
  for (const page of [a, b]) {
    await expect.poll(() => textOf(page)).toContain("garden. A writes.");
    await expect.poll(() => textOf(page)).toContain("here. B writes.");
  }
  await expect(a.locator(".peer-caret > span")).toHaveCount(1);
  await expect(b.locator(".peer-caret > span")).toHaveCount(1);
  await expect(a.locator(".peer-caret > span")).toBeVisible();
  await expect(b.locator(".peer-caret > span")).toBeVisible();
  checkpoint(stage);

  stage = "undo preserves intervening remote edit";
  await insertAfter(a, "A writes.", " Local undo.");
  await expect.poll(() => textOf(b)).toContain("Local undo.");
  await insertAfter(b, "B writes.", " Remote stays.");
  await expect.poll(() => textOf(a)).toContain("Remote stays.");
  await a.keyboard.press("ControlOrMeta+z");
  for (const page of [a, b]) {
    await expect.poll(() => textOf(page)).not.toContain("Local undo.");
    await expect.poll(() => textOf(page)).toContain("Remote stays.");
    await expect.poll(() => textOf(page)).toContain("A writes.");
  }
  checkpoint(stage);

  stage = "selection draft survives thread-list toggles and explicit retargeting";
  await selectText(a, "fox");
  await a.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const draft = a.getByRole("textbox", { name: "Comment on selection", exact: true });
  await draft.fill("Keep this unsent passage draft.");
  await commentsToggle.click();
  await commentsToggle.click();
  await expect(draft).toHaveValue("Keep this unsent passage draft.");
  await expect(a.locator(".composer-context")).toHaveText("fox");
  await commentsToggle.click();
  // Let the panel's scheduled focus restoration finish before selecting elsewhere.
  await a.evaluate(() => new Promise(requestAnimationFrame));
  await expect(commentsToggle).toBeFocused();
  await selectText(a, "Second writer");
  await expect(content(a)).toBeFocused();
  await a.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await expect(draft).toHaveValue("Keep this unsent passage draft.");
  await expect(a.locator(".composer-context")).toHaveText("Second writer");
  await a.locator(".comment-composer").getByRole("button", { name: "Cancel", exact: true }).click();
  await a.getByRole("button", { name: "Close comments", exact: true }).click();
  await commentsToggle.click();
  await expect(a.locator(".comment-composer")).toHaveCount(0);
  await a.getByRole("button", { name: "Close comments", exact: true }).click();
  await a.evaluate(() => new Promise(requestAnimationFrame));
  await expect(commentsToggle).toBeFocused();
  checkpoint(stage);

  stage = "selection comment and passage navigation";
  await selectText(a, "fox");
  await a.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await a
    .getByRole("textbox", { name: "Comment on selection", exact: true })
    .fill("Discuss this shared passage.");
  await a.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(b.locator(".comment-passage")).toHaveText("fox");
  await b.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(b.locator(".comment-composer")).toHaveCount(0);
  await expect(b.locator(".thread .message")).toContainText("Discuss this shared passage.");
  await b.locator(".thread .quote").click();
  await expect(b.locator(".comment-passage-active")).toHaveText("fox");
  await expect(b.locator(".thread-active")).toBeVisible();
  await b.screenshot({ path: output + "/comment-desktop.png", fullPage: true });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.locator(".thread .quote").click();
  await expect(b.locator("#page-comments")).not.toBeVisible();
  await expect(b.locator(".comment-passage-active")).toHaveText("fox");
  await b.screenshot({ path: output + "/comment-mobile.png", fullPage: true });
  await b.setViewportSize({ width: 1280, height: 900 });
  await a.getByRole("button", { name: "Close comments", exact: true }).click();
  checkpoint(stage);

  stage = "actual link click, popup navigation, synchronized edit";
  await content(a).locator("a").click();
  const linkMenu = a.getByRole("dialog", { name: "Link", exact: true });
  await expect(linkMenu).toBeVisible();
  const popupPromise = a.waitForEvent("popup");
  await linkMenu.getByRole("link", { name: "Open link", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL(origin + "/llms.txt");
  await popup.close();
  await linkMenu.getByRole("button", { name: "Edit link", exact: true }).click();
  await linkMenu
    .getByRole("textbox", { name: "Link address", exact: true })
    .fill(origin + "/llms.txt?wordgard=1");
  await linkMenu.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(content(b).locator("a")).toHaveAttribute("href", origin + "/llms.txt?wordgard=1");
  checkpoint(stage);

  stage = "link save and remove participate in undo and redo";
  await content(a).focus();
  await a.keyboard.press("ControlOrMeta+z");
  for (const page of [a, b])
    await expect(content(page).locator("a")).toHaveAttribute("href", origin + "/llms.txt");
  await a.keyboard.press("ControlOrMeta+Shift+z");
  for (const page of [a, b])
    await expect(content(page).locator("a")).toHaveAttribute(
      "href",
      origin + "/llms.txt?wordgard=1",
    );
  await content(a).locator("a").click();
  await linkMenu.getByRole("button", { name: "Remove link", exact: true }).click();
  for (const page of [a, b]) {
    await expect(content(page).locator("a")).toHaveCount(0);
    await expect(content(page)).toContainText("Pages implementation notes");
  }
  await content(a).focus();
  await a.keyboard.press("ControlOrMeta+z");
  for (const page of [a, b])
    await expect(content(page).locator("a")).toHaveAttribute(
      "href",
      origin + "/llms.txt?wordgard=1",
    );
  await a.keyboard.press("ControlOrMeta+Shift+z");
  for (const page of [a, b]) await expect(content(page).locator("a")).toHaveCount(0);
  await a.keyboard.press("ControlOrMeta+z");
  for (const page of [a, b])
    await expect(content(page).locator("a")).toHaveAttribute(
      "href",
      origin + "/llms.txt?wordgard=1",
    );
  checkpoint(stage);

  stage = "assistive link click without pointer coordinates";
  await content(a).locator("a").dispatchEvent("click", { detail: 0, clientX: 0, clientY: 0 });
  await expect(linkMenu).toBeVisible();
  await expect(linkMenu.getByRole("link", { name: "Open link", exact: true })).toHaveAttribute(
    "href",
    origin + "/llms.txt?wordgard=1",
  );
  await linkMenu.getByRole("button", { name: "Close link menu", exact: true }).click();
  checkpoint(stage);

  stage = "open link popover tracks remote insertion and removal";
  await content(a).locator("a").click();
  await expect(linkMenu).toBeVisible();
  await insertAfter(b, "Open ", "a shared link: ");
  await expect(content(a)).toContainText("Open a shared link:");
  await expect(linkMenu).toBeVisible();
  await linkMenu.getByRole("button", { name: "Edit link", exact: true }).click();
  await linkMenu
    .getByRole("textbox", { name: "Link address", exact: true })
    .fill(origin + "/llms.txt?wordgard=2");
  await linkMenu.getByRole("button", { name: "Save link", exact: true }).click();
  await expect(content(b).locator("a")).toHaveAttribute("href", origin + "/llms.txt?wordgard=2");
  await expect(content(b).locator("a")).toHaveText("Pages implementation notes");
  await content(a).locator("a").click();
  await selectText(b, "Pages implementation notes");
  await b.keyboard.press("Backspace");
  await expect(content(a).locator("a")).toHaveCount(0);
  await expect(linkMenu).not.toBeVisible();
  await expect(a.locator(".app > .error")).toHaveCount(0);
  checkpoint(stage);

  stage = "synthetic Chromium composition with intervening remote edit";
  await selectText(a, "garden.", true);
  const cdp = await a.context().newCDPSession(a);
  await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
  await insertAfter(b, "Remote stays.", " During composition.");
  await cdp.send("Input.insertText", { text: "かな" });
  await cdp.detach();
  for (const page of [a, b]) {
    await expect.poll(() => textOf(page)).toContain("garden.かな");
    await expect.poll(() => textOf(page)).toContain("During composition.");
  }
  await expect(a.locator(".app > .error")).toHaveCount(0);
  checkpoint(stage);

  stage = "expired auth refresh retains Wordgard instance and undo history";
  await insertAfter(a, "A writes.", " History survives.");
  await expect.poll(() => textOf(b)).toContain("History survives.");
  await insertAfter(b, "During composition.", " Auth witness.");
  await expect.poll(() => textOf(a)).toContain("Auth witness.");
  await a.bringToFront();
  const editorId = await content(a).getAttribute("id");
  const authPath = "**/api/auth/session";
  await a.route(
    authPath,
    (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Expired local fixture session" }),
      }),
    { times: 1 },
  );
  const expired = a.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/session" && response.status() === 401,
  );
  await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expired;
  await expect(
    a.getByRole("alert").filter({ hasText: "Sign in again to sync this Page" }),
  ).toBeVisible();
  await expect(content(a)).toHaveAttribute("id", editorId);
  // An expired credential pauses sync but deliberately preserves local editing.
  await expect(content(a)).toHaveAttribute("contenteditable", "true");
  await expect(a.locator(".ProseMirror")).toHaveCount(0);
  await a.unroute(authPath);
  const renewed = a.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/session" && response.status() === 200,
  );
  await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await renewed;
  await expect(content(a)).toHaveAttribute("id", editorId);
  await expect(content(a)).toHaveAttribute("contenteditable", "true");
  await saved(a);
  await content(a).focus();
  // A collapsed caret intentionally hides contextual formatting. Open the
  // keyboard-accessible dock to inspect history without changing the selection.
  await a.keyboard.press("Alt+F10");
  // showFormatting focuses the dock on the next animation frame.
  await expect(a.getByRole("button", { name: "Undo", exact: true })).toBeFocused();
  await expect(a.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await a.keyboard.press("Escape");
  await expect(content(a)).toBeFocused();
  await a.keyboard.press("ControlOrMeta+z");
  for (const page of [a, b]) {
    await expect.poll(() => textOf(page)).not.toContain("History survives.");
    await expect.poll(() => textOf(page)).toContain("Auth witness.");
    await expect.poll(() => textOf(page)).toContain("garden.かな");
  }
  checkpoint(stage);

  stage = "code fence, remote language change preserves active source, Mermaid rendering";
  const code = await create("", "Wordgard rich fixture " + Date.now());
  await content(a).click();
  await a.keyboard.type("```");
  await a.keyboard.press("Enter");
  await expect(content(a).locator("pre")).toBeVisible();
  // Chromium's insertText is not paste: enter line breaks through keyboard events.
  for (const [index, line] of diagram.split("\n").entries()) {
    if (index) await a.keyboard.press("Enter");
    await a.keyboard.insertText(line);
  }
  await expect.poll(() => textOf(a)).toBe(diagram);
  await expect.poll(() => textOf(b)).toBe(diagram);
  // A peer choosing Mermaid must not collapse the source under an active cursor.
  await selectText(a, "Dashboard", true);
  await b.locator("select.wg-code-language").selectOption("mermaid");
  // The person choosing Mermaid sees the diagram immediately, without another
  // Preview click; the peer actively editing the same source keeps its caret.
  await expect(b.locator(".wordgard-diagram svg.pele")).toBeVisible({ timeout: 30000 });
  await expect(content(b).locator("pre:visible")).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Edit diagram", exact: true })).toBeFocused();
  await expect(a.locator("select.wg-code-language")).toHaveValue("mermaid");
  await expect(content(a).locator("pre:visible")).toHaveCount(1);
  await a.keyboard.insertText(" view");
  await expect.poll(() => textOf(a)).toBe(diagram.replace("Dashboard", "Dashboard view"));
  await expect.poll(() => textOf(b)).toBe(diagram.replace("Dashboard", "Dashboard view"));
  await a.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => textOf(a)).toBe(diagram);
  await expect.poll(() => textOf(b)).toBe(diagram);
  await previewDiagram(a);
  for (const page of [a, b])
    await expect(page.locator(".wordgard-diagram")).toContainText("Warehouse");
  await saved(a);
  checkpoint(stage);

  stage = "Mermaid preview is local, preserves source and undo, and synchronizes edits";
  const beforeToggle = await call(a, "read_page", { page_id: code.page_id });
  const desktopPreview = await diagramControls(a, "preview");
  await deniedDiagramCopy(a);
  await deniedDiagramCopy(a, 0, true);
  await copyDiagram(a, diagram);
  await a.screenshot({ path: output + "/diagram-controls-desktop.png", fullPage: true });
  await editDiagram(a);
  const desktopSource = await diagramControls(a, "source");
  sameDiagramCorner(desktopPreview, desktopSource);
  await copyDiagram(a, diagram);
  await a.screenshot({ path: output + "/diagram-source-desktop.png", fullPage: true });
  await expect.poll(() => textOf(a)).toBe(diagram);
  await expect(content(b).locator("pre:visible")).toHaveCount(0);
  await previewDiagram(a);
  const afterToggle = await call(a, "read_page", { page_id: code.page_id });
  assert.deepEqual(
    afterToggle.heads,
    beforeToggle.heads,
    "preview toggles and copying code do not write the document",
  );
  assert.deepEqual(
    afterToggle.blocks,
    beforeToggle.blocks,
    "preview toggles preserve exact source",
  );
  // Arrowing into a collapsed code block must expose its native source before
  // the user can type, rather than accepting edits behind the diagram widget.
  await content(a).focus();
  await a.keyboard.press("ArrowRight");
  await expect(content(a).locator("pre")).toBeVisible();
  await expect.poll(() => textOf(a)).toBe(diagram);
  await expect(content(b).locator("pre:visible")).toHaveCount(0);
  await previewDiagram(a);
  await editDiagram(a);
  await selectText(a, "Dashboard");
  await a.keyboard.insertText("Overview");
  await expect(b.locator(".wordgard-diagram")).toContainText("Overview", { timeout: 30000 });
  await expect(content(b).locator("pre:visible")).toHaveCount(0);
  await copyDiagram(a, diagram.replace("Dashboard", "Overview"));
  await copyDiagram(b, diagram.replace("Dashboard", "Overview"));
  // Copying leaves focus on its control. Return to native source before undo.
  await content(a).first().focus();
  await a.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => textOf(a)).toBe(diagram);
  await expect(b.locator(".wordgard-diagram")).toContainText("Dashboard", { timeout: 30000 });
  await previewDiagram(a);
  await saved(a);
  checkpoint(stage);

  stage = "invalid Mermaid remains recoverable through Edit diagram";
  await editDiagram(a);
  await selectText(a, "graph TD");
  await a.keyboard.insertText("not-a-supported-diagram");
  await a.getByRole("button", { name: "Preview diagram", exact: true }).click();
  await expect(a.locator(".wordgard-diagram")).toContainText("Diagram unavailable", {
    timeout: 30000,
  });
  await expect(content(a).locator("pre:visible")).toHaveCount(0);
  await editDiagram(a);
  await selectText(a, "not-a-supported-diagram");
  await a.keyboard.insertText("graph TD");
  await previewDiagram(a);
  await expect(b.locator(".wordgard-diagram")).toContainText("Warehouse", { timeout: 30000 });
  await saved(a);
  checkpoint(stage);

  stage = "empty-code clipboard paste, inactive Mermaid, and preserved table";
  let current = await call(a, "read_page", { page_id: code.page_id });
  await call(a, "patch_page", {
    page_id: code.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "insert_markdown",
        after_block_id: current.blocks[0].id,
        markdown: "",
      },
      { op: "insert_markdown", after_block_id: current.blocks[0].id, markdown: table },
    ],
  });
  for (const page of [a, b]) await expect(content(page)).toHaveCount(3);
  current = await call(a, "read_page", { page_id: code.page_id });
  const pastedIndex = current.blocks.findIndex((block) => block.markdown.trim() === "");
  assert.ok(pastedIndex >= 0, "fresh code-paste block exists");
  const pastedEditor = content(a).nth(pastedIndex);
  await pastedEditor.click();
  await a.keyboard.type("```");
  await a.keyboard.press("Enter");
  await expect(pastedEditor.locator("pre")).toBeVisible();
  // Native paste into an empty block must reach Wordgard, not its language widget.
  await expect(pastedEditor.locator("select.wg-code-language:visible")).toHaveCount(0);
  await a.keyboard.press("ControlOrMeta+Shift+l");
  await expect(a.locator(".app-error")).toHaveCount(0);
  assert.deepEqual(errors, [], "empty-code language shortcut does not call a hidden picker");
  const pastedDiagram = "graph LR\n X[Other block] --> Y[Still renders]";
  await a.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await a.bringToFront();
  await pastedEditor.focus();
  assert.equal(
    await a.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
      return navigator.clipboard.readText();
    }, pastedDiagram),
    pastedDiagram,
  );
  await a.keyboard.press("ControlOrMeta+v");
  for (const page of [a, b]) await expect.poll(() => textOf(page, pastedIndex)).toBe(pastedDiagram);
  await expect(pastedEditor.locator("select.wg-code-language")).toHaveCount(1);
  await pastedEditor.locator("select.wg-code-language").selectOption("mermaid");
  for (const page of [a, b]) {
    await expect(content(page).nth(pastedIndex).locator(".wordgard-diagram svg.pele")).toBeVisible({
      timeout: 30000,
    });
    await expect(content(page).nth(pastedIndex).locator("pre:visible")).toHaveCount(0);
  }
  // Moving between blocks keeps inactive diagrams rendered, with no raw source.
  await content(a).first().getByRole("button", { name: "Edit diagram", exact: true }).focus();
  for (const page of [a, b]) {
    await expect(page.locator(".wordgard-diagram svg.pele")).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator(".preserved-table table")).toBeVisible();
    await expect(page.locator(".preserved-table table")).toContainText("Ready");
  }
  await expect(
    a.getByRole("button", { name: "Show table Markdown source", exact: true }),
  ).toHaveCount(0);
  await expect(a.locator(".preserved-table-toolbar,.preserved-table-source")).toHaveCount(0);
  current = await call(a, "read_page", { page_id: code.page_id });
  assert.ok(
    current.blocks.some((block) => block.markdown.includes(table)),
    "MCP round-trip preserves table source",
  );
  checkpoint(stage);

  stage = "preview clicks do not create a gap caret; keyboard and source carets remain";
  const beforePreviewFocus = await call(a, "read_page", { page_id: code.page_id });
  await content(a).first().locator(".wordgard-diagram-canvas").click();
  await expect(a.locator("wg-cursor.wg-cursor-h:visible")).toHaveCount(0);
  assert.equal(
    await a.evaluate(() => !!document.activeElement.closest(".wordgard-diagram")),
    true,
    "clicking a rendered diagram focuses the preview, not the text editor",
  );
  // Keyboard entry still gets a real insertion position, then a text caret.
  await content(a).first().focus();
  await a.keyboard.press("ArrowLeft");
  await expect(a.locator("wg-cursor.wg-cursor-h:visible")).toHaveCount(1);
  await a.keyboard.press("ArrowRight");
  await expect(content(a).first().locator("pre:visible")).toHaveCount(1);
  await expect(a.locator("wg-cursor.wg-cursor-v:visible")).toHaveCount(1);
  await previewDiagram(a);
  await a.locator(".preserved-table th").first().click();
  await expect(a.locator("wg-cursor.wg-cursor-h:visible")).toHaveCount(0);
  await editDiagram(a);
  await expect(a.locator("wg-cursor.wg-cursor-v:visible")).toHaveCount(1);
  await previewDiagram(a);
  const afterPreviewFocus = await call(a, "read_page", { page_id: code.page_id });
  assert.deepEqual(afterPreviewFocus.heads, beforePreviewFocus.heads);
  assert.deepEqual(afterPreviewFocus.blocks, beforePreviewFocus.blocks);
  checkpoint(stage);

  stage = "mobile preview toggle and table without a source-header gap";
  await a.setViewportSize({ width: 390, height: 844 });
  const beforeMobileControls = await call(a, "read_page", { page_id: code.page_id });
  const mobilePreview = await diagramControls(a, "preview");
  await copyDiagram(a, diagram);
  await content(a).first().locator(".wordgard-diagram-canvas").click();
  await expect(a.locator("wg-cursor.wg-cursor-h:visible")).toHaveCount(0);
  await editDiagram(a);
  const mobileSource = await diagramControls(a, "source");
  sameDiagramCorner(mobilePreview, mobileSource);
  await copyDiagram(a, diagram);
  await a.screenshot({ path: output + "/diagram-source-mobile.png", fullPage: true });
  await expect.poll(() => textOf(a, 0)).toBe(diagram);
  await expect(content(b).first().locator("pre:visible")).toHaveCount(0);
  await previewDiagram(a);
  const afterMobileControls = await call(a, "read_page", { page_id: code.page_id });
  assert.deepEqual(
    afterMobileControls.heads,
    beforeMobileControls.heads,
    "mobile diagram controls do not edit the document",
  );
  const tableGap = await a.locator(".preserved-table").evaluate((element) => {
    const preview = element.querySelector(".markdown-table-scroll");
    return preview.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  assert.ok(tableGap <= 16, `table has no reserved source-toolbar space (${tableGap}px)`);
  report.mobileTableTopGap = tableGap;
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "mobile previews do not overflow the page",
  );
  await a.screenshot({ path: output + "/preview-mobile.png", fullPage: true });
  await a.setViewportSize({ width: 1280, height: 900 });
  // Source mode in both peers gives the caret tests a visible text target.
  await editDiagram(a);
  await editDiagram(b);
  for (const page of [a, b])
    await expect(content(page).locator("pre .wordgard-diagram")).toHaveCount(0);
  checkpoint(stage);

  stage = "deleting an inactive block retains active cursor presence";
  current = await call(a, "read_page", { page_id: code.page_id });
  await call(a, "patch_page", {
    page_id: code.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "insert_markdown",
        after_block_id: current.blocks.at(-1).id,
        markdown: "Disposable inactive block.",
      },
    ],
  });
  await expect(content(a)).toHaveCount(4);
  await expect(content(b)).toHaveCount(4);
  await selectText(a, "Dashboard", true);
  await cursorGeometry(b, "Dashboard", { reveal: true });
  await expect(b.locator(".peer-caret > span")).toHaveCount(1);
  await expect(b.locator(".peer-caret > span")).toBeVisible();
  current = await call(a, "read_page", { page_id: code.page_id });
  const disposable = current.blocks.find((block) =>
    block.markdown.includes("Disposable inactive block."),
  );
  assert.ok(disposable);
  await call(a, "patch_page", {
    page_id: code.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [{ op: "delete_block", block_id: disposable.id }],
  });
  await expect(content(a)).toHaveCount(3);
  await expect(content(b)).toHaveCount(3);
  await expect(b.locator(".peer-caret > span")).toHaveCount(1);
  await expect(b.locator(".peer-caret > span")).toBeVisible();
  checkpoint(stage);

  stage = "one remote cursor stays aligned outside editor content while scrolling";
  const beforeScroll = await alignedCursor(b, "Dashboard");
  await b.evaluate(() => scrollBy(0, 100));
  const afterScroll = await alignedCursor(b, "Dashboard");
  assert.ok(
    Math.abs(afterScroll.scrollY - beforeScroll.scrollY) >= 50,
    "fixture actually scrolled",
  );
  report.caretAlignment = { beforeScroll, afterScroll };
  checkpoint(stage);

  stage = "reload and subsequent live update";
  await saved(a);
  await saved(b);
  await b.reload();
  await expect(b.locator(".wordgard-diagram svg.pele")).toHaveCount(2, { timeout: 30000 });
  await expect(b.locator(".preserved-table table")).toBeVisible();
  await saved(b);
  await selectText(a, "Dashboard");
  await a.keyboard.insertText("Overview");
  await expect(b.locator(".wordgard-diagram").first()).toContainText("Overview", {
    timeout: 30000,
  });
  await saved(a);
  await saved(b);
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: output + "/rich-mobile.png", fullPage: true });
  assert.equal(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "mobile page does not overflow horizontally",
  );
  checkpoint(stage);

  stage = "read-only rendering and controls (frontend fixture, not authorization proof)";
  const readerContext = await browser.newContext({
    storageState: await contexts[0].storageState(),
  });
  const reader = await readerContext.newPage();
  reader.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await reader.route(/\/api\/(auth\/session|connect)(\?|$)/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, canWrite: false } });
  });
  await reader.goto(origin + "/p/" + code.page_id);
  await expect(content(reader).first()).toHaveAttribute("contenteditable", "false");
  await expect(reader.locator(".wordgard-diagram svg.pele")).toHaveCount(2, { timeout: 30000 });
  await expect(reader.locator(".preserved-table table")).toBeVisible();
  await expect(reader.getByRole("toolbar", { name: "Text formatting" })).toHaveCount(0);
  await expect(reader.locator(".rich-toolbar")).toBeHidden();
  await expect(reader.locator("select.wg-code-language:enabled")).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Edit diagram", exact: true })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Preview diagram", exact: true })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Copy diagram code", exact: true })).toHaveCount(
    2,
  );
  await expect(content(reader).locator("pre:visible")).toHaveCount(0);
  const beforeRead = await call(a, "read_page", { page_id: code.page_id });
  await copyDiagram(reader, diagram.replace("Dashboard", "Overview"));
  await content(reader).first().click();
  await reader.keyboard.type("must not edit");
  await expect.poll(() => textOf(reader)).not.toContain("must not edit");
  const afterRead = await call(a, "read_page", { page_id: code.page_id });
  assert.deepEqual(
    afterRead.heads,
    beforeRead.heads,
    "read-only copy and typing create no changes",
  );
  await reader.screenshot({ path: output + "/read-only.png", fullPage: true });
  await readerContext.close();
  checkpoint(stage);

  {
    // Preserve transport/recovery coverage while exercising the shipped editor.
    // The proxy only delays or drops real client frames; it never invents bytes.
    let hold = false,
      blocked = null,
      held = 0,
      delaying = false;
    const delayedFrames = [];
    await contexts[0].routeWebSocket(/\/api\/sync\?/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((data) => {
        if (delaying) {
          delayedFrames.push({ server, data });
          return;
        }
        if (hold && !blocked) blocked = ws;
        if (ws === blocked) {
          held++;
          return;
        }
        server.send(data);
      });
      server.onMessage((data) => ws.send(data));
    });
    const transport = await create(
      "Transport recovery fixture.",
      "Wordgard transport fixture " + Date.now(),
    );

    stage = "duplicated tab owns a distinct signer and IndexedDB store";
    // window.open clones sessionStorage. Web Locks must rotate the second live
    // tab's signer and storage namespace, rather than share one database owner.
    const popupPromise = contexts[0].waitForEvent("page");
    await a.evaluate(() => window.open(location.href, "_blank"));
    const duplicate = await popupPromise;
    duplicate.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await saved(duplicate);
    const storageFingerprint = (page) =>
      page.evaluate(async (pageId) => {
        const response = await fetch("/api/auth/session");
        if (!response.ok) throw Error("Fixture authentication unavailable");
        const { identity } = await response.json();
        const digest = async (value) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
        const scope = await digest(`${identity.principal}\0${pageId}`);
        const seed = sessionStorage.getItem(`pages-native:${scope}`);
        if (!seed) throw Error("Active fixture signer is missing after Saved");
        const database = `pages-native-${scope}-${seed.slice(0, 16)}`;
        // Return fingerprints only, never the private signer seed.
        return {
          signer: await digest(seed),
          store: await digest(database),
          storeExists: (await indexedDB.databases()).some((entry) => entry.name === database),
        };
      }, transport.page_id);
    const originalStorage = await storageFingerprint(a);
    const duplicateStorage = await storageFingerprint(duplicate);
    assert.notEqual(originalStorage.signer, duplicateStorage.signer, "exclusive signer");
    assert.notEqual(originalStorage.store, duplicateStorage.store, "exclusive byte store");
    assert.equal(originalStorage.storeExists, true, "original store exists");
    assert.equal(duplicateStorage.storeExists, true, "duplicate store exists");
    await duplicate.close();
    checkpoint(stage);

    stage = "delayed native frames recover after a failed save receipt without another edit";
    // Cross the authorization recheck boundary. Fresh connections do not cover
    // the retired-admission-context regression from the original editor smoke.
    await a.waitForTimeout(17000);
    await a.bringToFront();
    const documentTimeOrigin = await a.evaluate(() => performance.timeOrigin);
    const delayedReceipt = a.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/saved" &&
        new URL(response.url()).searchParams.get("page") === transport.page_id &&
        response.status() === 409,
      { timeout: 20000 },
    );
    delaying = true;
    await selectText(a, "Transport recovery fixture.", true);
    await a.keyboard.insertText(" Returned from another tab.");
    await expect.poll(() => delayedFrames.length).toBeGreaterThan(0);
    const backgroundTab = await contexts[0].newPage();
    await backgroundTab.goto("about:blank");
    await backgroundTab.bringToFront();
    const backgroundVisibility = await a.evaluate(() => document.visibilityState);
    assert.equal(await backgroundTab.evaluate(() => document.visibilityState), "visible");
    assert.equal((await textOf(b)).includes("Returned from another tab."), false);
    assert.equal((await (await delayedReceipt).json()).error, "Requested edits have not arrived");
    await expect(
      a.getByRole("alert").filter({ hasText: "Requested edits have not arrived" }),
    ).toBeVisible();
    await a.bringToFront();
    const returnedVisibility = await a.evaluate(() => document.visibilityState);
    assert.equal(returnedVisibility, "visible");
    await backgroundTab.close();
    delaying = false;
    for (const { server, data } of delayedFrames.splice(0)) server.send(data);
    await expect.poll(() => textOf(b), { timeout: 20000 }).toContain("Returned from another tab.");
    await saved(a);
    await saved(b);
    await expect(a.getByRole("alert")).toHaveCount(0);
    assert.equal(await a.evaluate(() => performance.timeOrigin), documentTimeOrigin, "no reload");
    assert.equal(await textOf(a), await textOf(b));
    const afterReturn = await call(a, "read_page", { page_id: transport.page_id });
    assert.match(afterReturn.blocks[0].markdown, /Returned from another tab\./);
    report.tabReturn = {
      background_visibility: backgroundVisibility,
      returned_visibility: returnedVisibility,
      // Headless Chromium can leave every tab visible: do not call that proof
      // of background throttling, only delayed-frame and receipt recovery.
      visibility_transition_verified: backgroundVisibility === "hidden",
    };
    checkpoint(stage);

    stage = "pending IndexedDB edits survive reload and merge concurrent peer changes";
    const pendingReceiptRequest = a.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/saved" &&
        new URL(request.url()).searchParams.get("page") === transport.page_id,
      { timeout: 10000 },
    );
    hold = true;
    await selectText(a, "Transport recovery fixture.");
    await a.keyboard.press("ArrowLeft");
    await a.keyboard.insertText("Pending ");
    await expect.poll(() => held).toBeGreaterThan(0);
    // saveReceipt awaits the repository flush and pending-marker persistence
    // before issuing this request. Wait for that boundary, not an arbitrary delay.
    await pendingReceiptRequest;
    assert.equal((await textOf(b)).includes("Pending "), false);
    await selectText(b, "Returned from another tab.", true);
    await b.keyboard.insertText(" Concurrent");
    await expect.poll(() => textOf(a)).toContain("Concurrent");
    hold = false;
    await a.reload();
    await expect.poll(() => textOf(a), { timeout: 20000 }).toContain("Pending ");
    await expect.poll(() => textOf(b), { timeout: 20000 }).toContain("Pending ");
    await expect.poll(() => textOf(a)).toContain("Concurrent");
    await saved(a);
    await saved(b);
    assert.equal(await textOf(a), await textOf(b));
    // Recovery must leave both existing peers able to publish their next edit.
    await selectText(b, "Concurrent", true);
    await b.keyboard.insertText(" Peer after reload.");
    await expect.poll(() => textOf(a)).toContain("Peer after reload.");
    await selectText(a, "Peer after reload.", true);
    await a.keyboard.insertText(" Owner after reload.");
    await expect.poll(() => textOf(b)).toContain("Owner after reload.");
    await saved(a);
    await saved(b);
    assert.equal(await textOf(a), await textOf(b));
    const afterRecovery = await call(a, "read_page", { page_id: transport.page_id });
    assert.match(afterRecovery.blocks[0].markdown, /^Pending Transport recovery fixture\./);
    assert.match(
      afterRecovery.blocks[0].markdown,
      /Concurrent Peer after reload\. Owner after reload\./,
    );
    checkpoint(stage);
  }

  for (const page of [a, b]) await expect(page.locator(".app > .error")).toHaveCount(0);
  assert.deepEqual(errors, [], "no unhandled page errors");
  // Only these scratch local documents belong to this run. Keep failed fixtures for diagnosis.
  for (const page_id of report.fixtures) {
    const current = await call(a, "read_page", { page_id });
    await call(a, "delete_page", {
      page_id,
      base_heads: current.heads,
      idempotency_key: crypto.randomUUID(),
    });
    await purgeTrashedFixture(
      (operation, args) => call(a, operation, args),
      page_id,
      () => ({
        idempotency_key: crypto.randomUUID(),
      }),
    );
  }
  report.cleanedUp = true;
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = String(error.stack ?? error);
  for (const [name, page] of [
    ["a", a],
    ["b", b],
  ])
    if (page) {
      await page
        .screenshot({ path: output + "/failure-" + name + ".png", fullPage: true })
        .catch(() => {});
      await writeFile(output + "/failure-" + name + ".html", await page.content()).catch(() => {});
    }
  console.error("FAIL " + stage + "\n" + report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
