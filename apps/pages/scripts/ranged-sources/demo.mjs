import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { localClient, pageEdits } from "../widget-catalog/local-client.mjs";
import { PARQUET_MEDIA_TYPE } from "../../shared/dataset-assets.mjs";

const origin = "http://localhost:" + Number(process.env.PAGES_PORT ?? 9917);
const bytes = await readFile(process.argv[2]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const { client, tool } = await localClient(page, origin);
  const { page_id } = await tool("create_page", {
    title: "Project activity · Parquet table",
    markdown:
      "Daily active people in a sample project. The chart reads the latest 28 days from a synthetic archive of 3,000 projects. The line beneath the chart counts the archive's rows.",
    nonce: crypto.randomUUID(),
  });
  const link = origin + "/p/" + page_id;
  console.log(link);
  const { source, edit } = pageEdits(tool, page_id);
  const asset = await source(
    "project-activity",
    "Project activity archive",
    bytes,
    PARQUET_MEDIA_TYPE,
  );
  await source(
    "activity-chart",
    "Activity chart module",
    await readFile(new URL("./activity.mjs", import.meta.url)),
    "text/javascript",
  );
  const saved = await edit([
    {
      op: "set_view",
      view_id: "daily",
      title: "Daily activity",
      view_type: "module",
      view_revision: null,
      module: { source_id: "activity-chart", revision: "1" },
      data: { activity: { source_id: "project-activity", revision: "1" } },
    },
  ]);
  await edit([{ op: "insert_node", node: { type: "view", attrs: { view_id: "daily" } } }]);
  const read = await tool("read_page", { page_id, view_id: "daily" });
  assert.equal(saved.result.edits[0].catalog_revision, read.view.catalog_revision);
  assert.match(read.view.catalog_revision, /^[a-f0-9]{64}$/);
  assert.ok(read.libraries.includes("@observablehq/plot"));
  assert.equal(read.view.data.activity.revision, "1");
  await client.close();
  const statuses = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.endsWith("/" + asset)) statuses.push(r.status());
  });
  await page.goto(link);
  const frame = page.frameLocator('iframe[title="Daily activity"]');
  try {
    await expect(frame.locator("svg rect")).toHaveCount(14, { timeout: 30000 });
  } catch (error) {
    console.error(await page.locator(".pages-anywidget-view").allTextContents(), statuses);
    throw error;
  }
  const report = frame.locator("p[data-rows]");
  assert.equal(Number(await report.getAttribute("data-rows")), 84000);
  await page.setViewportSize({ width: 390, height: 850 });
  await frame.getByRole("combobox").selectOption("28");
  await expect(frame.locator("svg rect")).toHaveCount(28);
  await page.getByRole("button", { name: "Project activity archive" }).click();
  const panel = page.getByRole("dialog", { name: "Sources" });
  await panel.getByRole("button", { name: "All sources" }).click();
  const libraries = panel.locator("details").filter({ hasText: "Standard libraries" });
  await expect(libraries.locator("summary svg.lucide-library")).toBeVisible();
  await libraries.locator("summary").click();
  await expect(libraries.locator("code")).toHaveText(read.view.catalog_revision.slice(0, 12));
  await expect(libraries.getByRole("button", { name: "Daily activity" })).toBeVisible();
  console.log(await report.textContent(), link);
} finally {
  await browser.close();
}
