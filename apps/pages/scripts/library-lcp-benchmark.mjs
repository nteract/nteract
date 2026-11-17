// The library grid's largest contentful paint on a throttled link. Records
// timings; gates on nothing.
//
// Run through the isolated fixture:
//   node scripts/local-sharing-e2e.mjs --library-lcp
// Options (environment):
//   PAGES_LCP_RUNS   loads to measure (default 5)
//   PAGES_LCP_PAGES  Pages in the library, each with a captured card image
//                    (default 24)
//   PAGES_LCP_HTTP   "2" (default): the proxy serves HTTP/2 over TLS, as the
//                    edge does; "1.1": plain HTTP/1.1, six connections a host
//   PAGES_LCP_REPEAT "1": each measured load follows an unthrottled visit in
//                    the same context, so it starts from that visit's HTTP
//                    cache and the device's remembered rows and cards
//   PAGES_LCP_VARIANTS  name=dir,name=dir: other builds' dist/public
//                    directories, whose viewer the proxy serves in turn (the
//                    Worker stays this build's). Loads interleave, one per
//                    variant per round, so every variant sees the same fixture
//                    and machine load; a busy machine makes separate runs
//                    incomparable. Without it, this build's own viewer.
//   PAGES_LCP_OPEN   "page": each load opens the first Page's address
//                    directly, as a shared link does, instead of the grid,
//                    and records when its editor content shows (no click
//                    load)
//
// The owner creates the Pages, edits each once (which writes its JSON card)
// and opens each, so their own tab captures the card images
// (viewer/card-capture.mjs) as it does in production. Each measured load is
// a new browser context with an empty HTTP cache, signed in by cookie, on the
// grid at 1440x900, throttled to Chrome DevTools' "Fast 4G" preset (9 Mbit/s
// down, 1.5 up, 165 ms latency, each at DevTools' 90%) through CDP. Static
// assets pass through an edge-like brotli proxy (edge-proxy.mjs).
// HTTP/2 matters here: one connection carries every request, where HTTP/1.1
// queues behind six. The throttle shapes each response in the browser, after
// the proxy has sent it at loopback speed, so it shows when requests start
// and how many share the link, but not how an edge's HTTP/2 prioritization
// would split it: `fetchpriority` moves little here.
//
// Per load: LCP (buffered PerformanceObserver) and its element, when the
// first card image finished, when the first screen's shown card images had
// all finished, and when the editor chunk and the WASM started and finished.
// A second load per variant and round clicks the first card the moment a
// card image is reported as LCP, and records how long the Page's editor
// content takes to show after that click: a person who opens a Page as soon
// as the library draws.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startEdgeProxy } from "./edge-proxy.mjs";

const origin = process.env.PAGES_ORIGIN;
assert.ok(origin, "PAGES_ORIGIN is required");
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
assert.ok(output, "PAGES_SCREENSHOTS is required");
await mkdir(output, { recursive: true });
const RUNS = Number(process.env.PAGES_LCP_RUNS || 5);
const PAGES = Number(process.env.PAGES_LCP_PAGES || 24);
const HTTP2 = (process.env.PAGES_LCP_HTTP || "2") === "2";
const REPEAT = process.env.PAGES_LCP_REPEAT === "1";
const PAGE_OPEN = process.env.PAGES_LCP_OPEN === "page";
const VARIANTS = (process.env.PAGES_LCP_VARIANTS || "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [name, dir] = entry.split("=");
    assert.ok(name && dir, `PAGES_LCP_VARIANTS entry ${entry} is name=dir`);
    return { name, dir: path.resolve(dir) };
  });
// Chrome DevTools' "Fast 4G" preset, as its network panel applies it.
const FAST_4G = {
  offline: false,
  latency: 60 * 2.75,
  downloadThroughput: (9 * 1000 * 1000 * 0.9) / 8,
  uploadThroughput: (1.5 * 1000 * 1000 * 0.9) / 8,
};
const VIEWPORT = { width: 1440, height: 900 };
// Every fixture Page's body says this, so the editor that shows it holds the
// opened Page.
const BODY_TEXT = "met on Tuesday";
const report = { completed: [], errors: [], images: [], runs: [], cleaned: false };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Library LCP] ${name}`);
};

let current = null;
const proxy = await startEdgeProxy(origin, { http2: HTTP2, viewer: () => current?.dir ?? null });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    // The HTTP/2 proxy's certificate is self-signed.
    "--ignore-certificate-errors",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});

async function tool(page, operation, args = {}) {
  const response = await page.request.post(origin + "/api/tools", {
    headers: { Origin: origin },
    data: { operation, arguments: args },
  });
  const body = await response.json();
  assert.equal(response.status(), 200, `${operation}: ${JSON.stringify(body)}`);
  return body;
}

// Varied first screens, so the captures differ in size the way people's do.
const TOPICS = ["Launch", "Pricing", "Hiring", "Roadmap", "Research", "Incidents"];
const markdown = (i) => {
  const topic = TOPICS[i % TOPICS.length];
  const parts = [
    `# ${topic} notes, week ${i + 1}`,
    `The ${topic.toLowerCase()} group met on Tuesday. We agreed on **three changes** to the plan and one open question for the next review, with the owners named below.`,
    "- Ship the first draft to the team\n- Collect comments for a week\n- Fold them in and publish",
    "| Item | Owner | Status |\n|:--|:--|--:|\n| Draft | Ana | Done |\n| Review | Kai | 60% |\n| Publish | Lee | Next |",
    "```python\nresults = runs.groupby('week').agg(total=('id', 'count'))\nresults.tail(4)\n```",
  ];
  if (i % 3 === 0)
    parts.splice(
      2,
      0,
      "```mermaid\nflowchart LR\n  Draft --> Review --> Publish\n  Review -->|changes| Draft\n```",
    );
  if (i % 4 === 1)
    parts.splice(2, 0, "> A quote from the last retro that set the tone for this one.");
  return parts.join("\n\n");
};

let ownerContext;
try {
  // ---- Fixture: Pages with captured card images ----------------------------
  ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const owner = await ownerContext.newPage();
  {
    const begin = await ownerContext.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
    assert.equal(begin.status(), 302);
    const authorize = new URL(begin.headers().location);
    authorize.searchParams.set("login_hint", "dev@localhost");
    await owner.goto(authorize.href, { waitUntil: "domcontentloaded" });
    await expect(owner.getByRole("button", { name: /, switch page$/ })).toBeVisible({
      timeout: 60000,
    });
  }
  const ids = [];
  for (let i = 0; i < PAGES; i++) {
    const created = await tool(owner, "create_page", {
      title: `${TOPICS[i % TOPICS.length]} ${i + 1}`,
      markdown: markdown(i),
      nonce: crypto.randomUUID(),
    });
    // The first content change writes the JSON card the image goes with.
    const read = await tool(owner, "read_page", { page_id: created.page_id, comments: "none" });
    await tool(owner, "edit_page", {
      page_id: created.page_id,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          node_id: read.blocks[0].node_id,
          match_text: "notes",
          replacement: "review",
        },
      ],
    });
    ids.push(created.page_id);
  }
  complete(`Created ${PAGES} Pages and wrote their cards`);
  // The owner's tabs capture each Page's card images after a quiet time.
  const cardsFor = async () => (await tool(owner, "page_cards", { page_ids: ids })).cards;
  const tabs = await Promise.all(Array.from({ length: 4 }, () => ownerContext.newPage()));
  for (let i = 0; i < ids.length; i += tabs.length) {
    const batch = ids.slice(i, i + tabs.length);
    await Promise.all(
      batch.map(async (id, j) => {
        await tabs[j].goto(`${origin}/p/${id}`);
        await expect(tabs[j].locator("wg-content").first()).toBeVisible({ timeout: 60000 });
        await expect
          .poll(async () => (await cardsFor())[id]?.image?.card_hash ?? null, {
            timeout: 90000,
            intervals: [500],
          })
          .toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  }
  for (const tab of tabs) await tab.close();
  const cards = await cardsFor();
  report.images = await owner.evaluate(
    async (urls) =>
      Promise.all(
        urls.map(async (url) => {
          const blob = await (await fetch(url, { cache: "no-store" })).blob();
          const bitmap = await createImageBitmap(blob);
          return { bytes: blob.size, type: blob.type, width: bitmap.width, height: bitmap.height };
        }),
      ),
    ids.map((id) => cards[id].image.light),
  );
  const sizes = report.images.map((image) => image.bytes).sort((a, b) => a - b);
  complete(
    `Captured ${report.images.length} card images: ${report.images[0].width}x${report.images[0].height}, ` +
      `${Math.round(sizes[0] / 1024)}-${Math.round(sizes.at(-1) / 1024)} KB`,
  );

  const storageState = await ownerContext.storageState();
  // Each viewer's editor chunk (app.js's one dynamic import) and hashed WASM.
  const files = async ({ dir }) => {
    const read = (name) => readFile(path.join(dir, name), "utf8");
    const html = await read("index.html");
    const app = html.match(/src="\/(app-[A-Z2-7]{8}\.js)"/)[1];
    const source = await read(app);
    const theme = await read(html.match(/src="\/(theme-[A-Z2-7]{8}\.js)"/)[1]);
    const imports = [...source.matchAll(/import\("\.\/(chunks\/[A-Z2-7]{8}\.js)"\)/g)];
    const wasm = (html + source + theme).match(/\/automerge-[A-Z2-7]{8}\.wasm/)?.[0] ?? null;
    assert.ok(imports.length && wasm, `${dir}: no editor chunk or WASM`);
    return { editorChunk: `/${imports[0][1]}`, wasm };
  };
  const variants = VARIANTS.length
    ? VARIANTS
    : [{ name: "this build", dir: path.resolve("dist/public") }];
  for (const variant of variants) Object.assign(variant, await files(variant));

  // ---- Measured loads -------------------------------------------------------
  const INSTRUMENT = () => {
    window.__lcp = [];
    // When the first drawn card joins the document.
    window.__firstCard = null;
    new MutationObserver((_, observer) => {
      if (!document.querySelector(".index-card:not(.index-card-held) .index-card-link")) return;
      window.__firstCard = performance.now();
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__lcp.push({
          time: entry.startTime,
          element: entry.element
            ? `${entry.element.tagName.toLowerCase()}.${[...entry.element.classList].join(".")}`
            : null,
          url: entry.url ? new URL(entry.url).pathname : null,
        });
    }).observe({ type: "largest-contentful-paint", buffered: true });
  };
  // The click load: once armed, the first card image reported as LCP clicks
  // its card, and the editor showing the Page's body ends the measure.
  const CLICK = (text) => {
    window.__clickAt = null;
    window.__editorReady = null;
    // When an editor first shows a fixture Page's body, however it opened.
    window.__contentShown = null;
    new MutationObserver((_, watch) => {
      const shown = [...document.querySelectorAll("wg-content")].some((content) =>
        content.textContent.includes(text),
      );
      if (!shown) return;
      window.__contentShown = performance.now();
      watch.disconnect();
    }).observe(document, { childList: true, subtree: true, characterData: true });
    window.__armClick = () =>
      new PerformanceObserver((list, observer) => {
        const entry = list
          .getEntries()
          .find((candidate) => candidate.element?.matches("img.page-card-image"));
        const link = entry?.element.closest(".index-card-link");
        if (!link) return;
        observer.disconnect();
        window.__clickAt = performance.now();
        link.click();
        new MutationObserver((_, watch) => {
          const shown = [...document.querySelectorAll("wg-content")].some((content) =>
            content.textContent.includes(text),
          );
          if (!shown) return;
          window.__editorReady = performance.now();
          watch.disconnect();
        }).observe(document, { childList: true, subtree: true, characterData: true });
      }).observe({ type: "largest-contentful-paint", buffered: true });
  };
  // What a load opens, and what shows it has drawn.
  const target = PAGE_OPEN ? `${proxy.origin}/p/${ids[0]}` : `${proxy.origin}/?grid=1`;
  const drawn = (page) =>
    PAGE_OPEN
      ? expect
          .poll(() => page.evaluate(() => window.__contentShown), {
            timeout: 120000,
            intervals: [250],
          })
          .not.toBeNull()
      : expect(page.locator("img.page-card-image").first()).toBeVisible({ timeout: 120000 });
  // A new signed-in context on the throttled target; `click` arms the click.
  const openGrid = async (click) => {
    // The Pages session cookie is for localhost, whatever the port and scheme.
    const context = await browser.newContext({
      storageState,
      viewport: VIEWPORT,
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript(INSTRUMENT);
    await context.addInitScript(CLICK, BODY_TEXT);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // The priority Chrome gave each request, by path, after any change.
    const priorities = new Map();
    const byId = new Map();
    cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
      const pathname = new URL(request.url).pathname;
      byId.set(requestId, pathname);
      priorities.set(pathname, request.initialPriority);
    });
    cdp.on("Network.resourceChangedPriority", ({ requestId, newPriority }) => {
      if (byId.has(requestId)) priorities.set(byId.get(requestId), newPriority);
    });
    if (REPEAT) {
      // A visit before, unthrottled: its HTTP cache, and the rows and cards
      // the device keeps, are what the measured load starts from.
      await page.goto(target, { waitUntil: "load", timeout: 120000 });
      await drawn(page);
      await page.waitForTimeout(5000);
    }
    await cdp.send("Network.emulateNetworkConditions", FAST_4G);
    await page.goto(target, { waitUntil: "commit", timeout: 120000 });
    // The init scripts ran; arm before the first paint can report.
    if (click) await page.evaluate(() => window.__armClick());
    return { context, page, priorities };
  };
  for (let run = 1; run <= RUNS; run++)
    for (const variant of variants) {
      current = VARIANTS.length ? variant : null;
      const { editorChunk, wasm } = variant;
      variant.clicks ??= [];
      if (!PAGE_OPEN) {
        const { context, page } = await openGrid(true);
        await expect
          .poll(() => page.evaluate(() => window.__editorReady), {
            timeout: 120000,
            intervals: [250],
          })
          .not.toBeNull();
        const click = await page.evaluate(() => ({
          clickAt: window.__clickAt,
          editorReady: window.__editorReady - window.__clickAt,
        }));
        variant.clicks.push(click);
        console.log(`[Library LCP] ${variant.name} click ${run}: ${JSON.stringify(click)}`);
        await context.close();
      }
      const { context, page, priorities } = await openGrid(false);
      await drawn(page);
      // Let the editor and WASM finish, or give up after a minute.
      await expect
        .poll(
          () =>
            page.evaluate(
              (wasm) =>
                performance
                  .getEntriesByType("resource")
                  .some((entry) => new URL(entry.name).pathname === wasm && entry.responseEnd > 0),
              wasm,
            ),
          { timeout: 60000, intervals: [500] },
        )
        .toBe(true)
        .catch(() => {});
      await page.waitForTimeout(500);
      const sample = await page.evaluate(
        ({ editorChunk, wasm }) => {
          const resources = performance.getEntriesByType("resource");
          const timing = (pathname) => {
            const found = resources.filter((entry) => new URL(entry.name).pathname === pathname);
            return found.length
              ? {
                  start: Math.min(...found.map((entry) => entry.startTime)),
                  end: Math.max(...found.map((entry) => entry.responseEnd)),
                  count: found.length,
                }
              : null;
          };
          const images = resources.filter((entry) =>
            /\/card-image\/[0-9a-f]{64}-(light|dark)\./.test(new URL(entry.name).pathname),
          );
          // The shown images in the first screen, by their element's place.
          const shown = [...document.querySelectorAll("img.page-card-image")].filter(
            (image) =>
              getComputedStyle(image).display !== "none" &&
              image.getBoundingClientRect().top < innerHeight,
          );
          const shownEnds = shown
            .map(
              (image) =>
                resources.find(
                  (entry) => entry.name === image.currentSrc || entry.name === image.src,
                )?.responseEnd,
            )
            .filter((end) => end !== undefined);
          const lcp = window.__lcp.at(-1) ?? null;
          return {
            protocol: resources.find((entry) => entry.nextHopProtocol)?.nextHopProtocol ?? null,
            firstCard: window.__firstCard,
            contentShown: window.__contentShown,
            // A banner over the grid would be measured instead of the grid.
            banner: document.querySelector(".build-update-message")?.textContent ?? null,
            lcp: lcp?.time ?? null,
            lcpElement: lcp?.element ?? null,
            firstImageEnd: images.length
              ? Math.min(...images.map((entry) => entry.responseEnd))
              : null,
            firstScreenImagesEnd: shownEnds.length ? Math.max(...shownEnds) : null,
            firstScreenImages: shown.length,
            imagesFetched: images.length,
            editor: timing(editorChunk),
            wasm: timing(wasm),
            wasmPriority:
              document
                .querySelector('link[rel="preload"][as="fetch"]')
                ?.getAttribute("fetchpriority") ?? null,
          };
        },
        { editorChunk, wasm },
      );
      sample.variant = variant.name;
      // Chrome's network priority for the editor chunk and the WASM; in a
      // repeat visit the HTTP cache may answer without a request.
      sample.networkPriority = {
        editor: priorities.get(editorChunk) ?? null,
        wasm: priorities.get(wasm) ?? null,
      };
      report.runs.push(sample);
      console.log(`[Library LCP] ${variant.name} run ${run}: ${JSON.stringify(sample)}`);
      if (run === 1)
        await page.screenshot({
          path: path.join(output, `library-grid-${variant.name.replace(/\W+/g, "-")}.png`),
        });
      await context.close();
    }
  current = null;
  const median = (values) => {
    const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
    return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
  };
  const medians = (runs, clicks) => ({
    clickAt: median(clicks.map((click) => click.clickAt)),
    editorReadyAfterClick: median(clicks.map((click) => click.editorReady)),
    firstCard: median(runs.map((run) => run.firstCard)),
    contentShown: median(runs.map((run) => run.contentShown)),
    contentShowns: runs.map((run) => Math.round(run.contentShown ?? NaN)),
    lcp: median(runs.map((run) => run.lcp)),
    firstImageEnd: median(runs.map((run) => run.firstImageEnd)),
    firstScreenImagesEnd: median(runs.map((run) => run.firstScreenImagesEnd)),
    editorStart: median(runs.map((run) => run.editor?.start)),
    editorEnd: median(runs.map((run) => run.editor?.end)),
    wasmStart: median(runs.map((run) => run.wasm?.start)),
    wasmEnd: median(runs.map((run) => run.wasm?.end)),
    wasmRequests: Math.max(...runs.map((run) => run.wasm?.count ?? 0)),
    wasmPriorities: [...new Set(runs.map((run) => run.wasmPriority))],
    networkPriorities: [...new Set(runs.map((run) => JSON.stringify(run.networkPriority)))],
    protocols: [...new Set(runs.map((run) => run.protocol))],
    lcpElements: [...new Set(runs.map((run) => run.lcpElement))],
    lcps: runs.map((run) => Math.round(run.lcp)),
    banners: runs.filter((run) => run.banner).length,
  });
  report.medians = Object.fromEntries(
    variants.map(({ name, clicks }) => [
      name,
      medians(
        report.runs.filter((run) => run.variant === name),
        clicks,
      ),
    ]),
  );
  report.clicks = Object.fromEntries(variants.map(({ name, clicks }) => [name, clicks]));
  console.log(JSON.stringify(report.medians, null, 2));
  complete(
    `Measured ${RUNS} throttled loads of ${PAGE_OPEN ? "a Page" : "the grid"} for each of ${variants.length} viewers`,
  );
} catch (error) {
  report.failure = error.stack ?? String(error);
  report.errors.push(error.message);
  throw error;
} finally {
  await browser.close();
  proxy.close();
  report.cleaned = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
