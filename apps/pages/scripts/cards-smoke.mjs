// Grid card previews on a real local host. The owner creates Pages with a
// heading, lists, a task list, code, a table, Mermaid and an image, edits
// each once (the edit's content-activity flush writes its card), and opens
// the library grid: each card shows the Page's first content instead of the
// placeholder icon. A Page shared with alice shows its card for her, and the
// owner removing her makes page_cards answer null on her very next call.
//
// The first content change after a quiet minute flushes at once, so no edit
// here waits for a window to end.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-cards";
const shots = process.env.PAGES_CARD_SHOTS || output;
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Cards E2E] ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Past the one-minute content window, plus the flush and its card write.
const TRAILING_MS = 100_000;
/** Let the cards' fade-in finish before a screenshot. */
const shoot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, name) });
};
const browser = await chromium.launch({ headless: true });

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

async function signIn(email, viewport = { width: 1280, height: 900 }, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
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

const PAGES = [
  {
    title: "Launch plan",
    markdown: [
      "# Goals for the launch",
      "Ship **grid cards** to everyone by Friday, with the [rollout notes](https://example.com/notes) in hand.",
      "- Cards render the first screen\n- Sharing rules match the listing\n- Nothing loads until it scrolls in",
      "- [x] Card builder\n- [x] page_cards\n- [ ] Turn the grid on",
    ].join("\n\n"),
    edit: ["Friday", "Thursday"],
    expect: { selector: "h1", text: "Goals for the launch" },
  },
  {
    title: "Query notes",
    markdown: [
      "## Weekly active Pages",
      "```python\nweekly = pages.groupby('week').agg(active=('page_id', 'nunique'))\nweekly.tail(4)\n```",
      "| Week | Active | Change |\n|:--|--:|--:|\n| 40 | 1,204 | +4% |\n| 41 | 1,262 | +5% |\n| 42 | 1,311 | +4% |",
    ].join("\n\n"),
    edit: ["Weekly active Pages", "Active Pages each week"],
    expect: { selector: "table", text: "Active" },
  },
  {
    title: "Architecture",
    markdown: [
      "A card is built by the Page host and read through the Catalog.",
      "```mermaid\nflowchart LR\n  Edit --> Flush --> Card[card.json]\n  Grid -->|page_cards| Card\n```",
      "> The renderer never reads a Page.",
    ].join("\n\n"),
    edit: ["built", "written"],
    expect: { selector: "pre[data-language=mermaid]", text: "flowchart LR" },
  },
  {
    title: "Photo log",
    markdown: [
      "### Offsite, day one",
      "![The team at the whiteboard](https://example.com/whiteboard.png)",
      "We sketched the card renderer and argued about Mermaid.",
    ].join("\n\n"),
    edit: ["argued", "agreed"],
    expect: { selector: "[data-card-placeholder=image]", text: "The team at the whiteboard" },
  },
];

async function edit(page, pageId, [from, to]) {
  const read = await tool(page, "read_page", { page_id: pageId, comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const patched = await tool(page, "edit_page", {
    page_id: pageId,
    revision: read.body.revision,
    nonce: crypto.randomUUID(),
    operations: [
      {
        op: "replace_match",
        node_id: read.body.blocks[0].node_id,
        match_text: from,
        replacement: to,
      },
    ],
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
}

/** page_cards for `ids` once every one has a card. */
async function cardsFor(page, ids, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await tool(page, "page_cards", { page_ids: ids });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    if (ids.every((id) => answer.body.cards[id])) return answer.body;
    if (Date.now() >= deadline)
      throw Error(`page_cards never answered every card: ${JSON.stringify(answer.body.cards)}`);
    await sleep(250);
  }
}

/** Open the library as a grid and check that a reload remembers the shortcut. */
async function openGrid(page) {
  await page.goto(`${origin}/?grid=1`);
  await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.locator("ul.index-grid").first()).toBeVisible({ timeout: 30000 });
}
const card = (page, title) =>
  page
    .locator(".index-card-link")
    .filter({ has: page.locator(`.index-card-title[title="${title}"]`) });

let owner, alice, phone;
try {
  owner = await signIn("dev@localhost");
  alice = await signIn("alice@localhost");
  const alicePrincipal = (await api(alice, "/api/auth/session")).body.identity.principal;

  const created = [];
  for (const spec of PAGES) {
    const result = await tool(owner, "create_page", {
      title: spec.title,
      markdown: spec.markdown,
      nonce: crypto.randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    created.push({ ...spec, pageId: result.body.page_id });
  }
  const ids = created.map((page) => page.pageId);
  // Creation imports a document; it isn't a content change, so no card yet.
  const before = await tool(owner, "page_cards", { page_ids: ids });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(
    Object.values(before.body.cards),
    ids.map(() => null),
  );
  complete("New Pages have no card until their content changes");

  for (const page of created) await edit(owner, page.pageId, page.edit);
  const answered = await cardsFor(owner, ids);
  const owned = await api(owner, "/api/auth/session");
  assert.equal(answered.principal, owned.body.identity.principal);
  for (const page of created) {
    const stored = answered.cards[page.pageId];
    assert.equal(stored.v, 1);
    assert.equal(stored.title, page.title);
    assert.match(stored.card_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(stored).includes("example.com"), false, "no URLs in a card");
  }
  assert.equal(answered.cards[created[2].pageId].rich, true, "Mermaid is rich");
  assert.equal(answered.cards[created[3].pageId].rich, true, "an image is rich");
  assert.equal(answered.cards[created[0].pageId].rich, false);
  complete("Each edit's flush wrote its Page's card, and page_cards returns them");

  await openGrid(owner);
  for (const page of created) {
    const preview = card(owner, page.title).locator(".page-card-preview");
    await expect(preview).toBeVisible({ timeout: 30000 });
    await expect(preview.locator(page.expect.selector).first()).toContainText(page.expect.text);
    await expect(card(owner, page.title).locator(".index-card-placeholder")).toHaveCount(0);
  }
  const launch = card(owner, "Launch plan");
  await expect(launch.locator(".preview-check[data-checked=true]")).toHaveCount(2);
  await expect(launch.locator("a, input, button")).toHaveCount(0);
  await expect(launch.locator(".page-card-preview")).toHaveAttribute("aria-hidden", "true");
  await shoot(owner, "cards-desktop-light.png");
  complete("The grid shows each Page's first content, inert and hidden from assistive tech");

  // An edit refetches: the listing's new content time is a new card key.
  // This second edit falls in the Page's one-minute content window, so its
  // flush, and the card with it, waits for the window's end.
  await edit(owner, created[0].pageId, ["Goals for the launch", "Goals for the release"]);
  await expect
    .poll(
      async () =>
        (await tool(owner, "page_cards", { page_ids: [created[0].pageId] })).body.cards[
          created[0].pageId
        ]?.blocks?.[0]?.content?.[0]?.[2],
      { timeout: TRAILING_MS, intervals: [1000] },
    )
    .toBe("Goals for the release");
  await openGrid(owner);
  await expect(launch.locator(".page-card-preview h1")).toContainText("Goals for the release", {
    timeout: 30000,
  });
  complete("An edit to the first screen shows in the card after the next listing");

  await owner.emulateMedia({ colorScheme: "dark" });
  await owner.reload();
  await expect(owner.locator("html")).toHaveClass(/dark/);
  await expect(card(owner, "Architecture").locator(".page-card-preview")).toBeVisible({
    timeout: 30000,
  });
  await shoot(owner, "cards-desktop-dark.png");
  complete("Cards follow the dark theme");

  phone = await signIn(
    "dev@localhost",
    { width: 390, height: 844 },
    { isMobile: true, hasTouch: true },
  );
  await openGrid(phone);
  await expect(card(phone, "Query notes").locator(".page-card-preview")).toBeVisible({
    timeout: 30000,
  });
  await shoot(phone, "cards-phone.png");
  complete("Cards render on a phone-sized screen");

  // Share Launch plan with alice. She opens it once, which records it in her
  // library, then sees its card in her grid.
  const shared = created[0].pageId;
  const access = async (action) => {
    const current = await api(owner, `/api/access?page=${shared}`);
    assert.equal(current.status, 200);
    const result = await api(owner, `/api/access?page=${shared}`, {
      ...action,
      expected_revision: current.body.access.revision,
      nonce: crypto.randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await access({ action: "invite", email: "alice@localhost", role: "viewer" });
  await alice.goto(`${origin}/p/${shared}`);
  await expect(alice.locator("wg-content").first()).toContainText("Goals for the release", {
    timeout: 30000,
  });
  const forAlice = await tool(alice, "page_cards", { page_ids: ids });
  assert.equal(forAlice.body.principal, alicePrincipal);
  assert.ok(forAlice.body.cards[shared], "the member reads the shared card");
  for (const id of ids.slice(1)) assert.equal(forAlice.body.cards[id], null, "unshared: null");
  await openGrid(alice);
  await expect(card(alice, "Launch plan").locator(".page-card-preview h1")).toContainText(
    "Goals for the release",
    { timeout: 30000 },
  );
  await shoot(alice, "cards-member.png");
  complete("A shared Page's card shows in the member's grid; the owner's other cards don't");

  await access({ action: "set_role", principal: alicePrincipal, role: null });
  const revoked = await tool(alice, "page_cards", { page_ids: [shared] });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual(revoked.body.cards, { [shared]: null });
  // Her library lists nothing now: the listing's own check drops the row.
  await alice.reload();
  await expect(alice.locator(".library-empty")).toBeVisible({ timeout: 30000 });
  await expect(card(alice, "Launch plan")).toHaveCount(0);
  complete("After removal, page_cards answers null on the next call and the card is gone");
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
