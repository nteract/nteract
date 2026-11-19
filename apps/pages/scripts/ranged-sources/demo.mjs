import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { localClient, pageEdits } from "../widget-catalog/local-client.mjs";
import { MODULE_MEDIA_TYPE } from "../../shared/anywidget-view.mjs";
import { PARQUET_MEDIA_TYPE } from "../../shared/dataset-assets.mjs";

const origin = "http://localhost:" + Number(process.env.PAGES_PORT ?? 9917);
const bytes = await readFile(process.argv[2]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const { client, tool } = await localClient(page, origin);
  const { page_id } = await tool("create_page", {
    title: "Project activity · ranged Parquet",
    markdown:
      "Daily active people in a sample project. The chart reads a 28-day preview from a synthetic archive of 3,000 projects. The counter beneath the chart measures the Parquet bytes delivered to this view.",
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
      media_type: MODULE_MEDIA_TYPE,
      view_revision: null,
      spec: {
        module: { source_id: "activity-chart", revision: "1" },
        files: { activity: { source_id: "project-activity", revision: "1" } },
      },
    },
  ]);
  await edit([{ op: "insert_node", node: { type: "view", attrs: { view_id: "daily" } } }]);
  const read = await tool("read_page", { page_id, view_id: "daily" });
  assert.equal(saved.result.edits[0].catalog_revision, read.view.catalog_revision);
  assert.match(read.view.catalog_revision, /^[a-f0-9]{64}$/);
  assert.equal(read.widget_imports.catalog, null);
  assert.equal(read.view.spec.files.activity.revision, "1");
  await client.close();
  // Disable the browser cache so the accounting includes every file response.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  let delivered = 0,
    ranges = 0;
  const statuses = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.endsWith("/" + asset) && r.request().method() === "GET") {
      statuses.push(r.status());
      if (r.status() === 206) {
        ranges++;
        delivered += Number(r.headers()["content-length"]);
      }
    }
  });
  await page.goto(link);
  const frame = page.frameLocator('iframe[title="Daily activity"]');
  try {
    await expect(frame.locator("svg rect")).toHaveCount(14, { timeout: 30000 });
  } catch (error) {
    console.error(await page.locator(".pages-anywidget-view").allTextContents(), statuses);
    throw error;
  }
  const report = frame.locator("p[data-bytes]");
  assert.equal(Number(await report.getAttribute("data-bytes")), delivered);
  assert.ok(
    ranges >= 2 && delivered > 0 && delivered < bytes.length && statuses.every((s) => s === 206),
  );
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
