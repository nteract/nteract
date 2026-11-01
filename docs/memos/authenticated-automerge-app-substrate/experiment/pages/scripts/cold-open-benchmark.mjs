// Cold first-open timing for a realistic Page: a few hundred paragraphs, a
// few images and a typed edit history. Records timings; gates on nothing.
//
// Run through the isolated fixture:
//   node scripts/local-sharing-e2e.mjs --cold-open
// Options (environment):
//   PAGES_COLD_RUNS        runs per scenario (default 3)
//   PAGES_COLD_PARAGRAPHS  paragraphs in the Page (default 300)
//   PAGES_COLD_IMAGES      images in the Page (default 6)
//   PAGES_COLD_THROTTLE    "fast3g" (default) or "none"
//   PAGES_COLD_SCENARIOS   "cold,first" (default), or one of them
//   PAGES_COLD_SUBDUCTION_LOG  a Subduction log level to capture, e.g. "debug"
//
// Each run opens the Page in a new browser context: an empty HTTP cache, no
// IndexedDB and no local replica, signed in by cookie only. Two scenarios:
//   cold  - nothing cached: HTML, scripts, WASM and the Page all download.
//   first - the app was opened before (home page loaded and cached), but this
//           Page never was. This is "a Page I've never opened on my phone".
// Throttling uses the Chrome DevTools "Fast 3G" preset (562.5 ms RTT,
// 180 kB/s down, 84.4 kB/s up) and a 4x CPU slowdown, through CDP.
//
// Static assets pass through a loopback proxy that compresses like the
// Cloudflare edge (brotli for text and WASM), since celld dev serves them
// uncompressed and Fast 3G would otherwise measure bytes no user downloads.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { brotliCompressSync, deflateRawSync, constants as zlib } from "node:zlib";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
await mkdir(output, { recursive: true });
const RUNS = Number(process.env.PAGES_COLD_RUNS || 3);
const PARAGRAPHS = Number(process.env.PAGES_COLD_PARAGRAPHS || 300);
const IMAGES = Number(process.env.PAGES_COLD_IMAGES || 6);
const THROTTLE = process.env.PAGES_COLD_THROTTLE || "fast3g";
const SCENARIOS = (process.env.PAGES_COLD_SCENARIOS || "cold,first").split(",");
// Subduction reads its log level from localStorage at WASM start.
const SUBDUCTION_LOG = process.env.PAGES_COLD_SUBDUCTION_LOG;
const FAST_3G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1.6 * 1000 * 1000 * 0.9) / 8,
  uploadThroughput: (750 * 1000 * 0.9) / 8,
};
const report = { completed: [], errors: [], runs: [], cleaned: false };

// ---- Edge-like compressing proxy ------------------------------------------
const upstream = new URL(origin);
const compressible = /^(text\/|application\/(javascript|json|wasm)|image\/svg)/;
const brotliCache = new Map();
const proxy = http.createServer((request, response) => {
  const headers = { ...request.headers, host: upstream.host };
  // The Worker checks Origin against its configured public origin.
  if (headers.origin) headers.origin = origin;
  if (headers.referer) headers.referer = headers.referer.replace(/^http:\/\/[^/]+/, origin);
  delete headers["accept-encoding"];
  const forward = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers,
    },
    (reply) => {
      const type = String(reply.headers["content-type"] || "");
      const wantsBrotli = /\bbr\b/.test(String(request.headers["accept-encoding"] || ""));
      const replyHeaders = { ...reply.headers };
      if (replyHeaders.location)
        replyHeaders.location = replyHeaders.location.replace(origin, proxyOrigin);
      if (!wantsBrotli || !compressible.test(type) || reply.headers["content-encoding"]) {
        response.writeHead(reply.statusCode, replyHeaders);
        reply.pipe(response);
        return;
      }
      const parts = [];
      reply.on("data", (part) => parts.push(part));
      reply.on("end", () => {
        const body = Buffer.concat(parts);
        const key = request.url + "\0" + body.length;
        let compressed = brotliCache.get(key);
        if (!compressed || !body.equals(compressed.source)) {
          compressed = {
            source: body,
            bytes: brotliCompressSync(body, {
              params: {
                [zlib.BROTLI_PARAM_QUALITY]: 9,
                [zlib.BROTLI_PARAM_SIZE_HINT]: body.length,
              },
            }),
          };
          brotliCache.set(key, compressed);
        }
        delete replyHeaders["content-length"];
        delete replyHeaders["transfer-encoding"];
        response.writeHead(reply.statusCode, {
          ...replyHeaders,
          "content-encoding": "br",
          "content-length": compressed.bytes.length,
        });
        response.end(compressed.bytes);
      });
    },
  );
  forward.on("error", () => response.destroy());
  request.pipe(forward);
});
proxy.on("upgrade", (request, socket, head) => {
  const target = net.connect(Number(upstream.port), upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i];
      let value = request.rawHeaders[i + 1];
      if (/^host$/i.test(name)) value = upstream.host;
      if (/^origin$/i.test(name)) value = origin;
      lines.push(`${name}: ${value}`);
    }
    target.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    target.destroy();
  };
  target.on("error", close);
  socket.on("error", close);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyOrigin = `http://localhost:${proxy.address().port}`;

// ---- Fixture Page -----------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Cold open] ${name}`);
};
// Each Pages block has its own editor; the sentinel sits in the last one.
const content = (page) => page.locator("wg-content").first();
const sentinelShown = (page, timeout) =>
  expect(page.locator("wg-content", { hasText: SENTINEL })).toHaveCount(1, { timeout });
async function call(page, operation, args = {}) {
  const response = await page.request.post(origin + "/api/tools", {
    headers: { Origin: origin, "X-Pages-Driver": "Cold-open fixture" },
    data: { operation, arguments: args },
  });
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}
const retry = (value) => ({
  retry_token: value.retry_token,
  idempotency_key: value.retry_key_prefix + crypto.randomUUID(),
});
const sentence = (i) =>
  `Paragraph ${i + 1}. Shared documents keep their history so people and agents can pick up where the last edit left off; this one adds a little more prose for the sync to carry.`;
const SENTINEL = `Final paragraph ${PARAGRAPHS} closes the fixture.`;

const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ownerPage = await owner.newPage();
ownerPage.on("pageerror", (error) => report.errors.push(`owner: ${error.message}`));
{
  const begin = await owner.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", "cold-open@example.com");
  await ownerPage.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(ownerPage.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
}
const created = await call(ownerPage, "create_page", {
  title: "Cold open fixture",
  markdown: Array.from({ length: 20 }, (_, i) => sentence(i)).join("\n\n"),
  ...retry(await call(ownerPage, "list_pages")),
});
const pageId = created.page_id;
// Grow it in many small agent edits, then type in the browser, so the
// document carries a history like an edited Page instead of one import.
for (let next = 20; next < PARAGRAPHS - 1; next += 10) {
  const read = await call(ownerPage, "read_page", { page_id: pageId });
  const markdown = Array.from({ length: Math.min(10, PARAGRAPHS - 1 - next) }, (_, i) =>
    sentence(next + i),
  ).join("\n\n");
  await call(ownerPage, "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    ...retry(read),
    operations: [{ op: "insert_markdown", markdown }],
  });
}
{
  const read = await call(ownerPage, "read_page", { page_id: pageId });
  await call(ownerPage, "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    ...retry(read),
    operations: [{ op: "insert_markdown", markdown: SENTINEL }],
  });
}
const pictures = await ownerPage.evaluate(async (count) => {
  const out = [];
  for (let n = 0; n < count; n++) {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 700;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 1200, 700);
    gradient.addColorStop(0, `hsl(${n * 50}, 70%, 60%)`);
    gradient.addColorStop(1, `hsl(${n * 50 + 120}, 70%, 40%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1200, 700);
    // Some texture so the PNG is screenshot-sized, not a few kilobytes.
    for (let i = 0; i < 600; i++) {
      ctx.fillStyle = `hsla(${(i * 37) % 360}, 60%, 50%, 0.4)`;
      ctx.fillRect((i * 97) % 1200, (i * 53) % 700, 6 + (i % 9), 6 + (i % 7));
    }
    ctx.font = "48px sans-serif";
    ctx.fillStyle = "white";
    ctx.fillText(`Figure ${n + 1}`, 60, 120);
    out.push(canvas.toDataURL("image/png").split(",")[1]);
  }
  return out;
}, IMAGES);
const imageBytes = [];
for (const [n, base64] of pictures.entries()) {
  const bytes = Buffer.from(base64, "base64");
  imageBytes.push(bytes.length);
  const uploaded = await owner.request.post(`${origin}/api/pages/${pageId}/assets`, {
    headers: { Origin: origin, "Content-Type": "image/png" },
    data: bytes,
  });
  assert.ok([200, 201].includes(uploaded.status()), await uploaded.text());
  const asset = await uploaded.json();
  const read = await call(ownerPage, "read_page", { page_id: pageId });
  const blocks = read.blocks;
  await call(ownerPage, "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    ...retry(read),
    operations: [
      {
        op: "insert_image",
        asset_id: asset.asset_id,
        alt: `Figure ${n + 1}`,
        after_block_id: blocks[Math.floor(((n + 1) * blocks.length) / (IMAGES + 1))].id,
      },
    ],
  });
}
await ownerPage.goto(`${origin}/p/${pageId}`);
await sentinelShown(ownerPage, 60000);
await content(ownerPage).getByText("Paragraph 3.", { exact: false }).first().click();
await ownerPage.keyboard.press("End");
await ownerPage.keyboard.type(
  " Typed by hand to give the history some keystroke-sized changes.".repeat(5),
  {
    delay: 5,
  },
);
await expect(ownerPage.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible(
  {
    timeout: 60000,
  },
);
const fixture = await call(ownerPage, "read_page", { page_id: pageId });
report.fixture = {
  page_id: pageId,
  paragraphs: PARAGRAPHS,
  blocks: fixture.blocks.length,
  images: IMAGES,
  image_bytes: imageBytes,
  markdown_bytes: fixture.blocks.reduce((sum, block) => sum + block.markdown.length, 0),
};
complete(`Fixture Page ${pageId}: ${JSON.stringify(report.fixture)}`);
const cookies = (await owner.cookies()).filter((cookie) => cookie.domain === "localhost");
await ownerPage.close();

// ---- Measurement --------------------------------------------------------------
// Installed before any page script. Records the moments resource timing
// can't see: WASM compile, IndexedDB opens, the sync socket, first content.
const INSTRUMENT = `(() => {
  const t = () => performance.now();
  const log = (window.__cold = { idb: [], wasm: [], sockets: [], marks: {} });
  const mark = (name) => { if (!(name in log.marks)) log.marks[name] = t(); };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name, ...rest) {
    const entry = { name, start: t() };
    log.idb.push(entry);
    const request = open.call(this, name, ...rest);
    request.addEventListener("success", () => (entry.end = t()));
    return request;
  };
  for (const key of ["instantiate", "instantiateStreaming", "compile", "compileStreaming"]) {
    const original = WebAssembly[key];
    if (!original) continue;
    WebAssembly[key] = function (...args) {
      const entry = { key, start: t() };
      log.wasm.push(entry);
      return original.apply(this, args).then((value) => ((entry.end = t()), value));
    };
  }
  const Native = WebSocket;
  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      const entry = { url: String(args[0]).replace(/\\?.*/, ""), start: t(), frames: 0, bytes: 0 };
      log.sockets.push(entry);
      socket.addEventListener("open", () => {
        entry.open = t();
        entry.extensions = socket.extensions;
      });
      entry.timeline = [];
      const send = socket.send;
      socket.send = function (data) {
        entry.timeline.push([Math.round(t()), "out", data?.byteLength ?? data?.length ?? 0]);
        return send.call(this, data);
      };
      socket.addEventListener("message", (event) => {
        if ((event.data?.byteLength ?? 0) > 2048 || entry.timeline.length < 40)
          entry.timeline.push([Math.round(t()), "in", event.data?.byteLength ?? 0]);
        entry.frames++;
        entry.bytes += event.data?.byteLength ?? 0;
        entry.firstFrame ??= t();
        entry.lastFrame = t();
      });
      socket.addEventListener("close", () => (entry.close = t()));
      return socket;
    },
  });
  const sentinel = ${JSON.stringify(SENTINEL)};
  const observer = new MutationObserver(() => {
    if (!("previewContent" in log.marks)) {
      const preview = document.querySelector(".page-preview .preview-content");
      if (preview && preview.textContent.includes("Paragraph 1.")) mark("previewContent");
    }
    if (!("firstContent" in log.marks)) {
      const first = document.querySelector("wg-content");
      if (first && first.textContent.includes("Paragraph 1.")) mark("firstContent");
    }
    if (!("fullContent" in log.marks)) {
      const editors = document.querySelectorAll("wg-content");
      const last = editors[editors.length - 1];
      if (last && last.textContent.includes(sentinel)) mark("fullContent");
    }
    if ("fullContent" in log.marks) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
})();`;

async function measure(scenario, run) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: false,
  });
  await context.addCookies(cookies.map((cookie) => ({ ...cookie, domain: "localhost" })));
  await context.addInitScript(INSTRUMENT);
  if (SUBDUCTION_LOG)
    await context.addInitScript(
      `localStorage.setItem("SUBDUCTION_LOG_LEVEL", ${JSON.stringify(SUBDUCTION_LOG)})`,
    );
  const page = await context.newPage();
  const errors = [];
  const consoleLines = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const opened = Date.now();
  page.on("console", (message) => {
    if (SUBDUCTION_LOG || ["error", "warning"].includes(message.type()))
      consoleLines.push(
        `${Date.now() - opened} ${message.type()}: ${message.text().replace(/%c/g, "").slice(0, 300)}`,
      );
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // Sync frames as the wire carries them, to report how much a compressed
  // socket would save. The page's own socket has no permessage-deflate.
  const frames = [];
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode === 2) frames.push(Buffer.from(response.payloadData, "base64"));
  });
  if (THROTTLE === "fast3g") {
    await cdp.send("Network.emulateNetworkConditions", FAST_3G);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  if (scenario === "first") {
    // The app was used on this device before: its shell and runtimes are in
    // the HTTP cache. This Page never was opened here.
    await page.goto(proxyOrigin + "/", { waitUntil: "load", timeout: 180000 });
    await page.waitForLoadState("networkidle", { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const started = Date.now();
  await page.goto(`${proxyOrigin}/p/${pageId}`, { waitUntil: "commit", timeout: 180000 });
  if (run === 1)
    await page
      .locator(".page-preview")
      .waitFor({ timeout: 30000 })
      .then(() => page.screenshot({ path: path.join(output, `${scenario}-preview.png`) }))
      .catch(() => {});
  await sentinelShown(page, 180000);
  const wall = Date.now() - started;
  if (run === 1) await page.screenshot({ path: path.join(output, `${scenario}-editor.png`) });
  await page.waitForTimeout(250);
  const timings = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation").at(-1);
    const resources = performance.getEntriesByType("resource").map((entry) => ({
      name: new URL(entry.name).pathname,
      start: entry.startTime,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
      end: entry.responseEnd,
      transfer: entry.transferSize,
      encoded: entry.encodedBodySize,
    }));
    return {
      navStart: 0,
      htmlEnd: nav.responseEnd,
      domContentLoaded: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      resources,
      cold: window.__cold,
    };
  });
  await context.close();
  const wire = Buffer.concat(frames);
  const framing = {
    frames: frames.length,
    bytes: wire.length,
    deflated: frames.reduce((sum, frame) => sum + deflateRawSync(frame).length, 0),
    largest: frames.reduce((max, frame) => Math.max(max, frame.length), 0),
  };
  return { scenario, run, wall, errors, console: consoleLines, timings, framing };
}

/** Collapse one run's records into the phases the report tabulates. */
function phases({ timings }) {
  const { resources, cold } = timings;
  const find = (pattern) => resources.filter((entry) => pattern.test(entry.name));
  const span = (entries) =>
    entries.length
      ? {
          start: Math.min(...entries.map((e) => e.start)),
          end: Math.max(...entries.map((e) => e.end)),
        }
      : null;
  const scripts = span(find(/^\/(app-[A-Z2-7]{8}\.js|chunks\/)/));
  const wasmDownload = span(find(/\.wasm$/));
  const wasmCompile = cold.wasm.length
    ? {
        start: Math.min(...cold.wasm.map((e) => e.start)),
        end: Math.max(...cold.wasm.map((e) => e.end ?? 0)),
      }
    : null;
  const session = span(find(/^\/api\/auth\/session$/));
  const connect = span(find(/^\/api\/connect$/));
  const images = span(find(/\/assets\/[0-9a-f]{64}$/));
  const socket = cold.sockets.find((entry) => entry.url.endsWith("/api/sync"));
  const idb = cold.idb.filter((entry) => entry.end);
  return {
    html: timings.htmlEnd,
    scripts: scripts && scripts.end,
    scriptsStart: scripts && scripts.start,
    wasmDownloaded: wasmDownload && wasmDownload.end,
    wasmReady: wasmCompile && wasmCompile.end,
    sessionStart: session && session.start,
    sessionEnd: session && session.end,
    connectStart: connect && connect.start,
    connectEnd: connect && connect.end,
    socketStart: socket?.start,
    socketOpen: socket?.open,
    firstFrame: socket?.firstFrame,
    lastFrameBeforeRender:
      socket && cold.marks.fullContent
        ? Math.min(socket.lastFrame, cold.marks.fullContent)
        : undefined,
    syncBytes: socket?.bytes,
    syncFrames: socket?.frames,
    syncExtensions: socket?.extensions,
    idbOpens: idb.length,
    idbFirstStart: idb.length ? Math.min(...idb.map((e) => e.start)) : undefined,
    idbTotalMs: idb.reduce((sum, e) => sum + (e.end - e.start), 0),
    // The read-only preview (viewer/PagePreview.jsx), when this build has one.
    previewContent: cold.marks.previewContent,
    firstContent: cold.marks.firstContent,
    fullContent: cold.marks.fullContent,
    imagesEnd: images && images.end,
    bytes: resources.reduce((sum, e) => sum + (e.transfer || 0), 0),
  };
}

try {
  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= RUNS; run++) {
      const result = await measure(scenario, run);
      result.phases = phases(result);
      report.runs.push(result);
      complete(
        `${scenario} #${run}: full content at ${Math.round(result.phases.fullContent)} ms (wall ${result.wall} ms) ${JSON.stringify(
          Object.fromEntries(
            Object.entries(result.phases).map(([key, value]) => [
              key,
              typeof value === "number" ? Math.round(value) : value,
            ]),
          ),
        )}`,
      );
      console.log("  wire:", JSON.stringify(result.framing));
      if (result.console.length && !SUBDUCTION_LOG)
        console.log("  console:", result.console.join(" | "));
    }
  }
  const median = (values) => {
    const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
    return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
  };
  report.medians = {};
  for (const scenario of SCENARIOS) {
    const runs = report.runs.filter((run) => run.scenario === scenario).map((run) => run.phases);
    report.medians[scenario] = Object.fromEntries(
      Object.keys(runs[0]).map((key) => [key, median(runs.map((run) => run[key]))]),
    );
  }
  console.log("[Cold open] medians", JSON.stringify(report.medians, null, 2));
  report.cleaned = true;
} catch (error) {
  report.failure = String(error?.stack ?? error);
  throw error;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  proxy.close();
}
