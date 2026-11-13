// Grid card images on a real local host (worker/card-images.mjs,
// viewer/card-capture.mjs). The owner opens a Page whose first screen has a
// heading, a Mermaid diagram, a dataframe and code; their tab draws the card
// shell in light and dark and uploads both. The owner's grid then shows the
// image from the card-image route instead of the JSON card. A member sees
// it too, a stranger can't fetch it, and removing the member stops her
// fetches on the next request. A second Page opens with a chart: the shell
// draws it from the Page's view and source before it rasterizes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-card-images";
const shots = process.env.PAGES_CARD_SHOTS || output;
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const report = { completed: [], errors: [], captures: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Card images E2E] ${name}`);
};
const browser = await chromium.launch({ headless: true });
const PARQUET = "application/vnd.apache.parquet";
const VEGA_LITE = "application/vnd.vegalite.v6+json";
// A real two-row, three-column table (day, surface, events) written by pyarrow.
const parquet =
  "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==";

async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
/** Fetch a card image route from `page`, never from the browser cache. */
const fetchImage = (page, url) =>
  page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      nosniff: response.headers.get("x-content-type-options"),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  }, url);

async function signIn(email, viewport = { width: 1280, height: 900 }, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  // Each capture's shell, read as it rasterizes (card-shell.mjs measures
  // `pages-card-capture` while the shell is still mounted): the status of
  // each chart in it and how many marks it drew.
  await context.addInitScript(() => {
    const measure = performance.measure.bind(performance);
    window.__cardShellCharts = [];
    performance.measure = (name, ...rest) => {
      if (name === "pages-card-capture")
        for (const frame of document.querySelectorAll("iframe")) {
          const shell = frame.contentDocument?.querySelector(".card-shell");
          if (!shell) continue;
          window.__cardShellCharts.push(
            [...shell.querySelectorAll("figure.pages-chart:not(.pages-view-placeholder)")].map(
              (figure) => ({
                status: figure.dataset.chartStatus,
                marks: figure.querySelectorAll(".pages-chart-canvas path[role='graphics-symbol']")
                  .length,
              }),
            ),
          );
        }
      return measure(name, ...rest);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${email}: ${error.stack}`));
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  return page;
}

async function openGrid(page) {
  await page.goto(`${origin}/?grid=1`);
  await page.evaluate(() => {
    localStorage.setItem("nteract.pages.view", "grid");
  });
  await page.reload();
  await expect(page.locator("ul.index-grid").first()).toBeVisible({ timeout: 30000 });
}
const card = (page, title) =>
  page
    .locator(".index-card-link")
    .filter({ has: page.locator(`.index-card-title[title="${title}"]`) });
const shoot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, name) });
};

const TITLE = "Card capture";
const MARKDOWN = [
  "# Weekly usage review",
  "```mermaid\nflowchart LR\n  Owner[Owner tab] -->|card_hash changed| Shell(Card shell)\n  Shell --> Raster{Rasterize}\n  Raster -->|WebP| Bucket[(R2)]\n  Bucket --> Grid[Grid card]\n```",
].join("\n\n");
const CODE = "```python\nweekly = usage.groupby('week').agg(active=('page_id', 'nunique'))\n```";

let owner, alice, stranger, phone;
try {
  owner = await signIn("dev@localhost", undefined, { deviceScaleFactor: 2 });
  alice = await signIn("alice@localhost");
  stranger = await signIn("bob@localhost");
  const alicePrincipal = (await api(alice, "/api/auth/session")).body.identity.principal;

  const created = await tool(owner, "create_page", {
    title: TITLE,
    markdown: MARKDOWN,
    nonce: crypto.randomUUID(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const pageId = created.body.page_id;
  // A dataframe and code after the diagram, as an agent would add them.
  const dataset = await owner.evaluate(
    async ({ pageId, parquet, type }) => {
      const bytes = Uint8Array.from(atob(parquet), (c) => c.charCodeAt(0));
      const response = await fetch(`/api/pages/${pageId}/assets`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: bytes,
      });
      return { status: response.status, body: await response.json() };
    },
    { pageId, parquet, type: PARQUET },
  );
  assert.equal(dataset.status, 201, JSON.stringify(dataset.body));
  const read = await tool(owner, "read_page", { page_id: pageId, comments: "none" });
  const edited = await tool(owner, "edit_page", {
    page_id: pageId,
    revision: read.body.revision,
    nonce: crypto.randomUUID(),
    operations: [
      {
        op: "insert_node",
        node: {
          type: "dataframe",
          attrs: { asset_id: dataset.body.asset_id, title: "Usage by day" },
        },
      },
      { op: "insert_markdown", markdown: CODE },
    ],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  complete("A Page with a heading, Mermaid, a dataframe and code");

  // No image until the owner's tab draws one.
  const none = await api(owner, `/api/pages/${pageId}/card-image`);
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.equal(none.body.card_hash, null);

  // The owner opens it; the tab captures after its quiet time.
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(owner.locator(".wordgard-diagram-canvas > svg").first()).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(async () => (await api(owner, `/api/pages/${pageId}/card-image`)).body.card_hash, {
      timeout: 60000,
      intervals: [500],
    })
    .toMatch(/^[0-9a-f]{64}$/);
  report.captures = await owner.evaluate(() =>
    performance
      .getEntriesByName("pages-card-capture")
      .map((entry) => ({ ms: Math.round(entry.duration), ...entry.detail })),
  );
  assert.equal(report.captures.length, 2, JSON.stringify(report.captures));
  assert.deepEqual(
    report.captures.map((capture) => capture.theme),
    ["light", "dark"],
  );
  // The dataframe drew in the shell: its rows are in neither the JSON card
  // nor the title, so a capture without them would look like the JSON card.
  complete(
    `The owner's tab captured light and dark (${report.captures.map((c) => c.ms).join(" ms, ")} ms)`,
  );

  // page_cards names the images once the JSON card has the same hash; the
  // accepted upload asked the host's card writer to catch up.
  let image;
  await expect
    .poll(
      async () => {
        const answer = await tool(owner, "page_cards", { page_ids: [pageId] });
        image = answer.body.cards[pageId]?.image;
        return image?.card_hash ?? null;
      },
      { timeout: 30000, intervals: [500] },
    )
    .toMatch(/^[0-9a-f]{64}$/);
  const route = new RegExp(
    `^/api/pages/${pageId}/card-image/${image.card_hash}-(light|dark)\\.(webp|png)$`,
  );
  assert.match(image.light, route);
  assert.match(image.dark, route);
  const served = await fetchImage(owner, image.light);
  assert.equal(served.status, 200);
  assert.match(served.type, /^image\/(webp|png)$/);
  assert.equal(served.cache, "private, max-age=86400, immutable");
  assert.equal(served.nosniff, "nosniff");
  assert.ok(served.bytes > 1000 && served.bytes <= 300 * 1024, String(served.bytes));
  complete("page_cards names both images; the route serves them privately");

  await owner.emulateMedia({ colorScheme: "light" });
  await openGrid(owner);
  const lightImage = card(owner, TITLE).locator('img.page-card-image[data-theme="light"]');
  await expect(lightImage).toBeVisible({ timeout: 30000 });
  await expect(lightImage).toHaveAttribute("src", image.light);
  await expect
    .poll(() => lightImage.evaluate((img) => img.complete && img.naturalWidth), { timeout: 15000 })
    .toBe(1280);
  await expect(card(owner, TITLE).locator('img.page-card-image[data-theme="dark"]')).toBeHidden();
  await shoot(owner, "card-images-desktop-light.png");
  await card(owner, TITLE).screenshot({ path: path.join(shots, "card-images-card-light.png") });
  complete("The owner's grid shows the light image, not the JSON card");

  await owner.emulateMedia({ colorScheme: "dark" });
  await owner.reload();
  await expect(owner.locator("html")).toHaveClass(/dark/);
  const darkImage = card(owner, TITLE).locator('img.page-card-image[data-theme="dark"]');
  await expect(darkImage).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => darkImage.evaluate((img) => img.complete && img.naturalWidth), { timeout: 15000 })
    .toBe(1280);
  await shoot(owner, "card-images-desktop-dark.png");
  await card(owner, TITLE).screenshot({ path: path.join(shots, "card-images-card-dark.png") });
  complete("Dark theme shows the dark image");

  phone = await signIn(
    "dev@localhost",
    { width: 390, height: 844 },
    { isMobile: true, hasTouch: true },
  );
  await openGrid(phone);
  await expect(card(phone, TITLE).locator('img.page-card-image[data-theme="light"]')).toBeVisible({
    timeout: 30000,
  });
  await shoot(phone, "card-images-phone.png");
  complete("The image card renders on a phone-sized screen");

  // A stranger can't fetch it.
  const refused = await fetchImage(stranger, image.light);
  assert.ok([403, 404].includes(refused.status), JSON.stringify(refused));
  assert.equal(refused.type?.startsWith("image/"), false);
  assert.equal((await api(stranger, `/api/pages/${pageId}/card-image`)).body.card_hash, undefined);
  complete("A stranger can't fetch the image or its hash");

  // Share with alice; she opens it once, which lists it, then her grid shows
  // the image.
  const access = async (action) => {
    const current = await api(owner, `/api/access?page=${pageId}`);
    const result = await api(owner, `/api/access?page=${pageId}`, {
      ...action,
      expected_revision: current.body.access.revision,
      nonce: crypto.randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await access({ action: "invite", email: "alice@localhost", role: "viewer" });
  await alice.goto(`${origin}/p/${pageId}`);
  await expect(alice.locator("wg-content").first()).toContainText("Weekly usage review", {
    timeout: 30000,
  });
  const forAlice = await tool(alice, "page_cards", { page_ids: [pageId] });
  assert.equal(forAlice.body.principal, alicePrincipal);
  assert.deepEqual(forAlice.body.cards[pageId].image, image);
  assert.equal((await fetchImage(alice, image.dark)).status, 200);
  // A member's tab never uploads.
  const memberUpload = await alice.evaluate(
    async ({ pageId, hash }) =>
      (
        await fetch(`/api/pages/${pageId}/card-image?hash=${hash}&theme=light`, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: new Uint8Array(16),
        })
      ).status,
    { pageId, hash: image.card_hash },
  );
  assert.ok([403, 415].includes(memberUpload), String(memberUpload));
  await openGrid(alice);
  await expect(card(alice, TITLE).locator('img.page-card-image[data-theme="light"]')).toBeVisible({
    timeout: 30000,
  });
  await shoot(alice, "card-images-member.png");
  complete("The member's grid shows the image");

  await access({ action: "set_role", principal: alicePrincipal, role: null });
  const revoked = await fetchImage(alice, image.light);
  assert.ok([403, 404].includes(revoked.status), JSON.stringify(revoked));
  const after = await tool(alice, "page_cards", { page_ids: [pageId] });
  assert.deepEqual(after.body.cards, { [pageId]: null });
  complete("After removal, the member's next image fetch is refused");

  // A Page whose first screen is a chart: a source, a view over it, and the
  // view node under a heading and a line of text.
  const chartPage = await tool(owner, "create_page", {
    title: "Chart card",
    markdown: "# Events by surface\n\nEach surface's events over two days.",
    nonce: crypto.randomUUID(),
  });
  assert.equal(chartPage.status, 200, JSON.stringify(chartPage.body));
  const chartId = chartPage.body.page_id;
  const chartData = await owner.evaluate(
    async ({ pageId, parquet, type }) => {
      const bytes = Uint8Array.from(atob(parquet), (c) => c.charCodeAt(0));
      const response = await fetch(`/api/pages/${pageId}/assets`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: bytes,
      });
      return { status: response.status, body: await response.json() };
    },
    { pageId: chartId, parquet, type: PARQUET },
  );
  assert.equal(chartData.status, 201, JSON.stringify(chartData.body));
  for (const operation of [
    {
      op: "set_source",
      source_id: "usage",
      name: "usage",
      asset_id: chartData.body.asset_id,
      source_revision: null,
    },
    {
      op: "set_view",
      view_id: "by_surface",
      title: "Events by surface",
      media_type: VEGA_LITE,
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
    { op: "insert_node", node: { type: "view", attrs: { view_id: "by_surface" } } },
  ]) {
    const current = await tool(owner, "read_page", { page_id: chartId, comments: "none" });
    const result = await tool(owner, "edit_page", {
      page_id: chartId,
      revision: current.body.revision,
      nonce: crypto.randomUUID(),
      operations: [operation],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  await owner.evaluate(() => (window.__cardShellCharts = []));
  await owner.goto(`${origin}/p/${chartId}`);
  await expect(
    owner.locator('figure.pages-chart[data-chart-status="rendered"]').first(),
  ).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await api(owner, `/api/pages/${chartId}/card-image`)).body.card_hash, {
      timeout: 60000,
      intervals: [500],
    })
    .toMatch(/^[0-9a-f]{64}$/);
  report.chartShells = await owner.evaluate(() => window.__cardShellCharts);
  assert.equal(report.chartShells.length, 2, JSON.stringify(report.chartShells));
  for (const charts of report.chartShells) {
    assert.equal(charts.length, 1, JSON.stringify(report.chartShells));
    assert.equal(charts[0].status, "rendered", JSON.stringify(report.chartShells));
    assert.equal(charts[0].marks, 2, JSON.stringify(report.chartShells));
  }
  let chartImage;
  await expect
    .poll(
      async () => {
        const answer = await tool(owner, "page_cards", { page_ids: [chartId] });
        chartImage = answer.body.cards[chartId]?.image;
        return chartImage?.card_hash ?? null;
      },
      { timeout: 30000, intervals: [500] },
    )
    .toMatch(/^[0-9a-f]{64}$/);
  for (const theme of ["light", "dark"]) {
    const bytes = await owner.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, chartImage[theme]);
    const ext = chartImage[theme].split(".").at(-1);
    await writeFile(path.join(shots, `card-images-chart-${theme}.${ext}`), Uint8Array.from(bytes));
  }
  complete("A chart on the first screen draws in both card images");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack ?? String(error);
  report.errors.push(error.message);
  for (const [name, page] of [
    ["owner", owner],
    ["alice", alice],
    ["phone", phone],
  ])
    if (page)
      await page.screenshot({ path: path.join(output, `failure-${name}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  report.cleaned = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
