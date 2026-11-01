// Deploy-while-open qualification against an isolated local celld.
// Run through `node scripts/local-sharing-e2e.mjs --build-update`. The harness
// owns celld and, on request over IPC, restarts it with the Worker and viewer
// assets moved to another build id: a deploy under an open tab.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-build-update-browser";
await mkdir(output, { recursive: true });
assert.equal(typeof process.send, "function", "run through local-sharing-e2e.mjs --build-update");

const report = { completed: [], errors: [] };
const browser = await chromium.launch({ headless: true });
let owner, pageId, diagramId;

function deploy(build) {
  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type === "celld-restarted") resolve();
      else if (message?.type === "celld-restart-failed") reject(new Error(message.message));
      else return;
      process.off("message", listener);
    };
    process.on("message", listener);
    process.send({ type: "restart-celld", build });
  });
}
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        build: response.headers.get("X-Pages-Build"),
        minViewerProtocol: response.headers.get("X-Pages-Min-Viewer-Protocol"),
        body: await response.json(),
      };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
// Record the text of every red banner that appears, however briefly, so a
// deploy's restart can be checked for one after the fact.
const recordBanners = () => {
  window.__pagesBanners = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const alert of document.querySelectorAll(".error[role=alert]")) {
      if (seen.has(alert)) continue;
      seen.add(alert);
      window.__pagesBanners.push(alert.textContent);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
};
const redBanners = (page) => page.evaluate(() => window.__pagesBanners);
async function signIn(email) {
  const context = await browser.newContext();
  await context.addInitScript(recordBanners);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
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
/** Click Reload and wait for the document itself to be replaced. */
async function reloadFromBanner(page) {
  await page.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await page.locator(".build-update").getByRole("button", { name: "Reload" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pagesBeforeReload ?? false).catch(() => true), {
      timeout: 30000,
    })
    .toBe(false);
  await page.waitForLoadState("domcontentloaded");
}

/** The viewer's entry script as the current index.html names it. Every
 * hashed file is served immutable; index.html revalidates on each visit. */
async function viewerEntry() {
  const index = await fetch(`${origin}/`);
  assert.match(index.headers.get("cache-control") ?? "", /must-revalidate/);
  const src = /<script type="module" src="(\/app-[A-Z2-7]{8}\.js)">/.exec(await index.text())?.[1];
  assert.ok(src, "index.html loads a content-hashed app.js");
  const response = await fetch(origin + src);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  return { path: src, source: await response.text() };
}

const content = (page) => page.locator(".page-block wg-content");
const saved = (page) => page.locator(".save-status--saved");
const banner = (page) => page.locator(".build-update");
const paragraph = (page, text, options = {}) =>
  expect(content(page)).toHaveText(text, { useInnerText: true, ...options });
/** Where Wordgard's own selection and the DOM caret sit in the Page text. */
const carets = (page) =>
  content(page).evaluate((root) => {
    const editor = root.closest(".wordgard-document").wg;
    const { anchor, head } = editor.state.selection;
    const dom = getSelection();
    if (!dom?.isCollapsed || !root.contains(dom.focusNode)) return { anchor, head, dom: null };
    const after = document.createRange();
    after.selectNodeContents(root);
    after.setStart(dom.focusNode, dom.focusOffset);
    const domPos = editor.posAtDOM(dom.focusNode, dom.focusOffset);
    return {
      anchor,
      head,
      dom: domPos,
      atEnd: after.toString() === "",
      agree: anchor === head && head === domPos,
    };
  });
/** Focus the Page text with both carets after its last character.
 *
 * focus() puts the DOM caret at the start, and Wordgard reads that caret on its
 * next animation frame. A key pressed before then acts on Wordgard's own
 * selection, which sits at the end when the text arrived after the editor
 * mounted, so Mod-End does nothing and typed text lands at the DOM caret
 * (#4552). Give Wordgard up to a frame before the key, then wait until its
 * selection and the DOM caret agree at the end of the text. */
async function caretToEnd(page) {
  await content(page).focus({ timeout: 5000 });
  await expect(async () => {
    await page.evaluate(() =>
      Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]),
    );
    await page.keyboard.press("ControlOrMeta+End");
    await expect
      .poll(() => carets(page), { timeout: 2000 })
      .toMatchObject({ atEnd: true, agree: true });
  }).toPass({ timeout: 15000 });
}

try {
  owner = await signIn("dev@localhost");

  // Build A: the Worker and the viewer agree, so the tab stays quiet.
  const health = await api(owner, "/health");
  const buildA = health.body.build;
  assert.match(buildA, /^[0-9a-f]{12}$/);
  assert.equal(health.build, buildA);
  assert.equal(health.body.minViewerProtocol, 1);
  const session = await api(owner, "/api/auth/session");
  assert.equal(session.build, buildA);
  assert.equal(session.minViewerProtocol, "1");
  // The build id lives in app.js or one of the chunks it imports.
  const { source: entry } = await viewerEntry();
  const viewerSources = [
    entry,
    ...(await Promise.all(
      [...new Set(entry.match(/chunks\/[A-Z2-7]{8}\.js/g))].map(async (chunk) => {
        const response = await fetch(`${origin}/${chunk}`);
        assert.match(response.headers.get("content-type") ?? "", /javascript/, chunk);
        assert.match(response.headers.get("cache-control") ?? "", /immutable/, chunk);
        return response.text();
      }),
    )),
  ];
  assert.ok(
    viewerSources.some((source) => source.includes(JSON.stringify(buildA))),
    "viewer embeds the Worker's build",
  );
  const title = `Deploy fixture ${Date.now()}`;
  const created = await tool(owner, "create_page", {
    title,
    markdown: "Deploy garden.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = report.pageId = created.body.page_id;
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Deploy garden.");
  await caretToEnd(owner);
  await owner.keyboard.insertText(" Before deploy.");
  await paragraph(owner, "Deploy garden. Before deploy.");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await expect(banner(owner)).toHaveCount(0);
  report.completed.push(`Same build ${buildA}: /health, headers and viewer agree; no banner`);

  // Build B lands while the tab is open and an edit is in flight. The
  // reconnect's /api/connect response carries the new build.
  const buildB = buildA === "b".repeat(12) ? "c".repeat(12) : "b".repeat(12);
  const deployed = deploy(buildB);
  await expect(saved(owner)).toHaveCount(0, { timeout: 30000 });
  await owner.keyboard.insertText(" During deploy.");
  await paragraph(owner, "Deploy garden. Before deploy. During deploy.");
  await deployed;
  await expect(banner(owner)).toContainText(
    "Pages changed on the server. Reload to use the current version.",
    { timeout: 60000 },
  );
  await expect(banner(owner)).toHaveAttribute("role", "status");
  await owner.screenshot({ path: `${output}/update-banner.png` });
  // An optional update never pauses editing.
  await expect(content(owner)).toHaveAttribute("contenteditable", "true");
  // The restart under the deploy showed Offline, never a red banner, and the
  // edit made during it saves.
  await expect(saved(owner)).toBeVisible({ timeout: 60000 });
  assert.deepEqual(await redBanners(owner), [], "the deploy's restart showed a red banner");

  // Leave the Page while receipts fail. After the drain it closes with its
  // IndexedDB checkpoint and the tab keeps only its title. Reload names it and
  // asks first; Open brings the checkpoint back and it syncs.
  await owner.route("**/api/saved?*", (route) => route.abort());
  await owner.keyboard.insertText(" Checkpointed.");
  await paragraph(owner, "Deploy garden. Before deploy. During deploy. Checkpointed.");
  await owner.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(owner.getByRole("heading", { name: "Your pages" })).toBeVisible();
  await owner.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await banner(owner).getByRole("button", { name: "Reload" }).click();
  await expect(banner(owner)).toContainText(
    `Edits on ${title} haven't reached the server yet. They're saved in this browser and sync when you open that Page again.`,
    { timeout: 30000 },
  );
  await expect(banner(owner).getByRole("button", { name: "Reload anyway" })).toBeVisible();
  assert.equal(await owner.evaluate(() => window.__pagesBeforeReload), true, "no reload");
  await owner.screenshot({ path: `${output}/checkpointed-confirm.png` });
  await owner.unrouteAll({ behavior: "wait" });
  await banner(owner)
    .getByRole("button", { name: `Open ${title}` })
    .click();
  await paragraph(owner, "Deploy garden. Before deploy. During deploy. Checkpointed.", {
    timeout: 30000,
  });
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await expect(banner(owner).getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  report.completed.push(
    "Left a Page without its receipt: Reload named it and asked first; Open restored the checkpoint and saved it",
  );
  await caretToEnd(owner);

  // Leave the Page while its receipt is in flight, then Reload from the
  // library. The left Page keeps syncing, and Reload waits for its receipt.
  const receipts = { inFlight: 0, fulfilledAt: 0 };
  await owner.route("**/api/saved?*", async (route) => {
    receipts.inFlight++;
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.fulfill({ response });
      receipts.fulfilledAt = Date.now();
    } finally {
      receipts.inFlight--;
    }
  });
  await owner.keyboard.insertText(" After banner.");
  await paragraph(
    owner,
    "Deploy garden. Before deploy. During deploy. Checkpointed. After banner.",
  );
  await owner.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(owner.getByRole("heading", { name: "Your pages" })).toBeVisible();
  await expect.poll(() => receipts.inFlight, { timeout: 15000 }).toBeGreaterThan(0);
  let loadedAt = 0;
  owner.once("load", () => {
    loadedAt = Date.now();
  });
  const leftReload = reloadFromBanner(owner);
  await expect(banner(owner).getByRole("button", { name: "Saving edits…" })).toBeVisible();
  await leftReload;
  assert.ok(
    receipts.fulfilledAt > 0 && loadedAt >= receipts.fulfilledAt,
    JSON.stringify({ ...receipts, loadedAt }),
  );
  await owner.unrouteAll({ behavior: "wait" });
  await expect(banner(owner)).toHaveCount(0);
  await owner.goto(`${origin}/p/${pageId}`);
  await paragraph(
    owner,
    "Deploy garden. Before deploy. During deploy. Checkpointed. After banner.",
    { timeout: 30000 },
  );
  assert.equal((await api(owner, "/health")).body.build, buildB);
  const afterUpdate = await tool(owner, "read_page", { page_id: pageId });
  assert.match(
    JSON.stringify(afterUpdate.body),
    /Before deploy\. During deploy\. Checkpointed\. After banner\./,
  );
  report.completed.push(
    `Deploy to ${buildB} under an open tab: no red banner through the restart; update banner on reconnect; Reload after leaving the Page waited for its receipt`,
  );

  // An unsent reply, then the Worker raises its protocol floor above this
  // viewer: edits pause, the draft stays reachable, Reload refuses until the
  // draft is discarded, and what the tab already accepted still saves.
  const authority = (await tool(owner, "read_page", { page_id: pageId })).body;
  const comment = await tool(owner, "manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: authority.blocks[0].id,
    body: "Deploy thread",
    body_format: "plain",
    base_heads: authority.heads,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  await owner.getByRole("button", { name: /^Comments/ }).click();
  const thread = owner.locator(".thread", { hasText: "Deploy thread" });
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = thread.getByRole("textbox", { name: "Reply", exact: true });
  await expect(reply).toBeFocused();
  await reply.pressSequentially("Unsent reply");
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await caretToEnd(owner);
  await owner.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname === "/health",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "x-pages-min-viewer-protocol": "999" },
      });
    },
  );
  await owner.keyboard.insertText(" Floor raised.");
  await paragraph(
    owner,
    "Deploy garden. Before deploy. During deploy. Checkpointed. After banner. Floor raised.",
  );
  await expect(banner(owner)).toContainText(
    "Pages changed on the server. This tab can't edit until you reload.",
    { timeout: 30000 },
  );
  await expect(banner(owner)).toHaveAttribute("role", "alert");
  await expect(content(owner)).toHaveAttribute("contenteditable", "false");
  await expect(owner.getByRole("textbox", { name: "Page title" })).toHaveAttribute("readonly", "");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await content(owner).click();
  await owner.keyboard.insertText(" Ignored.");
  await expect(content(owner)).not.toContainText("Ignored.");
  // The draft stays visible and read-only; it can't be sent from this tab.
  await expect(reply).toContainText("Unsent reply");
  await expect(reply).toHaveAttribute("contenteditable", "false");
  await expect(thread.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await owner.screenshot({ path: `${output}/required-banner.png` });
  await owner.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await banner(owner).getByRole("button", { name: "Reload" }).click();
  await expect(banner(owner)).toContainText(
    "You have an unsent comment. Send or discard it before reloading.",
  );
  assert.equal(await owner.evaluate(() => window.__pagesBeforeReload), true, "no reload");
  await thread.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(thread.getByRole("button", { name: /^(Continue reply|Reply)$/ })).toHaveCount(0);
  await owner.unrouteAll({ behavior: "wait" });
  await reloadFromBanner(owner);
  await expect(content(owner)).toContainText("After banner. Floor raised.", { timeout: 30000 });
  await expect(content(owner)).not.toContainText("Ignored.");
  await expect(banner(owner)).toHaveCount(0);
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  const afterFloor = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(afterFloor.body), /After banner\. Floor raised\./);
  assert.doesNotMatch(JSON.stringify(afterFloor.body), /Ignored|Unsent reply/);
  report.completed.push(
    "Protocol floor above the viewer: edits paused, unsent reply kept read-only and blocked Reload until discarded, accepted edit saved",
  );

  // app.js loads the editor chunk with a dynamic import. A deploy can retire
  // that chunk before the import runs; the server then answers its path with
  // the app's HTML, and the import fails. The shell still renders, the banner
  // asks for a reload, and the reload opens the Page. The deploy above moved
  // every hashed name, so read the current entry.
  const current = await viewerEntry();
  const editorChunk = /import\("\.\/(chunks\/[A-Z2-7]{8}\.js)"\)/.exec(current.source)?.[1];
  assert.ok(editorChunk, "app.js imports the editor chunk");
  const retired = (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: "<!doctype html><title>Pages</title>",
    });
  const finalText =
    "Deploy garden. Before deploy. During deploy. Checkpointed. After banner. Floor raised.";

  // New Page while the editor chunk is still downloading, then Home: when the
  // chunk lands, the abandoned New Page must not create a draft. A created
  // draft lives in this browser first, so count the library's rows (local and
  // server Pages) as well as the server catalog.
  const library = owner.locator(".page-card");
  const untitled = async () => {
    await owner.goto(origin);
    await expect(library.filter({ hasText: title })).toBeVisible({ timeout: 30000 });
    const rows = await library.filter({ hasText: "Untitled" }).count();
    const server = (await tool(owner, "list_pages")).body.pages.filter(
      (page) => page.title === "Untitled",
    ).length;
    return { rows, server };
  };
  const untitledBefore = await untitled();
  let releaseEditor;
  const editorHeld = new Promise((resolve) => (releaseEditor = resolve));
  await owner.route(`**/${editorChunk}`, async (route) => {
    await editorHeld;
    await route.fallback();
  });
  await owner.goto(origin);
  const newPage = owner.getByRole("button", { name: "New Page", exact: true });
  await newPage.click();
  await expect(newPage).toBeDisabled();
  await owner.getByRole("link", { name: "Pages", exact: true }).click();
  releaseEditor();
  await expect(newPage).toBeEnabled({ timeout: 30000 });
  // The editor opens a Page once its chunk lands, so the abandoned create has
  // had its chance to run.
  await library.filter({ hasText: title }).click();
  await paragraph(owner, finalText, { timeout: 30000 });
  await expect(owner.getByRole("textbox", { name: "Page title" })).toHaveValue(title);
  await owner.unrouteAll({ behavior: "wait" });
  assert.deepEqual(await untitled(), untitledBefore, "an abandoned New Page created a draft");
  report.completed.push(
    "New Page during the editor download, then Home: no draft created once the editor loaded",
  );

  for (const { label, stale, expected } of [
    {
      label: "same build",
      stale: false,
      expected: "Pages couldn't load the editor. Reload to try again.",
    },
    {
      label: "older build",
      stale: true,
      expected: "Pages changed on the server. This tab can't edit until you reload.",
    },
  ]) {
    const older = "d".repeat(12);
    await owner.route(
      (url) => url.pathname === current.path || url.pathname.startsWith("/chunks/"),
      async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === `/${editorChunk}`) return retired(route);
        if (!stale) return route.fallback();
        // This tab's viewer embeds an older build id than the server's.
        const response = await route.fetch();
        const body = (await response.text()).replaceAll(
          JSON.stringify(buildB),
          JSON.stringify(older),
        );
        // The rewritten body must not be revalidated later under the real ETag.
        const headers = Object.fromEntries(
          Object.entries(response.headers()).filter(([name]) => name !== "etag"),
        );
        await route.fulfill({
          response,
          body,
          headers: { ...headers, "cache-control": "no-store" },
        });
      },
    );
    await owner.goto(`${origin}/p/${pageId}`);
    await expect(banner(owner)).toContainText(expected, { timeout: 30000 });
    await expect(banner(owner)).toHaveAttribute("role", "alert");
    await expect(owner.getByRole("button", { name: /, switch page$/ })).toBeVisible();
    await expect(content(owner)).toHaveCount(0);
    await owner.screenshot({
      path: `${output}/editor-unavailable-${stale ? "stale" : "same"}.png`,
    });
    await owner.unrouteAll({ behavior: "wait" });
    await reloadFromBanner(owner);
    await paragraph(owner, finalText, { timeout: 30000 });
    await expect(banner(owner)).toHaveCount(0);
    report.completed.push(
      `Editor chunk retired under a tab (${label}): shell rendered, banner asked for a reload, reload opened the Page`,
    );
  }

  // The Mermaid renderer is a hashed file too, imported only when a diagram
  // shows. A deploy retires it like a chunk, and the failed import asks
  // /health for the build so a stale tab sees the banner.
  const diagram = await tool(owner, "create_page", {
    title: `Diagram fixture ${Date.now()}`,
    markdown: "```mermaid\ngraph TD; A-->B\n```",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(diagram.status, 200, JSON.stringify(diagram.body));
  diagramId = diagram.body.page_id;
  let buildChecks = 0;
  const countBuildChecks = (request) => {
    if (new URL(request.url()).pathname === "/health") buildChecks++;
  };
  await owner.route((url) => /^\/mermaid-[A-Z2-7]{8}\.js$/.test(url.pathname), retired);
  await owner.goto(`${origin}/p/${diagramId}`);
  owner.on("request", countBuildChecks);
  await expect(owner.locator(".wordgard-diagram > p[role=status]")).toHaveText(
    "Diagram unavailable.",
    { timeout: 30000 },
  );
  await expect.poll(() => buildChecks, { timeout: 15000 }).toBeGreaterThan(0);
  owner.off("request", countBuildChecks);
  await owner.unrouteAll({ behavior: "wait" });
  report.completed.push("Mermaid renderer retired under a tab: the failed import checked /health");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  if (owner) {
    report.owner = await owner
      .locator("body")
      .innerText()
      .catch(() => null);
    await owner.screenshot({ path: `${output}/failure-owner.png` }).catch(() => {});
  }
  throw error;
} finally {
  if (pageId && owner) {
    try {
      await owner.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      let cleaned = true;
      for (const id of [pageId, diagramId].filter(Boolean)) {
        const r = await tool(owner, "read_page", { page_id: id });
        const d = await tool(owner, "delete_page", {
          page_id: id,
          base_heads: r.body.heads,
          idempotency_key: crypto.randomUUID(),
        });
        cleaned &&= d.status === 200;
      }
      report.cleaned = cleaned;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.disconnect?.();
}
console.log(JSON.stringify(report, null, 2));
