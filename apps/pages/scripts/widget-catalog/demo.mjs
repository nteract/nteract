import { localClient, pageEdits } from "./local-client.mjs";
// Seed a persistent Page over the local OAuth / MCP path, then exercise both
// widgets in a new reader session. The only inputs are synthetic counts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = "http://localhost:" + Number(process.env.PAGES_PORT || 9916);
const output = "http://127.0.0.1:" + Number(process.env.PAGES_CATALOG_PORT || 9446);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const { client, tool } = await localClient(page, origin);
  const { page_id } = await tool("create_page", {
    title: "Activity explorer · Page modules",
    markdown:
      "These example counts illustrate our dogfooding activity. Both views use the same controls. Open Activity controls in Sources to see both views that import it.",
    nonce: crypto.randomUUID(),
  });
  const link = origin + "/p/" + page_id;
  console.log(link);
  const { edit, source } = pageEdits(tool, page_id);
  const days = [2, 4, 3, 5, 2, 3, 4, 3, 5, 4, 3, 6, 5, 4].map((people, i) => ({
    date: "Nov " + (i + 1),
    people,
  }));
  await source(
    "example-counts",
    "Example counts",
    Buffer.from(JSON.stringify({ days, counts: { Readers: 8, Writers: 5 } })),
    "application/octet-stream",
  );
  const controls = await readFile(new URL("activity-controls.mjs", import.meta.url));
  await source("controls", "Activity controls", controls, "text/javascript");
  for (const [id, title] of [
    ["activity", "Daily activity"],
    ["roles", "Participation"],
  ]) {
    await source(
      id,
      title + " module",
      await readFile(new URL(id + ".mjs", import.meta.url)),
      "text/javascript",
    );
    await edit([
      {
        op: "set_view",
        view_id: id,
        title,
        view_type: "module",
        module: { source_id: id },
        data: { activity: { source_id: "example-counts" } },
        imports: { "activity-controls": { source_id: "controls" } },
        view_revision: null,
      },
    ]);
    await edit([{ op: "insert_node", node: { type: "view", attrs: { view_id: id } } }]);
  }
  const read = await tool("read_page", { page_id, view_id: "activity" });
  assert.equal(read.view.view_type, "module");
  // The view pins the catalog the Page host serves from its own origin.
  const pin = read.view.catalog_revision;
  const manifest = await (await fetch(`${origin}/catalog/${pin}/manifest.json`)).text();
  assert.equal(createHash("sha256").update(manifest).digest("hex"), pin);
  assert.deepEqual(read.view.imports["activity-controls"], { source_id: "controls" });
  assert.ok(read.libraries.includes("@observablehq/plot"));
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
    const frames = page.frames().filter((f) => f.url().startsWith(output));
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      // The frame URL is the plain bootstrap; the libraries came with the mount.
      assert.equal(new URL(frame.url()).search, "");
      assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  await expect(chart.locator('[data-controls-revision="2"]')).toHaveCount(0);
  const updatedControls = controls
    .toString()
    .replace('"aria-pressed":', '"data-controls-revision":"2","aria-pressed":');
  assert.notEqual(updatedControls, controls.toString());
  await source(
    "controls",
    "Activity controls",
    Buffer.from(updatedControls),
    "text/javascript",
    "1",
  );
  await expect(chart.locator('[data-controls-revision="2"]')).toHaveCount(2);
  await expect(roles.locator('[data-controls-revision="2"]')).toHaveCount(2);
  await client.close();
  await page.setViewportSize({ width: 1200, height: 950 });
  await expect(page.locator(".sources-line")).toContainText("Example counts");
  await expect(page.locator(".sources-line")).not.toContainText("libraries");
  await page
    .locator('summary[aria-label="Document actions"], button[aria-label="More page actions"]')
    .click();
  await page
    .getByRole("button", { name: "Sources", exact: true })
    .or(page.getByRole("menuitem", { name: "Sources", exact: true }))
    .click();
  const panel = page.getByRole("dialog", { name: "Sources", exact: true });
  const revisions = panel.locator(".library-revisions");
  await revisions.locator("summary").click();
  await expect(revisions.locator("code")).toHaveText(pin.slice(0, 12));
  await expect(revisions.getByRole("button")).toHaveCount(2);
  await panel.getByRole("button", { name: /Activity controls.*2 connections/ }).click();
  await expect(panel).toContainText("imports.activity-controls");
  console.log("Verified both module views at wide and narrow widths. " + link);
} finally {
  await browser.close();
}
