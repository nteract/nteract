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
  // A valid tall Page image would produce a 10,000px capture at scale 2,
  // exceeding the host's source-image limit even though the final card fits.
  for (const [width, height] of [
    [64, 5000],
    [1, 8192],
    [8192, 1],
  ]) {
    const tall = await page.evaluate(
      async ({ id, width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#327d83";
        ctx.fillRect(0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const response = await fetch(`/api/pages/${id}/assets`, {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: blob,
        });
        if (!response.ok) throw Error(await response.text());
        return response.json();
      },
      { id, width, height },
    );
    const current = await tool("read_page", { page_id: id, comments: "none" });
    await tool("edit_page", {
      page_id: id,
      revision: current.revision,
      nonce: crypto.randomUUID(),
      operations: [
        { op: "insert_image", asset_id: tall.asset_id, alt: `Visual ${width}x${height}` },
      ],
    });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.reload();
    const pageImage = page.getByAltText(`Visual ${width}x${height}`, { exact: true });
    await pageImage.evaluate(async (image) => {
      image.loading = "eager";
      await image.decode();
      image.scrollIntoView();
    });
    await expect(pageImage).toBeVisible();
    await open();
    await page
      .getByRole("group", { name: "Page visuals" })
      .getByRole("button", { name: `Visual ${width}x${height}`, exact: true })
      .click();
    await capture(`visual-${width}x${height}`);
    await page.getByRole("button", { name: "Update public preview", exact: true }).click();
    await expect(page.getByText("Preview published.", { exact: true })).toBeVisible();
    const tallSettings = (await api("/api/link-preview?page=" + id)).body;
    const dimensions = await page.evaluate(
      async ({ id, asset }) => {
        const response = await fetch(`/api/pages/${id}/assets/${asset}`);
        const blob = await response.blob();
        const image = await createImageBitmap(blob);
        const result = { width: image.width, height: image.height, bytes: blob.size };
        image.close();
        return result;
      },
      { id, asset: tallSettings.snapshot.cover.asset_id },
    );
    assert.ok(dimensions.width <= 1152 && dimensions.height <= 390);
    assert.ok(dimensions.bytes < 5 * 1024 * 1024);
  }
  // An uploaded cover fills the whole card. Its corners are a known colour; a
  // caption card shows its own background there instead.
  const fillColour = [192, 57, 43];
  const coverPng = await page.evaluate(async (rgb) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${rgb.join(",")})`;
    ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(300, 200, 200, 200);
    return canvas.toDataURL("image/png").split(",")[1];
  }, fillColour);
  const cornerOf = (src) =>
    page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        corner: Array.from(ctx.getImageData(4, 4, 1, 1).data.slice(0, 3)),
      };
    }, src);
  const near = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 3);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.reload();
  await open();
  await page.getByLabel("Cover image", { exact: true }).setInputFiles({
    name: "full-card.png",
    mimeType: "image/png",
    buffer: Buffer.from(coverPng, "base64"),
  });
  const fillChoice = page.getByRole("radio", { name: "Fill the card", exact: true });
  const captionChoice = page.getByRole("radio", { name: "Title below", exact: true });
  await expect(fillChoice).toBeChecked();
  const filled = await cornerOf(await capture("fill"));
  assert.ok(near(filled.corner, fillColour), `fill corner ${filled.corner}`);
  await captionChoice.check();
  const captioned = await cornerOf(await capture("fill-as-caption"));
  assert.ok(near(captioned.corner, [247, 248, 245]), `caption corner ${captioned.corner}`);
  // Arrow keys move between the two choices, as in any radio group.
  await captionChoice.focus();
  await page.keyboard.press("ArrowUp");
  await expect(fillChoice).toBeChecked();
  await capture("fill-again");
  await page.setViewportSize({ width: 390, height: 844 });
  await captionChoice.evaluate((input) => input.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: output + "fill-narrow.png" });
  await page.getByRole("button", { name: "Update public preview", exact: true }).click();
  await expect(page.getByText("Preview published.", { exact: true })).toBeVisible();
  const fillSettings = (await api("/api/link-preview?page=" + id)).body;
  assert.equal(fillSettings.snapshot.layout, "fill");
  const published = (await api(`/p/${id}/preview.json`)).body;
  const publishedImage = await cornerOf(
    new URL(published.image_url).pathname + new URL(published.image_url).search,
  );
  assert.deepEqual([publishedImage.width, publishedImage.height], [1200, 630]);
  assert.ok(near(publishedImage.corner, fillColour), `published corner ${publishedImage.corner}`);
  const html = await (await page.request.get(origin + "/p/" + id)).text();
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:title" content="Events by surface"/);
  await page.reload();
  await open();
  await expect(fillChoice).toBeChecked();
  console.log(
    "PASS: retained chart pixels through reopen and republish; private bounded sources, including a tall Page image; an uploaded cover fills the published card.",
  );
} catch (error) {
  await page.screenshot({ path: output + "failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (id) await tool("delete_page", { page_id: id, nonce: crypto.randomUUID() }).catch(() => {});
  await browser.close();
}
