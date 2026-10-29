// Local-only OIDC + real celld R2 + Wordgard image qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS;
const keys = JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
// POST that observes an early response. celld can answer 413 from the
// headers and close the socket before an oversized body is written, so fetch
// reports EPIPE instead of the status. Ask for 100-continue, stream the body in
// chunks only after the server allows it, and stop writing once any response
// arrives. A reset counts only after a status was received.
function postObservingEarlyResponse(url, headers, body, chunk = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let status = null,
      offset = 0,
      started = false;
    const finish = (text = "") => {
      req.destroy();
      resolve({ status, text });
    };
    const req = request(url, {
      method: "POST",
      headers: { ...headers, "Content-Length": body.length, Expect: "100-continue" },
    });
    const write = () => {
      if (status !== null) return;
      if (offset >= body.length) return void req.end();
      const next = body.subarray(offset, offset + chunk);
      offset += next.length;
      // Yield between chunks so a response can be parsed before the next write.
      if (req.write(next)) setImmediate(write);
      else req.once("drain", write);
    };
    const start = () => {
      if (started) return;
      started = true;
      write();
    };
    req.on("continue", start);
    // Servers may ignore Expect; send the body after a short wait.
    const fallback = setTimeout(start, 1000);
    req.on("response", (response) => {
      clearTimeout(fallback);
      status = response.statusCode;
      const parts = [];
      response.on("data", (part) => parts.push(part));
      response.on("end", () => finish(Buffer.concat(parts).toString()));
      response.on("error", () => finish());
    });
    req.on("error", (error) => {
      clearTimeout(fallback);
      if (status !== null) finish();
      else reject(error);
    });
    req.flushHeaders();
  });
}
const report = { completed: [], errors: [] };
const people = new Map();
const created = [];
let owner, editor, viewer, pageId, assetUrl;
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Images E2E] ${name}`);
};
const retry = (value) => ({
  retry_token: value.retry_token,
  idempotency_key: value.retry_key_prefix + crypto.randomUUID(),
});
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function access(action) {
  const current = await api(owner, `/api/access?page=${pageId}`);
  assert.equal(current.status, 200);
  const result = await api(owner, `/api/access?page=${pageId}`, {
    ...action,
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
async function signIn(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  people.set(email, page);
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  return page;
}
async function createPage(title) {
  const catalog = (await tool(owner, "list_pages")).body;
  const response = await tool(owner, "create_page", {
    title,
    markdown:
      "A shared image belongs beside the words it explains.\n\nImages stay private with this Page.",
    ...retry(catalog),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  created.push(response.body.page_id);
  return response.body.page_id;
}
const content = (page) => page.locator("wg-content").first();
const images = (page) => content(page).locator("img");
async function atEnd(page) {
  await content(page).click();
  await page.keyboard.press("ControlOrMeta+End");
}
async function expectImages(page, count) {
  await expect(images(page)).toHaveCount(count, { timeout: 15000 });
  await expect
    .poll(() =>
      images(page).evaluateAll((items) =>
        items.every((img) => img.complete && img.naturalWidth > 0),
      ),
    )
    .toBe(true);
}
async function imageEvent(page, kind, base64, name) {
  await content(page).evaluate(
    (element, { kind, base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: "image/png" }));
      if (kind === "paste") {
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      } else {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: data,
            clientX: rect.left + 20,
            clientY: rect.bottom - 10,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { kind, base64, name },
  );
}
try {
  owner = await signIn("dev@localhost");
  editor = await signIn("alice@localhost");
  viewer = await signIn("bob@localhost");
  pageId = await createPage("Private images qualification");
  report.pageId = pageId;
  await access({ action: "invite", email: "alice@localhost", role: "editor" });
  await access({ action: "invite", email: "bob@localhost", role: "viewer" });
  for (const page of [owner, editor, viewer]) {
    await page.goto(`${origin}/p/${pageId}`);
    await expect(content(page)).toContainText("A shared image");
  }
  const identities = await Promise.all(
    [owner, editor, viewer].map((page) => api(page, "/api/auth/session")),
  );
  assert.equal(new Set(identities.map((result) => result.body.identity.principal)).size, 3);
  await expect(content(editor)).toHaveAttribute("contenteditable", "true");
  await expect(content(viewer)).not.toHaveAttribute("contenteditable", "true");
  complete("Three real local OIDC sessions; owner/editor/viewer Page roles");

  // Browser-generated valid raster fixtures, no external files or image hosts.
  const fixtures = await owner.evaluate(() =>
    ["Shared screenshot", "Pasted screenshot", "Dropped screenshot"].map((label, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 720;
      canvas.height = 280;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = ["#e4efe8", "#e2eafa", "#f5e9db"][index];
      ctx.fillRect(0, 0, 720, 280);
      ctx.fillStyle = "#243b2e";
      ctx.font = "bold 36px sans-serif";
      ctx.fillText(label, 36, 62);
      ctx.font = "22px sans-serif";
      ctx.fillText("One Page, shared securely across editors", 36, 108);
      ctx.strokeStyle = "#243b2e";
      ctx.strokeRect(36, 150, 180, 72);
      ctx.strokeRect(286, 150, 180, 72);
      ctx.beginPath();
      ctx.moveTo(216, 186);
      ctx.lineTo(286, 186);
      ctx.stroke();
      ctx.fillText("Document", 61, 194);
      ctx.fillText("Image", 342, 194);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
  );
  const fixture = Buffer.from(fixtures[0], "base64");
  const uploadPath = `/api/pages/${pageId}/assets`;
  const uploaded = await fetch(origin + uploadPath, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.editor}`, "Content-Type": "image/png" },
    body: fixture,
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const asset = await uploaded.json();
  assetUrl = asset.url;
  assert.equal(asset.asset_id, createHash("sha256").update(fixture).digest("hex"));
  assert.equal(asset.url, `${uploadPath}/${asset.asset_id}`);
  assert.equal(asset.mime_type, "image/png");
  assert.equal(asset.size, fixture.length);
  assert.equal(asset.width, 720);
  assert.equal(asset.height, 280);
  const duplicate = await fetch(origin + uploadPath, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.editor}`, "Content-Type": "image/png" },
    body: fixture,
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), asset);
  for (const [body, mime, status] of [
    ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image/svg+xml", 415],
    [fixture, "image/jpeg", 415],
    [Buffer.alloc(5 * 1024 * 1024 + 1), "image/png", 413],
  ]) {
    const rejected = await postObservingEarlyResponse(
      origin + uploadPath,
      { Authorization: `Bearer ${keys.owner}`, "Content-Type": mime },
      Buffer.from(body),
    );
    assert.equal(rejected.status, status, rejected.text);
  }
  for (const key of [keys.reader, keys.viewer]) {
    const denied = await fetch(origin + uploadPath, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "image/png" },
      body: fixture,
    });
    assert.equal(denied.status, 403);
  }
  assert.equal((await fetch(origin + assetUrl)).status, 401);
  for (const page of [owner, editor, viewer]) {
    const response = await page.context().request.get(origin + assetUrl);
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.body(), fixture);
    assert.match(response.headers()["cache-control"], /private/);
    assert.match(response.headers()["cache-control"], /no-store/);
    assert.equal(response.headers()["x-content-type-options"], "nosniff");
    assert.equal((await page.context().request.head(origin + assetUrl)).status(), 200);
  }
  const secondPage = await createPage("Separate private image scope");
  const guessed = assetUrl.replace(pageId, secondPage);
  assert.equal((await owner.context().request.get(origin + guessed)).status(), 404);
  assert.equal((await viewer.context().request.get(origin + guessed)).status(), 403);
  complete(
    "Real R2 bytes match SHA-256; read/write scopes, Page roles and Page-scoped hashes enforced",
  );

  // An image alone in a block's first paragraph, deleted by hand. Its empty
  // paragraph must survive the native round trip with no projection error.
  const firstBlock = content(owner);
  await firstBlock.click();
  await owner.keyboard.press("ControlOrMeta+Home");
  await imageEvent(owner, "paste", fixtures[1], "first-paragraph.png");
  for (const page of [owner, editor, viewer]) await expectImages(page, 1);
  const leading = images(owner).first();
  await leading.click();
  await expect(leading).toHaveClass(/wg-selected-node/);
  await owner.keyboard.press("ArrowRight");
  await owner.keyboard.press("Enter");
  await expect(firstBlock.locator("p")).toHaveCount(3);
  await leading.click();
  await expect(leading).toHaveClass(/wg-selected-node/);
  await owner.keyboard.press("Backspace");
  for (const page of [owner, editor, viewer]) await expectImages(page, 0);
  const projectionError = /did not reproduce|is behind its Pages document/;
  await expect(owner.getByText(projectionError)).toHaveCount(0);
  await expect(firstBlock.locator("p")).toHaveCount(3);
  await expect
    .poll(async () => {
      const read = (await tool(owner, "read_page", { page_id: pageId })).body;
      return read.blocks.map((block) => block.markdown).join("\n");
    })
    .not.toContain("![");
  await owner.keyboard.press("ControlOrMeta+z");
  for (const page of [owner, editor, viewer]) await expectImages(page, 1);
  await owner.keyboard.press("ControlOrMeta+Shift+z");
  for (const page of [owner, editor, viewer]) await expectImages(page, 0);
  await expect(owner.getByText(projectionError)).toHaveCount(0);
  for (const page of [owner, editor, viewer])
    await expect(content(page)).toContainText("Images stay private with this Page.");
  complete("Deleting an image alone in a block's first paragraph keeps the Page in sync");

  let resumeUpload;
  const holdUpload = new Promise((resolve) => {
    resumeUpload = resolve;
  });
  let sawUpload;
  const uploadStarted = new Promise((resolve) => {
    sawUpload = resolve;
  });
  await owner.route(
    origin + uploadPath,
    async (route) => {
      sawUpload();
      await holdUpload;
      await route.continue();
    },
    { times: 1 },
  );
  await atEnd(owner);
  // A collapsed caret hides contextual formatting; open the dock for Insert image.
  await owner.keyboard.press("Alt+F10");
  const chooser = owner.waitForEvent("filechooser");
  await owner.getByRole("button", { name: "Insert image", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "shared-screenshot.png", mimeType: "image/png", buffer: fixture });
  await uploadStarted;
  try {
    await expect(owner.getByText("Uploading image…", { exact: true })).toBeVisible();
    await atEnd(editor);
    await editor.keyboard.insertText(" A collaborator writes during the upload.");
    await expect(content(owner)).toContainText("collaborator writes during the upload");
  } finally {
    resumeUpload();
  }
  for (const page of [owner, editor, viewer]) await expectImages(page, 1);
  assert.equal(await images(owner).first().getAttribute("src"), assetUrl);
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+z");
  for (const page of [owner, editor, viewer]) await expectImages(page, 0);
  await expect(content(owner)).toContainText("collaborator writes during the upload");
  await owner.keyboard.press("ControlOrMeta+Shift+z");
  for (const page of [owner, editor, viewer]) await expectImages(page, 1);
  complete("File picker upload tolerates concurrent editing; image undo/redo reaches both peers");

  await images(owner).first().click();
  await expect(images(owner).first()).toHaveClass(/wg-selected-node/);
  await expect(owner.getByRole("toolbar", { name: "Image actions" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Bold", exact: true })).toHaveCount(0);
  await expect(owner.getByRole("combobox", { name: "Text style" })).toHaveCount(0);
  await atEnd(editor);
  await editor.keyboard.insertText(" A peer keeps writing while the image is selected.");
  await expect(content(owner)).toContainText("peer keeps writing while the image is selected");
  await expect(images(owner).first()).toHaveClass(/wg-selected-node/);
  await expect(owner.getByRole("toolbar", { name: "Image actions" })).toBeVisible();
  await content(owner)
    .locator("p")
    .first()
    .click({ position: { x: 20, y: 12 } });
  await expect(owner.getByRole("toolbar", { name: "Text formatting" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Bold", exact: true })).toBeVisible();
  complete("Image clicks hide font controls across peer edits; clicking text restores formatting");

  await atEnd(editor);
  await imageEvent(editor, "paste", fixtures[1], "pasted-screenshot.png");
  for (const page of [owner, editor, viewer]) await expectImages(page, 2);
  await atEnd(owner);
  await imageEvent(owner, "drop", fixtures[2], "dropped-screenshot.png");
  for (const page of [owner, editor, viewer]) await expectImages(page, 3);
  complete("Screenshot paste and file drop upload through the shared insertion path");

  const beforeContinuation = await owner.locator(".page-block").count();
  await owner.getByRole("button", { name: "Write something…", exact: true }).click();
  const trailing = owner.locator("wg-content").last();
  await expect(trailing).toBeFocused();
  await expect(owner.locator(".page-block")).toHaveCount(beforeContinuation + 1);
  await owner.getByRole("button", { name: "Write something…", exact: true }).click();
  await expect(trailing).toBeFocused();
  await expect(owner.locator(".page-block")).toHaveCount(beforeContinuation + 1);
  await owner.keyboard.insertText("Writing continues naturally below the images.");
  for (const page of [owner, editor, viewer])
    await expect(page.locator("wg-content").last()).toContainText(
      "Writing continues naturally below the images.",
    );
  await expect(viewer.getByRole("button", { name: "Write something…" })).toHaveCount(0);
  complete("Writing continues below images; repeated activation reuses the empty paragraph");

  await expect
    .poll(async () => {
      const read = (await tool(owner, "read_page", { page_id: pageId })).body;
      return (
        read.blocks
          .map((block) => block.markdown)
          .join("\n")
          .match(/!\[/g)?.length || 0
      );
    })
    .toBe(3);
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  const markdown = read.blocks.map((block) => block.markdown).join("\n");
  assert.ok(markdown.includes(assetUrl));
  assert.ok(
    !markdown.includes("data:image") && !markdown.includes("blob:") && !markdown.includes("base64"),
  );
  await viewer.reload();
  await expectImages(viewer, 3);
  // Readers get no formatting dock, so no Insert image control at all.
  await expect(viewer.getByRole("button", { name: "Insert image", exact: true })).toHaveCount(0);
  let readonlyUploads = 0;
  viewer.on("request", (request) => {
    if (request.url() === origin + uploadPath && request.method() === "POST") readonlyUploads++;
  });
  await imageEvent(viewer, "paste", fixtures[0], "readonly.png");
  await expectImages(viewer, 3);
  assert.equal(readonlyUploads, 0);
  await owner.screenshot({ path: `${output}/images-wide.png`, fullPage: true });
  await owner.setViewportSize({ width: 390, height: 844 });
  await images(owner).first().scrollIntoViewIfNeeded();
  await owner.screenshot({ path: `${output}/images-mobile.png`, fullPage: true });
  report.mobile = await owner.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width && rect.right > innerWidth;
      })
      .slice(0, 12)
      .map((node) => ({
        tag: node.tagName,
        class: node.className,
        right: node.getBoundingClientRect().right,
      })),
  }));
  assert.equal(report.mobile.document <= report.mobile.viewport, true);
  assert.equal(
    await images(owner).evaluateAll((items) =>
      items.every((image) => image.getBoundingClientRect().right <= innerWidth),
    ),
    true,
  );
  complete(
    "Markdown contains references only; viewer reload and phone-width layout render private images",
  );

  await access({
    action: "set_role",
    principal: identities[2].body.identity.principal,
    role: null,
  });
  for (const method of ["GET", "HEAD"]) {
    const denied = await viewer.context().request.fetch(origin + assetUrl, { method });
    assert.equal(denied.status(), 403);
  }
  assert.equal(
    (await fetch(origin + assetUrl, { headers: { Authorization: `Bearer ${keys.viewer}` } }))
      .status,
    403,
  );
  complete(
    "Revocation denies fresh cookie/API-key image reads and HEAD after prior successful reads",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [name, page] of people) {
    report[name] = await page
      .locator("body")
      .innerText()
      .catch(() => null);
    await page
      .screenshot({
        path: `${output}/failure-${name.replaceAll(/[^a-z0-9]/g, "-")}.png`,
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  report.cleaned = true;
  for (const id of created.reverse()) {
    try {
      const read = (await tool(owner, "read_page", { page_id: id })).body;
      const catalog = (await tool(owner, "list_pages")).body;
      const deleted = await tool(owner, "delete_page", {
        page_id: id,
        base_heads: read.heads,
        ...retry(catalog),
      });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      if (id === pageId && assetUrl)
        assert.equal((await owner.context().request.get(origin + assetUrl)).status(), 404);
    } catch (error) {
      report.cleaned = false;
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
