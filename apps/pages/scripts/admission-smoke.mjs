// Reconnect and admission qualification against an isolated local celld.
// Run through `node scripts/local-sharing-e2e.mjs --admission`, which owns the
// celld process and restarts it on request over IPC.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { eventually, plainPeer } from "./plain-peer.mjs";
import { BUILD_FORMATS } from "../model/document-types.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const celldLog = process.env.PAGES_CELLD_LOG;
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-admission-browser";
await mkdir(output, { recursive: true });
assert.equal(typeof process.send, "function", "run through local-sharing-e2e.mjs --admission");

const report = { completed: [], errors: [], closes: {} };
const browser = await chromium.launch({ headless: true });
let pageId, owner, member, stranger;

function restartCelld() {
  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type === "celld-restarted") resolve();
      else if (message?.type === "celld-restart-failed") reject(new Error(message.message));
      else return;
      process.off("message", listener);
    };
    process.on("message", listener);
    process.send({ type: "restart-celld" });
  });
}

async function api(page, path, body, headers = {}) {
  return page.evaluate(
    async ({ path, body, headers }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        headers: [...response.headers]
          .filter(([name]) => ["cache-control", "content-type"].includes(name))
          .sort(),
        body: await response.json(),
      };
    },
    { path, body, headers },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function setRole(principal, role) {
  const current = await api(owner, `/api/access?page=${pageId}`);
  const result = await api(owner, `/api/access?page=${pageId}`, {
    action: "set_role",
    principal,
    role,
    expected_revision: current.body.access.revision,
    nonce: crypto.randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
const cookieFor = async (page) =>
  (await page.context().cookies(origin)).map(({ name, value }) => `${name}=${value}`).join("; ");

// Record every sync socket close the browser sees, including its code.
const recordCloses = () => {
  const Native = window.WebSocket;
  window.__pagesCloses = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("close", ({ code, reason }) =>
        window.__pagesCloses.push({ code, reason }),
      );
    }
  };
};
const closes = (page) => page.evaluate(() => window.__pagesCloses);
// Record the text of every red banner that appears, however briefly, so a
// restart can be checked for one after the fact.
const recordBanners = () => {
  window.__pagesBanners = [];
  const seen = new WeakSet();
  const scan = () => {
    for (const banner of document.querySelectorAll(".error[role=alert]")) {
      if (seen.has(banner)) continue;
      seen.add(banner);
      window.__pagesBanners.push(banner.textContent);
    }
  };
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
};
const banners = (page) => page.evaluate(() => window.__pagesBanners);
const clearBanners = (page) => page.evaluate(() => (window.__pagesBanners.length = 0));

async function signIn(email) {
  const context = await browser.newContext();
  await context.addInitScript(recordCloses);
  await context.addInitScript(recordBanners);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(`${origin}/api/auth/login`, {
    maxRedirects: 0,
  });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  return page;
}

async function admissionLogs() {
  const text = celldLog ? await readFile(celldLog, "utf8") : "";
  return [
    ...text.matchAll(/\{"service":"nteract-pages-native","event":"admission\.denied"[^}]*\}/g),
  ].map(([line]) => JSON.parse(line));
}

try {
  owner = await signIn("dev@localhost");
  member = await signIn("alice@localhost");
  stranger = await signIn("bob@localhost");
  const memberPrincipal = (await api(member, "/api/auth/session")).body.identity.principal;
  const created = await tool(owner, "create_page", {
    title: `Admission fixture ${Date.now()}`,
    markdown: "Reconnect garden.",
    nonce: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = report.pageId = created.body.page_id;

  // HTTP denials carry a client code; a missing Page answers like a private one.
  const anonymous = await fetch(`${origin}/api/connect?page=${pageId}`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, "sign_in_required");
  const unreadable = await api(stranger, `/api/connect?page=${pageId}`);
  const missingId = crypto.randomUUID();
  const missing = await api(stranger, `/api/connect?page=${missingId}`);
  assert.deepEqual(unreadable, missing);
  assert.equal(unreadable.status, 403);
  assert.deepEqual(unreadable.body, {
    error: "Document access denied",
    code: "page_access_denied",
  });
  const crossOrigin = await fetch(`${origin}/api/connect?page=${pageId}`, {
    headers: {
      cookie: await cookieFor(owner),
      origin: "https://elsewhere.invalid",
    },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, "request_rejected");
  report.completed.push(
    "HTTP admission: sign_in_required, request_rejected, identical missing/unreadable 403",
  );

  // Sync refusals close with an application code after the upgrade.
  await setRole(memberPrincipal, "viewer");
  const ownerCookie = await cookieFor(owner);
  const discovered = await api(owner, `/api/connect?page=${pageId}`);
  {
    // Two tabs of one account are two connections, each named by its own
    // presence id, and they sync both ways.
    const join = async () => {
      const peer = await plainPeer({
        origin,
        pageId,
        cookie: ownerCookie,
        discovery: (await api(owner, `/api/connect?page=${pageId}`)).body,
        features: ["comments-doc"],
      });
      const handle = await peer.repo.find(discovered.body.documentId);
      return {
        ...peer,
        handle,
        change: async (fn) => (handle.change(fn), peer.repo.flush()),
      };
    };
    const one = await join();
    const two = await join();
    await one.change((doc) => {
      doc.fromOne = "from the first tab";
    });
    await eventually(() => assert.equal(two.handle.doc().fromOne, "from the first tab"), 20_000);
    await two.change((doc) => {
      doc.fromTwo = "from the second tab";
    });
    await eventually(() => assert.equal(one.handle.doc().fromTwo, "from the second tab"), 20_000);
    await one.close();
    await two.close();
    // A build without plain sync is refused the socket as a schema update.
    const oldBuild = new URL(`/api/sync?page=${pageId}&formats=${BUILD_FORMATS}`, origin);
    oldBuild.protocol = "ws:";
    const old = new WebSocket(oldBuild, {
      headers: { cookie: ownerCookie, origin },
    });
    report.closes.oldBuild = await new Promise((resolve, reject) => {
      old.addEventListener("close", ({ code, reason }) => resolve({ code, reason }));
      setTimeout(() => reject(new Error("an old build's socket was not refused")), 15000);
    });
    assert.deepEqual(report.closes.oldBuild, {
      code: 4426,
      reason: "schema_unsupported",
    });
    const textAddress = new URL(
      `/api/sync?page=${pageId}&sync=automerge&formats=${BUILD_FORMATS}`,
      origin,
    );
    textAddress.protocol = "ws:";
    const text = new WebSocket(textAddress, {
      headers: { cookie: ownerCookie, origin },
    });
    report.closes.textFrame = await new Promise((resolve, reject) => {
      text.addEventListener("open", () => text.send("not a sync frame"));
      text.addEventListener("close", ({ code, reason }) => resolve({ code, reason }));
      setTimeout(() => reject(new Error("text frame was not refused")), 15000);
    });
    assert.deepEqual(report.closes.textFrame, {
      code: 4400,
      reason: "request_rejected",
    });
    report.completed.push(
      "Plain admission: two tabs sync both ways; a build without plain sync 4426 schema_unsupported; text frame 4400 request_rejected",
    );
  }

  // Over the account's four-socket quota the upgrade still completes and
  // closes with the transient code, so a browser can count the refusal.
  // Each held socket stays reserved until its 10 s admission deadline.
  const memberCookie = await cookieFor(member);
  const rawSocket = () => {
    // Without `sync=automerge` the host refuses the socket before the quota.
    const address = new URL(
      `/api/sync?page=${pageId}&sync=automerge&formats=${BUILD_FORMATS}`,
      origin,
    );
    address.protocol = "ws:";
    const socket = new WebSocket(address, {
      headers: { cookie: memberCookie, origin },
    });
    return {
      socket,
      opened: new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("upgrade failed")), { once: true });
      }),
      closed: new Promise((resolve) =>
        socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
      ),
    };
  };
  const held = [];
  for (let i = 0; i < 4; i++) {
    held.push(rawSocket());
    await held.at(-1).opened;
  }
  const overQuota = rawSocket();
  report.closes.capacity = await Promise.race([
    overQuota.closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("over-quota socket was not refused")), 5000),
    ),
  ]);
  assert.deepEqual(report.closes.capacity, {
    code: 4503,
    reason: "temporarily_unavailable",
  });
  for (const { socket } of held) socket.close();
  await Promise.all(held.map(({ closed }) => closed));
  report.completed.push("Socket quota: over-quota upgrade closes 4503 temporarily_unavailable");

  // Open session, restart celld, keep editing, and reach Saved again.
  const content = (page) => page.locator("wg-content");
  const saved = (page) => page.locator(".save-status--saved");
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Reconnect garden.");
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.insertText(" Before restart.");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await clearBanners(owner);
  const restarted = restartCelld();
  await expect(owner.locator(".save-status--saved")).toHaveCount(0, {
    timeout: 30000,
  });
  await owner.keyboard.insertText(" During restart.");
  await restarted;
  await expect(saved(owner)).toBeVisible({ timeout: 60000 });
  // A restart is not something the person can act on: Offline, then Saved.
  assert.deepEqual(await banners(owner), [], "a restart showed a red banner");
  await expect(owner.getByRole("alert")).toHaveCount(0);
  const recovered = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(recovered.body), /Before restart\. During restart\./);
  report.closes.restart = await closes(owner);
  assert.ok(report.closes.restart.length >= 1, "restart closed the sync socket");
  assert.ok(
    report.closes.restart.every(({ code }) => code < 4400 || code >= 4500),
    "restart produced no permanent admission refusal",
  );
  report.completed.push(
    "Open session survives celld restart without a red banner; pending edit reaches Saved",
  );

  // Behind Cloudflare, a restarting origin answers HTTP with the gateway's
  // own HTML error page. Receipts and the session check get it while the
  // sync socket stays up. The Page saves locally, retries, and recovers.
  const gatewayDown = (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html; charset=UTF-8",
      body: "<!DOCTYPE html><title>503: origin unreachable | Cloudflare</title>",
    });
  const gatewayPaths = (url) =>
    url.pathname === "/api/saved" ||
    url.pathname === "/api/auth/session" ||
    url.pathname === "/api/connect";
  let gatewayAnswers = 0;
  await owner.route(gatewayPaths, (route) => {
    gatewayAnswers++;
    return gatewayDown(route);
  });
  await owner.keyboard.insertText(" Behind the gateway.");
  await owner.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(saved(owner)).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => gatewayAnswers, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  await expect(owner.locator(".save-status")).toHaveText(/Saved locally|Not saved|Offline/);
  assert.deepEqual(await banners(owner), [], "a gateway 503 showed a red banner");
  // The heads the owner's tab saves at, for the receipt sent after a restart.
  let savedHeads;
  const rememberSave = (request) => {
    if (new URL(request.url()).pathname === "/api/saved")
      savedHeads = request.postDataJSON()?.heads;
  };
  owner.on("request", rememberSave);
  await owner.unrouteAll({ behavior: "wait" });
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  owner.off("request", rememberSave);
  assert.deepEqual(await banners(owner), []);
  await expect(owner.getByRole("alert")).toHaveCount(0);
  report.completed.push(
    "Gateway HTML 503 on receipts and the session check: no red banner; Saved once it clears",
  );

  // A fresh isolate sets up its D1 session schema once, and the first requests
  // after a restart arrive together. Each must answer on its own.
  const heads = savedHeads;
  assert.ok(
    Array.isArray(heads) && heads.length,
    "the owner's tab saved after the gateway cleared",
  );
  await restartCelld();
  report.firstRequests = await owner.evaluate(
    ({ pageId, heads }) => {
      const status = (path, init = {}) =>
        fetch(path, { ...init, signal: AbortSignal.timeout(15000) }).then(
          (response) => response.status,
          (error) => error.name,
        );
      return Promise.all([
        status("/api/auth/session"),
        status(`/api/saved?page=${pageId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ heads }),
        }),
        status(`/api/connect?page=${pageId}`),
      ]);
    },
    { pageId, heads },
  );
  assert.deepEqual(report.firstRequests, [200, 200, 200]);
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  report.completed.push("Concurrent first requests after a restart each answer");

  // Revocation while connected closes with access_changed, then the recheck
  // reports page_access_denied and the viewer stops reconnecting.
  await setRole(memberPrincipal, "editor");
  await member.goto(`${origin}/p/${pageId}`);
  await expect(content(member)).toContainText("During restart.");
  await expect(content(member)).toHaveAttribute("contenteditable", "true", {
    timeout: 15000,
  });
  await setRole(memberPrincipal, null);
  await expect(member.getByText(/no longer have access/i).first()).toBeVisible({
    timeout: 15000,
  });
  report.closes.revoked = await closes(member);
  assert.ok(
    report.closes.revoked.some(({ code, reason }) => code === 4409 && reason === "access_changed"),
    JSON.stringify(report.closes.revoked),
  );
  const settled = report.closes.revoked.length;
  await member.waitForTimeout(3000);
  assert.equal((await closes(member)).length, settled, "no reconnect after access removal");
  report.completed.push("Revocation closes 4409 access_changed; viewer shows Access removed");

  // Every forced denial above produced one bounded log reason.
  const expected = [
    "credential_missing",
    "page_no_grant",
    "page_not_found",
    "origin_rejected",
    // A build without plain sync is refused as a schema update.
    "schema_unsupported",
    "native_frame_unsupported",
    "connection_capacity",
  ];
  let logs = [];
  await expect
    .poll(
      async () => {
        logs = await admissionLogs();
        return expected.filter((reason) => !logs.some((line) => line.reason === reason));
      },
      { timeout: 10000 },
    )
    .toEqual([]);
  report.logReasons = [...new Set(logs.map(({ reason }) => reason))].sort();
  const raw = JSON.stringify(logs);
  for (const secret of ["@localhost", pageId, "Bearer"]) assert.equal(raw.includes(secret), false);
  report.completed.push(`Admission log reasons: ${report.logReasons.join(", ")}`);
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  for (const [name, page] of [
    ["owner", owner],
    ["member", member],
  ])
    if (page) {
      report[name] = await page
        .locator("body")
        .innerText()
        .catch(() => null);
      await page.screenshot({ path: `${output}/failure-${name}.png` }).catch(() => {});
    }
  throw error;
} finally {
  if (pageId && owner) {
    try {
      const r = await tool(owner, "read_page", { page_id: pageId });
      const d = await tool(owner, "delete_page", {
        page_id: pageId,
        revision: r.body.revision,
        nonce: crypto.randomUUID(),
      });
      report.cleaned = d.status === 200;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.disconnect?.();
}
console.log(JSON.stringify(report, null, 2));
