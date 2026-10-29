// Local OIDC + real MCP + two native browser peers. Never uses live credentials.
// Run against the built local Pages fixture; this script does not start servers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9896";
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.equal(url.hostname, "localhost");
assert.equal(url.protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-presence-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { origin, completed: [], errors: [], screenshots: [] };
const leases = [];
let a,
  b,
  pageId,
  stage = "local OIDC sign-in";
const driver = "Presence QA agent";
const anchorText = "shared passage 🌳";
const selectionText = "Second writer selects this 🌊 passage";
const content = (page) => page.locator("wg-content").first();
const activity = (page) => page.locator(".page-activity");
const popover = (page) => page.locator(".activity-popover");
const redact = (value) =>
  leases.reduce((text, lease) => text.replaceAll(lease.lease_token, "[lease]"), String(value));
function complete(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}

async function rawMcp(page, name, args = {}) {
  // Same-origin fetch supplies the real browser session cookie. No bearer key,
  // storageState, retry authority, or private lease is written to the report.
  return page.evaluate(
    async ({ name, args, driver }) => {
      const response = await fetch("/mcp", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": driver,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!response.ok) throw Error(`${name}: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.error) throw Error(`${name}: JSON-RPC error ${envelope.error.code}`);
      const result = envelope.result;
      const text = result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text !== "string") throw Error(`${name}: missing MCP text result`);
      return { isError: result.isError === true, data: JSON.parse(text) };
    },
    { name, args, driver },
  );
}
async function mcp(page, name, args = {}) {
  const result = await rawMcp(page, name, args);
  if (result.isError) throw Error(`${name}: tool error ${result.data.code ?? "unspecified"}`);
  return result.data;
}
const read = () => mcp(a, "read_page", { page_id: pageId });
const presence = () => mcp(a, "read_page_presence", { page_id: pageId });
async function mutate(name, args) {
  const authority = await mcp(
    a,
    ["create_page", "delete_page"].includes(name) ? "list_pages" : "read_page",
    ["create_page", "delete_page"].includes(name) ? {} : { page_id: pageId },
  );
  assert.equal(typeof authority.retry_token, "string");
  assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
  return mcp(a, name, {
    ...args,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}
async function update(lease, fields) {
  return mcp(a, "report_page_progress", {
    page_id: pageId,
    progress_id: lease.progress_id,
    lease_token: lease.lease_token,
    ...fields,
  });
}
async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(20000);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(redact(error.message).slice(0, 1000)));
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
  assert.equal(session.editor, "wordgard");
  assert.ok(session.identity && session.canWrite, "local OIDC session can edit");
  return page;
}
async function selectText(page, text, collapse = false) {
  await content(page).focus();
  await content(page).evaluate(
    (element, { text, collapse }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest(
            ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
          )
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let source = "",
        node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: source.length });
        source += node.textContent;
      }
      const start = source.indexOf(text);
      if (start < 0) throw Error("Selection fixture text is missing");
      const at = (offset, starting = false) => {
        const entry = nodes.find(
          ({ node, start }) =>
            offset >= start &&
            (starting ? offset < start + node.length : offset <= start + node.length),
        );
        if (!entry) throw Error("Selection fixture offset is missing");
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      range.setStart(...at(start, true));
      range.setEnd(...at(start + text.length));
      if (collapse) range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { text, collapse },
  );
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toBe(collapse ? "" : text);
}
async function selectionPosition(page) {
  return content(page).evaluate((element) => {
    const selection = element.closest(".wordgard-document").wg.state.selection;
    return {
      anchor: selection.anchor,
      focus: selection.head,
      collapsed: selection.anchor === selection.head,
    };
  });
}
async function openActivity(page) {
  await expect(activity(page)).toBeVisible();
  if (!(await activity(page).evaluate((element) => element.open)))
    await activity(page).locator("summary").click();
  await expect(popover(page)).toBeVisible();
}
async function setTheme(page, mode) {
  const account = page.locator(".account-actions");
  if (!(await account.evaluate((element) => element.open)))
    await account.locator("summary").click();
  await account
    .getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
  await account.locator("summary").click();
}

try {
  a = await signIn();
  b = await signIn();
  stage = "one scratch Page through real MCP";
  const fixture = await mutate("create_page", {
    title: "Local progress and presence QA " + Date.now(),
    markdown: [
      "Writer one keeps the opening caret.",
      selectionText + ".",
      ...Array.from(
        { length: 9 },
        (_, index) =>
          `Context paragraph ${index + 1}. Enough space to verify passage navigation without moving an editing caret.`,
      ),
      `Agent target: investigate the ${anchorText} carefully.`,
    ].join("\n\n"),
  });
  pageId = fixture.page_id;
  report.fixture = pageId;
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + pageId, { waitUntil: "domcontentloaded" });
    await expect(content(page)).toContainText(anchorText, { timeout: 20000 });
  }
  complete(stage);

  stage = "two authenticated browser selections are readable through MCP";
  await selectText(a, "opening caret", true);
  await selectText(b, selectionText);
  await expect
    .poll(
      async () => {
        const state = await presence();
        return state.participants.filter((peer) => peer.selection?.status === "attached").length;
      },
      { timeout: 15000 },
    )
    .toBe(2);
  let observed = await presence();
  assert.equal(new Set(observed.participants.map((peer) => peer.peer_id)).size, 2);
  assert.ok(observed.participants.some((peer) => peer.selection.kind === "caret"));
  assert.ok(observed.participants.some((peer) => peer.selection.quote === selectionText));
  assert.ok(observed.participants.every((peer) => typeof peer.principal === "string"));
  complete(stage);

  stage = "two same-account agent leases appear and update independently without document writes";
  const baseline = await read();
  const first = await mcp(a, "report_page_progress", {
    page_id: pageId,
    message: "Checking the shared passage",
    targets: [{ block_id: baseline.blocks[0].id, match_text: anchorText }],
    expected_heads: baseline.heads,
  });
  assert.equal(typeof first.lease_token, "string");
  leases.push(first);
  const second = await mcp(a, "report_page_progress", {
    page_id: pageId,
    message: "Reviewing the introduction",
  });
  assert.equal(typeof second.lease_token, "string");
  leases.push(second);
  assert.notEqual(first.progress_id, second.progress_id);
  assert.ok(
    first.lease_token !== second.lease_token,
    "separate agents receive separate private leases",
  );
  assert.equal(first.principal, second.principal);
  assert.equal(first.driver, second.driver);
  for (const page of [a, b]) {
    await openActivity(page);
    await expect(popover(page)).toContainText(first.message);
    await expect(popover(page)).toContainText(second.message);
    await expect(popover(page)).toContainText(driver);
    await expect(popover(page)).toContainText("on behalf of");
  }
  await update(first, { message: "Checking sources beside the passage" });
  await expect(popover(b)).toContainText("Checking sources beside the passage");
  const denied = await rawMcp(a, "report_page_progress", {
    page_id: pageId,
    progress_id: first.progress_id,
    lease_token: second.lease_token,
    message: "Must not replace another agent",
  });
  assert.equal(denied.isError, true, "one agent cannot update another agent's lease");
  observed = await presence();
  assert.equal(observed.progress.length, 2);
  assert.ok(
    !JSON.stringify(observed).includes(first.lease_token),
    "presence reads omit lease secrets",
  );
  assert.ok(
    !JSON.stringify(observed).includes(second.lease_token),
    "presence reads omit every lease secret",
  );
  assert.deepEqual(observed.heads, baseline.heads);
  assert.deepEqual(
    (await read()).heads,
    baseline.heads,
    "presence and progress do not create history",
  );
  complete(stage);

  stage = "Show passage scrolls without relocating the browser editing caret";
  await selectText(a, "opening caret", true);
  await openActivity(a);
  const beforeReveal = await selectionPosition(a);
  assert.ok(beforeReveal?.collapsed, "fixture has a real collapsed editing selection");
  await popover(a)
    .getByRole("button", { name: new RegExp("Show passage.*shared passage", "s") })
    .click();
  await expect(
    a.locator(`.agent-progress-passage[data-progress-id="${first.progress_id}"]`).first(),
  ).toBeInViewport();
  assert.deepEqual(
    await selectionPosition(a),
    beforeReveal,
    "passage navigation preserves the user's insertion position",
  );
  assert.deepEqual((await read()).heads, baseline.heads);
  complete(stage);

  stage = "progress anchor follows a real human edit before the passage";
  const originalTarget = (await presence()).progress.find(
    (entry) => entry.progress_id === first.progress_id,
  ).targets[0];
  const insertion = " still here";
  await selectText(a, "opening caret", true);
  await a.keyboard.insertText(insertion);
  await expect(content(b)).toContainText("opening caret" + insertion);
  await expect
    .poll(
      async () => {
        const target = (await presence()).progress.find(
          (entry) => entry.progress_id === first.progress_id,
        )?.targets[0];
        return target?.start_utf16;
      },
      { timeout: 15000 },
    )
    .toBe(originalTarget.start_utf16 + insertion.length);
  const edited = await read();
  observed = await presence();
  assert.deepEqual(observed.heads, edited.heads);
  assert.equal(
    observed.progress.find((entry) => entry.progress_id === first.progress_id).targets[0].quote,
    anchorText,
  );
  complete(stage);

  stage = "activity popover in regular light and dark at wide and phone widths";
  for (const mode of ["light", "dark"]) {
    await setTheme(a, mode);
    for (const width of [1280, 390]) {
      await update(first, {});
      await update(second, {});
      await a.setViewportSize({ width, height: 900 });
      await a.evaluate(() => scrollTo(0, 0));
      await openActivity(a);
      await expect(popover(a)).toContainText("Checking sources beside the passage");
      const bounds = await popover(a).boundingBox();
      assert.ok(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        "activity stays within viewport",
      );
      assert.equal(
        await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const file = `activity-${mode}-${width}.png`;
      await a.screenshot({ path: output + "/" + file, fullPage: true });
      report.screenshots.push(file);
    }
  }
  assert.deepEqual(
    (await read()).heads,
    edited.heads,
    "theme, navigation and renewal create no history",
  );
  complete(stage);

  stage = "clearing one lease preserves the other; clearing both removes their highlights";
  await update(first, { clear: true });
  await expect
    .poll(async () => (await presence()).progress.map((entry) => entry.progress_id))
    .toEqual([second.progress_id]);
  await expect(popover(a)).not.toContainText("Checking sources beside the passage");
  await expect(a.locator(".agent-progress-passage")).toHaveCount(0);
  await update(second, { clear: true });
  await expect.poll(async () => (await presence()).progress.length).toBe(0);
  for (const page of [a, b]) await expect(page.locator(".agent-progress-passage")).toHaveCount(0);
  assert.deepEqual(
    (await read()).heads,
    edited.heads,
    "clearing progress leaves document history intact",
  );
  assert.deepEqual(report.errors, [], "no unhandled browser errors");
  complete(stage);
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = redact(error.stack ?? error);
  for (const [name, page] of [
    ["a", a],
    ["b", b],
  ])
    if (page)
      await page
        .screenshot({ path: output + `/failure-${name}.png`, fullPage: true })
        .catch(() => {});
  console.error("FAIL " + stage + "\n" + report.failure);
  process.exitCode = 1;
} finally {
  // Only this run's scratch Page is eligible for cleanup, including after failure.
  if (a && pageId) {
    for (const lease of leases) await update(lease, { clear: true }).catch(() => {});
    try {
      const current = await read();
      await mutate("delete_page", { page_id: pageId, base_heads: current.heads });
      await purgeTrashedFixture(
        (name, args) => mcp(a, name, args),
        pageId,
        async () => {
          const authority = await mcp(a, "list_pages");
          return {
            retry_token: authority.retry_token,
            idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
          };
        },
      );
      report.cleanedUp = true;
    } catch (error) {
      report.cleanedUp = false;
      report.cleanupFailure = redact(error.message);
      process.exitCode = 1;
    }
  }
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
