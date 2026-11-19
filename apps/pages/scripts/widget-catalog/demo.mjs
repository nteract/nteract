import { localClient, pageEdits } from "./local-client.mjs";
// Seed a persistent Page over the local OAuth / MCP path, then exercise both
// widgets in a new reader session. The only inputs are synthetic counts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { ANYWIDGET_MEDIA_TYPE } from "../../shared/anywidget-view.mjs";

const origin = "http://localhost:" + Number(process.env.PAGES_PORT || 9916);
const catalog = "http://127.0.0.1:" + Number(process.env.PAGES_CATALOG_PORT || 9446);
const manifest = await (await fetch(catalog + "/catalog.json")).text();
const pin = createHash("sha256").update(manifest).digest("hex");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const { client, tool } = await localClient(page, origin);
  assert.ok(
    (await client.listTools()).tools
      .find((t) => t.name === "edit_page")
      .inputSchema.properties.operations.items.properties.op.enum.includes("set_widget_imports"),
  );
  const { page_id } = await tool("create_page", {
    title: "Activity explorer · Page modules",
    markdown:
      "These example counts illustrate our dogfooding activity. Both views use the same controls. Open Page libraries in Sources to see which libraries come from the catalog and which component belongs to this Page.",
    nonce: crypto.randomUUID(),
  });
  const link = origin + "/p/" + page_id;
  console.log(link);
  const { edit, source } = pageEdits(tool, page_id);
  const days = [2, 4, 3, 5, 2, 3, 4, 3, 5, 4, 3, 6, 5, 4].map((people, i) => ({
    date: "Nov " + (i + 1),
    people,
  }));
  for (const [id, title, data] of [
    ["activity", "Daily activity", { days }],
    ["roles", "Participation", { counts: { Readers: 8, Writers: 5 } }],
  ]) {
    const js = await readFile(new URL(id + ".mjs", import.meta.url));
    await source(id, title + " module", js, "text/javascript");
    await edit([
      {
        op: "set_view",
        view_id: id,
        title,
        media_type: ANYWIDGET_MEDIA_TYPE,
        view_revision: null,
        spec: { module: { source_id: id }, state: data },
      },
    ]);
    await edit([{ op: "insert_node", node: { type: "view", attrs: { view_id: id } } }]);
  }
  await page.goto(link);
  // Both widget modules import activity-controls. Binding that component while the
  // Page is open must remount them without a view edit or a page reload.
  await expect(page.locator('.pages-anywidget-view[data-output-state="failed"]')).toHaveCount(2, {
    timeout: 30000,
  });
  const controls = await readFile(new URL("activity-controls.mjs", import.meta.url));
  await source("controls", "Activity controls", controls, "text/javascript");
  const declaration = {
    op: "set_widget_imports",
    catalog: "standard",
    source_revision: null,
    modules: [{ name: "activity-controls", source_id: "controls", revision: "1" }],
  };
  const initial = await tool("read_page", { page_id });
  assert.equal(initial.widget_imports.available_catalog, "standard");
  await assert.rejects(
    edit([{ ...declaration, modules: [{ ...declaration.modules[0], name: "react" }] }]),
    /unique bare name/,
  );
  await edit([declaration]);
  await assert.rejects(edit([declaration]), /stale_source|source exists/i);
  const read = await tool("read_page", { page_id });
  assert.equal(read.widget_imports.catalog_revision, pin);
  assert.deepEqual(read.widget_imports.imports, Object.keys(JSON.parse(manifest).imports));
  assert.equal(read.widget_imports.modules[0].revision, "1");
  const nextControls = controls
    .toString()
    .replace('"aria-pressed":', '"data-controls-revision":"2","aria-pressed":');
  assert.notEqual(nextControls, controls.toString());
  await source("controls", "Activity controls", Buffer.from(nextControls), "text/javascript", "1");
  await expect(page.locator('.pages-anywidget-view[data-output-state="ready"]')).toHaveCount(2, {
    timeout: 30000,
  });
  await page.goto(link);
  const chart = page.frameLocator('iframe[title="Daily activity"]');
  const roles = page.frameLocator('iframe[title="Participation"]');
  for (const [width, scheme] of [
    [1200, "light"],
    [390, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await chart.getByText("14 days", { exact: true }).click({ timeout: 30000 });
    await expect(chart.locator("svg rect")).toHaveCount(14);
    await expect(chart.locator('g[aria-label="x-axis tick label"] text').first()).toHaveText(
      "Nov 1",
    );
    const off = chart.getByText("7 days", { exact: true });
    await expect(off).toHaveAttribute("aria-pressed", "false");
    await expect(chart.getByRole("button", { name: "14 days", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await roles.getByText("Writers", { exact: true }).click();
    await expect(roles.locator("p")).toContainText("5 people edited");
    await expect(chart.locator("html")).toHaveAttribute("data-theme", scheme);
    const frames = page.frames().filter((f) => f.url().startsWith(catalog));
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      assert.equal(new URL(frame.url()).searchParams.get("catalog"), pin);
      assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await expect(chart.locator('[data-controls-revision="2"]')).toHaveCount(0);
  async function repin(revision) {
    const { widget_imports } = await tool("read_page", { page_id });
    await edit([
      {
        ...declaration,
        source_revision: widget_imports.source_revision,
        modules: [{ ...declaration.modules[0], revision }],
      },
    ]);
  }
  await repin("2");
  await expect(chart.locator('[data-controls-revision="2"]')).toHaveCount(2);
  await expect(roles.locator('[data-controls-revision="2"]')).toHaveCount(2);
  await repin("1");
  await expect(page.locator('.pages-anywidget-view[data-output-state="ready"]')).toHaveCount(2);
  await expect(chart.getByRole("button", { name: "7 days" })).toBeVisible();
  await expect(chart.locator('[data-controls-revision="2"]')).toHaveCount(0);
  await client.close();
  await page.setViewportSize({ width: 1200, height: 950 });
  await expect(page.locator(".sources-line")).toHaveCount(0);
  await page
    .locator('summary[aria-label="Document actions"], button[aria-label="More page actions"]')
    .click();
  await page
    .getByRole("button", { name: "Sources", exact: true })
    .or(page.getByRole("menuitem", { name: "Sources", exact: true }))
    .click();
  const panel = page.getByRole("dialog", { name: "Sources", exact: true });
  await expect(panel.locator(".library-revisions")).toHaveCount(0);
  await panel.getByRole("button", { name: /Page libraries.*Page import map/ }).click();
  const revisions = panel.locator(".library-revisions");
  await revisions.locator("summary").click();
  await expect(revisions.locator("code")).toHaveText(pin.slice(0, 12));
  await expect(revisions.getByRole("button")).toHaveCount(2);
  await expect(panel.getByRole("region", { name: "Library imports" })).toContainText(
    "activity-controls",
  );
  await expect(
    panel.getByRole("heading", { name: "Page libraries" }).locator("svg.lucide-library"),
  ).toBeVisible();
  await expect(panel).toContainText("Used on this Page · 2");
  await panel.getByRole("button", { name: "All sources" }).click();
  await expect(
    panel
      .getByRole("button", { name: /Page libraries.*Page import map/ })
      .locator("svg.lucide-library"),
  ).toBeVisible();
  console.log("Verified both widgets at wide and narrow widths. " + link);
} finally {
  await browser.close();
}
