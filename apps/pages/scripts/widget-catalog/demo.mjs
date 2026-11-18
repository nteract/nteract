// Seed a persistent Page over the local OAuth / MCP path, then exercise both
// widgets in a new reader session. The only inputs are synthetic counts.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANYWIDGET_MEDIA_TYPE } from "../../shared/anywidget-view.mjs";

const origin = "http://localhost:" + Number(process.env.PAGES_PORT || 9916);
const catalog = "http://127.0.0.1:" + Number(process.env.PAGES_CATALOG_PORT || 9446);
const manifest = await (await fetch(catalog + "/catalog.json")).text();
const pin = createHash("sha256").update(manifest).digest("hex");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const login = await page.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  await page.goto(login.headers().location);
  const callback = origin + "/oauth/test/callback";
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const oauth = { client_id: "pages-local-e2e", redirect_uri: callback, resource: origin + "/mcp" };
  await page.goto(
    origin +
      "/oauth/authorize?" +
      new URLSearchParams({
        ...oauth,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        scope: "pages:read pages:write",
        state,
      }),
  );
  await page.getByRole("button", { name: "Allow access" }).click();
  await page.waitForURL((url) => url.pathname === "/oauth/test/callback");
  const returned = new URL(page.url()).searchParams;
  assert.equal(returned.get("state"), state);
  const response = await page.request.post(origin + "/oauth/token", {
    form: {
      ...oauth,
      grant_type: "authorization_code",
      code: returned.get("code"),
      code_verifier: verifier,
    },
  });
  assert.ok(response.ok(), "Local OAuth code exchange failed");
  const token = (await response.json()).access_token;
  const client = new Client({ name: "Catalog trial", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  const { page_id } = await tool("create_page", {
    title: "Activity explorer · widget imports",
    markdown:
      "Two views share one pinned widget catalog. Explore these illustrative dogfooding counts, then open Sources to inspect the declaration and the two widget modules.",
    nonce: crypto.randomUUID(),
  });
  const link = origin + "/p/" + page_id;
  console.log(link);
  async function edit(operations) {
    const { revision } = await tool("read_page", { page_id });
    return tool("edit_page", { page_id, revision, operations, nonce: crypto.randomUUID() });
  }
  async function source(source_id, name, bytes, content_type) {
    const cap = await tool("create_page_asset_upload", {
      page_id,
      content_type,
      size: bytes.length,
    });
    const uploaded = await fetch(cap.upload_url, {
      method: "POST",
      headers: cap.headers,
      body: bytes,
    });
    assert.ok(uploaded.ok, await uploaded.clone().text());
    const { asset_id } = await uploaded.json();
    await edit([{ op: "set_source", source_id, name, asset_id, source_revision: null }]);
    return asset_id;
  }
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
  // Both widget modules use bare imports. Declaring the catalog while the
  // Page is open must remount them without a view edit or a page reload.
  await expect(page.locator('.pages-anywidget-view[data-output-state="failed"]')).toHaveCount(2, {
    timeout: 30000,
  });
  assert.equal(
    await source(
      "widget-imports",
      "Widget imports · " + pin.slice(0, 8),
      Buffer.from(manifest),
      "application/octet-stream",
    ),
    pin,
  );
  await expect(page.locator('.pages-anywidget-view[data-output-state="ready"]')).toHaveCount(2, {
    timeout: 30000,
  });
  await client.close();
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
    await expect
      .poll(() =>
        off.evaluate(
          (button) =>
            getComputedStyle(button).color === getComputedStyle(document.documentElement).color,
        ),
      )
      .toBe(true);
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
  await page.setViewportSize({ width: 1200, height: 950 });
  await page
    .locator(".sources-line")
    .getByRole("button", { name: /Widget imports/ })
    .click();
  const panel = page.getByRole("dialog", { name: "Sources", exact: true });
  await expect(panel.getByRole("region", { name: "Widget imports" })).toContainText(
    "@nteract/pages-ui",
  );
  await expect(panel).toContainText("Used on this Page · 2");
  console.log("Verified both widgets at wide and narrow widths. " + link);
} finally {
  await browser.close();
}
