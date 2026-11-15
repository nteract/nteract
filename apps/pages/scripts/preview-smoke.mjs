// Published previews retain Page-selected charts across reopening and text edits.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = (process.env.PAGES_SCREENSHOTS || "/tmp/pages-preview-smoke") + "/";
await mkdir(output, { recursive: true });
// A two-row Parquet table: day, surface, events (same data as the card-image fixture).
const parquet =
  "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(20000);
const api = (url, body) =>
  page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json() };
    },
    { url, body },
  );
const tool = async (operation, args) => {
  const r = await api("/api/tools", { operation, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body;
};
let id;
const open = async () => {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("button", { name: /Link preview/ }).click();
};
const capture = async (name) => {
  await expect(
    page.getByRole("button", { name: /^(Publish preview|Update public preview)$/ }),
  ).toBeEnabled();
  const src = await page
    .locator('img[alt="Exact image that will be published"]')
    .getAttribute("src");
  await writeFile(output + name + ".png", Buffer.from(src.split(",")[1], "base64"));
  return src;
};
try {
  const login = await page.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  await page.goto(login.headers().location);
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  id = (await tool("create_page", { title: "Events by surface", nonce: crypto.randomUUID() }))
    .page_id;
  const data = await page.evaluate(
    async ({ id, parquet }) => {
      const r = await fetch(`/api/pages/${id}/assets`, {
        method: "POST",
        headers: { "content-type": "application/vnd.apache.parquet" },
        body: Uint8Array.from(atob(parquet), (c) => c.charCodeAt(0)),
      });
      return r.json();
    },
    { id, parquet },
  );
  for (const operation of [
    {
      op: "set_source",
      source_id: "usage",
      name: "usage",
      asset_id: data.asset_id,
      source_revision: null,
    },
    {
      op: "set_view",
      view_id: "surface",
      title: "Events by surface",
      media_type: "application/vnd.vegalite.v6+json",
      spec: {
        data: { name: "usage" },
        mark: "bar",
        encoding: {
          x: { field: "surface", type: "nominal" },
          y: { field: "events", type: "quantitative" },
        },
      },
      data: { usage: { source_id: "usage" } },
      view_revision: null,
    },
    { op: "insert_node", node: { type: "view", attrs: { view_id: "surface" } } },
  ]) {
    const current = await tool("read_page", { page_id: id, comments: "none" });
    await tool("edit_page", {
      page_id: id,
      revision: current.revision,
      nonce: crypto.randomUUID(),
      operations: [operation],
    });
  }
  await page.goto(origin + "/p/" + id);
  await expect(page.locator('figure.pages-chart[data-chart-status="rendered"]')).toBeVisible();
  await open();
  await page.getByRole("group", { name: "Page visuals" }).getByRole("button").first().click();
  const selected = await capture("selected");
  await page.getByRole("button", { name: "Publish preview", exact: true }).click();
  await expect(page.getByText("Preview published.", { exact: true })).toBeVisible();
  const settings = (await api("/api/link-preview?page=" + id)).body;
  assert.equal(!!settings.snapshot.cover, true, "saved cover source");
  await page.reload();
  await expect(page.locator('figure.pages-chart[data-chart-status="rendered"]')).toBeVisible();
  await open();
  await page.getByLabel("Author", { exact: true }).fill("Kyle Kelley");
  const afterAuthor = await capture("after-author");
  const sameVisual = await page.evaluate(
    async ({ selected, afterAuthor }) => {
      const pixels = async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 1200;
        canvas.height = 438;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas.toDataURL();
      };
      return (await pixels(selected)) === (await pixels(afterAuthor));
    },
    { selected, afterAuthor },
  );
  assert.equal(sameVisual, true, "reopened text edits keep the exact chart pixels");
  await page.screenshot({ path: output + "reopened.png" });
  await expect(page.getByRole("button", { name: "Remove cover", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "reopened-narrow.png" });
  await page.getByRole("button", { name: "Update public preview", exact: true }).click();
  await expect(page.getByText("Preview published.", { exact: true })).toBeVisible();
  const updated = (await api("/api/link-preview?page=" + id)).body;
  assert.equal(updated.snapshot.cover.asset_id, settings.snapshot.cover.asset_id);
  const anon = await browser.newContext();
  const response = await anon.request.get(
    origin + `/api/pages/${id}/assets/${settings.snapshot.cover.asset_id}`,
  );
  assert.equal(response.status(), 401);
  await anon.close();
  console.log(
    "PASS: retained chart through reopen, byline edit and republish; source stays private.",
  );
} catch (error) {
  await page.screenshot({ path: output + "failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (id) await tool("delete_page", { page_id: id, nonce: crypto.randomUUID() }).catch(() => {});
  await browser.close();
}
