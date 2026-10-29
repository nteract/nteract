// Reconnect and admission qualification against an isolated local celld.
// Run through `node scripts/local-sharing-e2e.mjs --admission`, which owns the
// celld process and restarts it on request over IPC.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as N from "@automerge/subduction";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const celldLog = process.env.PAGES_CELLD_LOG;
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-admission-browser";
await mkdir(output, { recursive: true });
assert.equal(typeof process.send, "function", "run through local-sharing-e2e.mjs --admission");

const report = { completed: [], errors: [], closes: {} };
const browser = await chromium.launch({ headless: true });
const bytes = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
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
async function setRole(principal, role) {
  const current = await api(owner, `/api/access?page=${pageId}`);
  const result = await api(owner, `/api/access?page=${pageId}`, {
    action: "set_role",
    principal,
    role,
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}
const cookieFor = async (page) =>
  (await page.context().cookies(origin)).map(({ name, value }) => `${name}=${value}`).join("; ");

// Record every native socket close the browser sees, including its code.
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

async function signIn(email) {
  const context = await browser.newContext();
  await context.addInitScript(recordCloses);
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

/** A raw Node native client: proves the signing key, then reports the close. */
async function nativeConnect(cookie, seed) {
  const discovery = await fetch(`${origin}/api/connect?page=${pageId}`, {
    headers: { cookie },
  }).then((response) => response.json());
  const address = new URL(`/api/sync?page=${pageId}`, origin);
  address.protocol = "ws:";
  const socket = new WebSocket(address, { headers: { cookie, origin } });
  socket.binaryType = "arraybuffer";
  const closed = new Promise((resolve) =>
    socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
  );
  const signer = N.MemorySigner.fromBytes(seed);
  const peer = signer.peerId();
  const senderId = peer.toString();
  peer.free();
  const expected = new N.PeerId(bytes(discovery.serverPeerId));
  let authenticated;
  try {
    authenticated = await N.SubductionWebSocket.setup(socket, signer, expected, () => {});
  } catch {
    /* A refusal can close the socket before the handshake settles. */
  } finally {
    expected.free();
  }
  return {
    senderId,
    closed,
    close() {
      authenticated?.free();
      socket.close();
    },
  };
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
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = report.pageId = created.body.page_id;

  // HTTP denials carry a client code; a missing Page answers like a private one.
  const anonymous = await fetch(`${origin}/api/connect?page=${pageId}`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, "sign_in_required");
  const unreadable = await api(stranger, `/api/connect?page=${pageId}`);
  const missing = await api(stranger, `/api/connect?page=${crypto.randomUUID()}`);
  assert.deepEqual(unreadable, missing);
  assert.deepEqual(unreadable, {
    status: 403,
    body: { error: "Document access denied", code: "page_access_denied" },
  });
  const crossOrigin = await fetch(`${origin}/api/connect?page=${pageId}`, {
    headers: { cookie: await cookieFor(owner), origin: "https://elsewhere.invalid" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, "request_rejected");
  report.completed.push(
    "HTTP admission: sign_in_required, request_rejected, identical missing/unreadable 403",
  );

  // Native refusals close with an application code after the upgrade.
  await setRole(memberPrincipal, "viewer");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const ownerCookie = await cookieFor(owner);
  const first = await nativeConnect(ownerCookie, seed);
  await expect
    .poll(
      async () =>
        Object.hasOwn(
          (await api(owner, `/api/connect?page=${pageId}`)).body.peerProfiles,
          first.senderId,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  const duplicate = await nativeConnect(ownerCookie, seed);
  report.closes.duplicate = await duplicate.closed;
  assert.deepEqual(report.closes.duplicate, { code: 4503, reason: "temporarily_unavailable" });
  const reassigned = await nativeConnect(await cookieFor(member), seed);
  report.closes.reassigned = await reassigned.closed;
  assert.deepEqual(report.closes.reassigned, { code: 4422, reason: "signing_key_rejected" });
  first.close();
  report.completed.push(
    "Native admission: duplicate key closes 4503 temporarily_unavailable; reassigned key 4422 signing_key_rejected",
  );

  // Open session, restart celld, keep editing, and reach Saved again.
  const content = (page) => page.locator("wg-content");
  const saved = (page) => page.locator(".save-status--saved");
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Reconnect garden.");
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.insertText(" Before restart.");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  const restarted = restartCelld();
  await expect(owner.locator(".save-status--saved")).toHaveCount(0, { timeout: 30000 });
  await owner.keyboard.insertText(" During restart.");
  await restarted;
  await expect(saved(owner)).toBeVisible({ timeout: 60000 });
  const recovered = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(recovered.body), /Before restart\. During restart\./);
  report.closes.restart = await closes(owner);
  assert.ok(report.closes.restart.length >= 1, "restart closed the native socket");
  assert.ok(
    report.closes.restart.every(({ code }) => code < 4400 || code >= 4500),
    "restart produced no permanent admission refusal",
  );
  report.completed.push("Open session survives celld restart; pending edit reaches Saved");

  // Revocation while connected closes with access_changed, then the recheck
  // reports page_access_denied and the viewer stops reconnecting.
  await setRole(memberPrincipal, "editor");
  await member.goto(`${origin}/p/${pageId}`);
  await expect(content(member)).toContainText("During restart.");
  await expect(content(member)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await setRole(memberPrincipal, null);
  await expect(member.getByText(/no longer have access/i).first()).toBeVisible({ timeout: 15000 });
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
    "native_already_connected",
    "native_binding_mismatch",
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
        base_heads: r.body.heads,
        idempotency_key: crypto.randomUUID(),
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
