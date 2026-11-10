// list_pages timing for an account whose library is all shared Pages, with
// the Page hosts cold (right after a celld restart) and warm. Records timings;
// gates on nothing.
//
// Run through the isolated fixture:
//   node scripts/local-sharing-e2e.mjs --listing-bench
// Options (environment):
//   PAGES_LISTING_SHARED     shared Pages to seed (default 50)
//   PAGES_LISTING_COLD_RUNS  celld restarts, one cold listing each (default 6)
//   PAGES_LISTING_WARM_RUNS  warm listings (default 20)
//   PAGES_LISTING_LIMIT      list_pages limit (default 100)
//
// One account owns the Pages and invites a second by email; the second claims
// each invitation by reading the Page once. Every shared row in the second
// account's listing is then checked by its Page host. A cold sample restarts
// celld on the same data directory, so every Page host starts again and the
// first listing after the restart pays for each host's startup. The second
// listing after a restart shows the warm cost on the same instances.
//
// Writes `listing-benchmark.json` (every sample, plus p50/p95 per scenario)
// and the harness's `report.json` to PAGES_SCREENSHOTS.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS;
await mkdir(output, { recursive: true });
const SHARED = Number(process.env.PAGES_LISTING_SHARED || 50);
const COLD_RUNS = Number(process.env.PAGES_LISTING_COLD_RUNS || 6);
const WARM_RUNS = Number(process.env.PAGES_LISTING_WARM_RUNS || 20);
const LIMIT = Number(process.env.PAGES_LISTING_LIMIT || 100);
const log = (...args) => console.log("[listing-bench]", ...args);
const report = { cleaned: false };
const results = { shared: SHARED, limit: LIMIT, scenarios: {}, samples: {} };

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});

/** Ask the harness to restart celld over the same data directory. */
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

/** Sign in through the local OIDC issuer and keep the session cookie. */
async function signIn(email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  const cookies = await context.cookies(origin);
  await context.close();
  return { email, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

/** Renew the session cookie after a restart, as the browser's session check would. */
async function refreshCookie(account) {
  const response = await fetch(`${origin}/api/auth/session`, {
    headers: { Cookie: account.cookie, Origin: origin },
  });
  const jar = new Map(account.cookie.split("; ").map((part) => part.split(/=(.*)/s).slice(0, 2)));
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [name, value] = line.split(";")[0].split(/=(.*)/s);
    jar.set(name, value);
  }
  account.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function tool(account, operation, args = {}) {
  const started = performance.now();
  const response = await fetch(`${origin}/api/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: account.cookie, Origin: origin },
    body: JSON.stringify({ operation, arguments: args }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return {
    ms,
    status: response.status,
    body,
    source: response.headers.get("x-pages-catalog-source"),
  };
}

async function ok(account, operation, args) {
  for (let attempt = 0; ; attempt++) {
    const result = await tool(account, operation, args);
    if (result.status === 200 || result.status === 201) return result.body;
    if (result.status < 500 || attempt >= 4)
      throw new Error(
        `${operation} ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
}

async function api(account, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: account.cookie,
      Origin: origin,
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function seed(owner, reader) {
  const ids = [];
  for (let n = 0; n < SHARED; n++) {
    const page = await ok(owner, "create_page", {
      title: `Shared page ${String(n).padStart(3, "0")}`,
      markdown: Array.from(
        { length: 12 },
        (_, p) => `Paragraph ${p + 1} of shared page ${n}. Enough text to make a real document.`,
      ).join("\n\n"),
      idempotency_key: crypto.randomUUID(),
    });
    ids.push(page.page_id);
  }
  for (const pageId of ids) {
    const { access } = await api(owner, `/api/access?page=${pageId}`);
    await api(owner, `/api/access?page=${pageId}`, {
      action: "invite",
      email: reader.email,
      role: "viewer",
      expected_revision: access.revision,
      idempotency_key: crypto.randomUUID(),
    });
  }
  // Reading a Page claims its invitation.
  for (const pageId of ids)
    await ok(reader, "read_page", { page_id: pageId, include_content: false, comments: "none" });
  return ids;
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] * 10) / 10
  );
};

function summarize(name, samples) {
  const ms = samples.map((sample) => sample.ms);
  const summary = {
    n: samples.length,
    p50: quantile(ms, 0.5),
    p95: quantile(ms, 0.95),
    max: Math.round(Math.max(...ms)),
    statuses: [...new Set(samples.map((sample) => sample.status))],
    rows: [...new Set(samples.map((sample) => sample.body?.pages?.length ?? null))],
    sources: [...new Set(samples.map((sample) => sample.source))],
  };
  results.scenarios[name] = summary;
  results.samples[name] = samples.map(({ ms, status }) => ({ ms: Math.round(ms), status }));
  log(name, JSON.stringify(summary));
}

try {
  const owner = await signIn("dev@localhost");
  const reader = await signIn("bob@localhost");
  const started = performance.now();
  await seed(owner, reader);
  log(`seeded ${SHARED} shared Pages in ${Math.round(performance.now() - started)} ms`);
  // Let the reader's first reconcile pass finish so every sample reads D1.
  for (let n = 0; n < 40; n++) {
    const listing = await tool(reader, "list_pages", { limit: LIMIT });
    if (listing.source === "index" && listing.body.pages?.length === Math.min(SHARED, LIMIT)) break;
  }
  const cold = [];
  const afterCold = [];
  for (let run = 0; run < COLD_RUNS; run++) {
    await restartCelld();
    await refreshCookie(owner);
    await refreshCookie(reader);
    cold.push(await tool(reader, "list_pages", { limit: LIMIT }));
    afterCold.push(await tool(reader, "list_pages", { limit: LIMIT }));
  }
  summarize("shared list_pages, Page hosts cold (first listing after restart)", cold);
  summarize("shared list_pages, second listing after restart", afterCold);
  const warm = [];
  for (let run = 0; run < WARM_RUNS; run++)
    warm.push(await tool(reader, "list_pages", { limit: LIMIT }));
  summarize("shared list_pages, Page hosts warm", warm);
  const owned = [];
  for (let run = 0; run < WARM_RUNS; run++)
    owned.push(await tool(owner, "list_pages", { limit: LIMIT }));
  summarize("owned list_pages, warm", owned);
  report.cleaned = true;
} catch (error) {
  report.failure = String(error?.stack ?? error);
  console.error(error);
} finally {
  await writeFile(path.join(output, "listing-benchmark.json"), JSON.stringify(results, null, 2));
  await writeFile(path.join(output, "report.json"), JSON.stringify(report));
  await browser.close();
}
