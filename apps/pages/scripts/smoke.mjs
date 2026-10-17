import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9890";
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const first = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await first.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
  const tool = (tab, operation, args) =>
    tab.evaluate(
      async ({ operation, args }) => {
        const r = await fetch("/api/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation, arguments: args }),
        });
        return { status: r.status, body: await r.json() };
      },
      { operation, args },
    );
  const created = await tool(page, "create_page", {
    title: "A place to think together",
    idempotency_key: crypto.randomUUID(),
    block_units: [
      {
        markdown:
          "## One document, many perspectives\n\nA quiet place for ideas to take shape. People and agents can work on the same Markdown, with **stable blocks**, explicit changes, and a shared history.",
      },
      {
        markdown:
          "### What we're working toward\n\n- A document that stays with you\n- Tools that can read before they write\n- Small changes that preserve someone else's work",
      },
      {
        markdown:
          "| Surface | Role |\n| --- | --- |\n| Markdown | The thought itself |\n| Automerge | Shared document history |\n| celld | A durable home |",
      },
      {
        kind: "agent_instructions",
        markdown:
          "Keep proposals separate from decisions. Link to the evidence. Ask before publishing. [Capability contract](/api/capabilities)",
      },
      { markdown: "" },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.page_id;
  await page.goto(`${origin}/?page=${id}`);
  await page.getByRole("heading", { name: "A place to think together", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page
    .getByLabel("Markdown source")
    .fill(
      "## Shared, with care\n\nYour edits are saved as Markdown with **stable identity**. A clear thought, kept intact.",
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("heading", { name: "Shared, with care" }).waitFor();
  assert.equal(
    await page.locator(".block pre").count(),
    0,
    "Empty Markdown must not become a code box",
  );
  const popupReady = first.waitForEvent("page");
  await page.getByRole("link", { name: "Capability contract" }).click();
  const popup = await popupReady;
  await popup.waitForLoadState();
  assert.equal(new URL(popup.url()).pathname, "/api/capabilities");
  await popup.close();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/pages-wide.png", fullPage: true });
  const second = await browser.newContext();
  const peer = await second.newPage();
  await peer.goto(origin);
  await peer.getByRole("link", { name: "Sign in", exact: true }).click();
  await peer.getByRole("button", { name: "Sign out" }).waitFor();
  const read = await tool(peer, "read_page", { page_id: id });
  assert.equal(read.status, 200);
  const content = read.body.content,
    block = content.blocks[0];
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Markdown source").fill("My unsaved contribution");
  const args = {
    page_id: id,
    base_sequence: content.through_sequence,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "replace_block_markdown",
        block_id: block.id,
        expected_hash: block.hash,
        markdown: "## Shared, with care\n\nA second device contributed this line.",
      },
    ],
  };
  const saved = await tool(peer, "edit_page", args);
  assert.equal(saved.status, 200);
  const replay = await tool(peer, "edit_page", args);
  assert.deepEqual(replay.body, saved.body);
  const stale = await tool(page, "edit_page", { ...args, idempotency_key: crypto.randomUUID() });
  assert.equal(stale.status, 409);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Page changed" }).waitFor();
  assert.equal(await page.getByLabel("Markdown source").inputValue(), "My unsaved contribution");
  assert.equal(await page.getByLabel("Markdown source").isEditable(), true);
  await page.getByRole("button", { name: "Compare with saved page" }).click();
  await page.getByRole("heading", { name: "Current saved version" }).waitFor();
  assert.match(await page.locator(".comparison pre").innerText(), /second device/);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await page.getByText("A second device contributed this line.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/pages-narrow.png", fullPage: true });
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(dimensions.content <= dimensions.viewport, JSON.stringify(dimensions));
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Markdown source").fill("Draft survives signing in again");
  await page.evaluate(() => fetch("/api/auth/session", { method: "POST" }));
  await page.reload();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Markdown source").waitFor();
  assert.equal(
    await page.getByLabel("Markdown source").inputValue(),
    "Draft survives signing in again",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        page_id: id,
        verified: [
          "OIDC login",
          "create",
          "render Markdown",
          "edit",
          "second browser session",
          "idempotent replay",
          "stale-write rejection",
          "390px layout",
          "working evidence links",
          "empty Markdown",
          "recoverable UI conflict",
          "draft recovery after sign-in",
        ],
        screenshots: ["test-results/pages-wide.png", "test-results/pages-narrow.png"],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
