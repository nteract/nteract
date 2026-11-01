// Local OIDC + two browser writers on one Page. Never uses live credentials.
// Run against the built local Pages fixture; this script does not start servers.
//
// Covers what people do together that the editor and presence smokes don't:
// typing at the same caret in the body and the title, offline edits, comment
// threads across writers, rich paste, keyboard focus, and Move to Trash
// against a peer's edit.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9896";
const url = new URL(origin);
assert.equal(url.origin, origin);
assert.equal(url.hostname, "localhost");
assert.equal(url.protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-collaboration-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { origin, completed: [], todo: [], errors: [] };
let a,
  b,
  pageId,
  stage = "local OIDC sign-in";
const content = (page) => page.locator(".page-block wg-content").first();
const title = (page) => page.getByRole("textbox", { name: "Page title" });
const textOf = async (page) => (await content(page).innerText()).replace(/\u200b/g, "");
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20000 });
function complete(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}
// Known bugs, named after their QA findings. They run with PAGES_E2E_TODO=1
// and never fail the suite; one that starts passing says so.
async function todo(name, run) {
  if (process.env.PAGES_E2E_TODO !== "1") {
    report.todo.push({ name, result: "skipped" });
    console.log("TODO (skipped) " + name);
    return;
  }
  try {
    await run();
    report.todo.push({ name, result: "passes" });
    console.log("TODO now passes, promote it: " + name);
  } catch (error) {
    report.todo.push({ name, result: "fails", error: String(error.message).slice(0, 500) });
    console.log("TODO still fails: " + name);
  }
}

async function signIn() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(20000);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message.slice(0, 1000)));
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  return page;
}
// Same-origin tool calls carry the browser session cookie; nothing is stored.
async function tool(page, operation, args = {}) {
  const { status, body } = await page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ operation, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, args },
  );
  if (status !== 200) throw Error(`${operation}: HTTP ${status} ${body?.code ?? ""}`);
  return body;
}
async function mutate(operation, args) {
  const catalog = ["create_page", "delete_page", "purge_page"].includes(operation);
  const authority = await tool(
    a,
    catalog ? "list_pages" : "read_page",
    catalog ? {} : { page_id: pageId },
  );
  return tool(a, operation, {
    ...args,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}
const read = () => tool(a, "read_page", { page_id: pageId });
const markdown = async () => (await read()).blocks.map((block) => block.markdown).join("\n\n");

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
      if (start < 0) throw Error("Selection fixture text is missing: " + text);
      const at = (offset, starting = false) => {
        const entry = nodes.find(
          ({ node, start }) =>
            offset >= start &&
            (starting ? offset < start + node.length : offset <= start + node.length),
        );
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
// Two writers type one character at a time, in turn, at their own carets.
// Each keystroke waits until the other writer shows the same text, so every
// keystroke provably crosses a peer's edit that arrived after the caret was
// placed. `read` returns what a writer's screen shows.
async function typeInTurns(read, [first, firstText], [second, secondText]) {
  const [one, two] = [Array.from(firstText), Array.from(secondText)];
  const turns = [];
  for (let i = 0; i < Math.max(one.length, two.length); i++) {
    if (i < one.length) turns.push([first, one[i]]);
    if (i < two.length) turns.push([second, two[i]]);
  }
  for (const [page, character] of turns) {
    const before = await read(page);
    await page.keyboard.type(character);
    await expect.poll(() => read(page)).not.toBe(before);
    const shown = await read(page);
    for (const other of [first, second]) await expect.poll(() => read(other)).toBe(shown);
  }
}
async function paste(page, html, plain) {
  await content(page).evaluate(
    (element, { html, plain }) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", plain);
      // The editor's own paste path, without the host clipboard.
      const range = getSelection().getRangeAt(0);
      element.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          targetRanges: [
            new StaticRange({
              startContainer: range.startContainer,
              startOffset: range.startOffset,
              endContainer: range.endContainer,
              endOffset: range.endOffset,
            }),
          ],
        }),
      );
    },
    { html, plain },
  );
}

try {
  a = await signIn();
  b = await signIn();
  complete(stage);

  stage = "one disposable Page opened by two writers";
  const created = await mutate("create_page", {
    title: "Notes:",
    markdown: "Meeting notes: and more.\n\nThe quick brown fox jumps over the lazy dog.",
  });
  pageId = created.page_id;
  for (const page of [a, b]) {
    await page.goto(`${origin}/p/${pageId}`);
    await expect(content(page)).toContainText("Meeting notes:");
  }
  complete(stage);

  stage = "two writers typing at one caret keep unbroken runs";
  await selectText(a, "Meeting notes:", true);
  await selectText(b, "Meeting notes:", true);
  // Both carets sit after "notes:". A caret sticks to the character before
  // it, so B's run stays before A's and neither interleaves.
  // Emoji take two UTF-16 units; a caret after one stays after the whole emoji.
  await typeInTurns(textOf, [a, " Alpha 🌊"], [b, " Beta 🌍"]);
  assert.ok(
    (await textOf(a)).startsWith("Meeting notes: Beta 🌍 Alpha 🌊 and more."),
    await textOf(a),
  );
  assert.equal(await textOf(a), await textOf(b));
  complete(stage);

  stage = "two writers typing in the title keep unbroken runs";
  for (const page of [a, b]) {
    await title(page).click();
    await title(page).press("End");
  }
  const titleOf = (page) => title(page).inputValue();
  await typeInTurns(titleOf, [a, " Alpha"], [b, " Beta"]);
  assert.equal(await titleOf(a), "Notes: Beta Alpha");
  // A peer's edit before the caret leaves the caret after the same text.
  await title(a).press("End");
  await title(b).press("Home");
  await b.keyboard.type("My ");
  await expect.poll(() => title(a).inputValue()).toMatch(/^My /);
  await a.keyboard.type("!");
  await expect.poll(() => title(b).inputValue()).toMatch(/!$/);
  assert.equal(await title(a).inputValue(), await title(b).inputValue());
  complete(stage);

  stage = "a peer's title edit during an IME composition merges when it ends";
  {
    // Chromium's IME through CDP: compositionstart, composing input events,
    // then compositionend on commit.
    const ime = await b.context().newCDPSession(b);
    await title(b).click();
    await title(b).press("End");
    const before = await title(b).inputValue();
    await ime.send("Input.imeSetComposition", { text: " k", selectionStart: 2, selectionEnd: 2 });
    await ime.send("Input.imeSetComposition", { text: " か", selectionStart: 2, selectionEnd: 2 });
    await expect(title(b)).toHaveValue(before + " か");
    // A's edit reaches B's document (its switcher label) but not the input
    // the IME owns.
    await title(a).click();
    await title(a).press("Home");
    await a.keyboard.type("IME ");
    await expect(
      b.getByRole("button", { name: "IME " + before + ", switch page", exact: true }),
    ).toBeVisible();
    await expect(title(b)).toHaveValue(before + " か");
    await ime.send("Input.imeSetComposition", { text: " 漢", selectionStart: 2, selectionEnd: 2 });
    await ime.send("Input.insertText", { text: " 漢" });
    const merged = "IME " + before + " 漢";
    for (const page of [a, b]) await expect(title(page)).toHaveValue(merged);
    // B's caret sits after the composed text, so typing continues there.
    expect(await title(b).evaluate((input) => input.selectionStart)).toBe(merged.length);
    await b.keyboard.type("!");
    await expect(title(a)).toHaveValue(merged + "!");
    await ime.detach();
  }
  complete(stage);

  stage = "Tab leaves the Page body outside a table";

  await selectText(a, "lazy dog.", true);
  await a.keyboard.press("Tab");
  await expect
    .poll(() => a.evaluate(() => !!document.activeElement?.closest(".page-block")))
    .toBe(false);
  await a.keyboard.press("Shift+Tab");
  await expect
    .poll(() => a.evaluate(() => !!document.activeElement?.closest(".page-block")))
    .toBe(true);
  complete(stage);

  stage = "pasted HTML keeps links, bold and italic";
  await selectText(a, "lazy dog.", true);
  await paste(
    a,
    '<p class=MsoNormal><b>Word bold</b> and <i>slanted</i> and <a href="https://example.com/x" title="X">a link</a> and <a href="javascript:alert(1)">unsafe</a></p>',
    "Word bold and slanted and a link and unsafe",
  );
  await expect
    .poll(markdown)
    .toContain('**Word bold** and *slanted* and [a link](https://example.com/x "X") and unsafe');
  await expect(content(b).locator('a[href="https://example.com/x"]')).toHaveText("a link");
  assert.equal(await content(b).locator('a[href^="javascript"]').count(), 0);
  complete(stage);

  stage = "an offline writer's edits merge on reconnect";
  await b.context().setOffline(true);
  await selectText(b, "and more.", true);
  await b.keyboard.type(" Offline line.");
  await expect(b.getByRole("status").filter({ hasText: /Saved locally/ })).toBeVisible();
  await selectText(a, "The quick", true);
  await a.keyboard.type(" online");
  await saved(a);
  await b.context().setOffline(false);
  for (const page of [a, b]) {
    await expect.poll(() => textOf(page), { timeout: 30000 }).toContain("and more. Offline line.");
    await expect.poll(() => textOf(page), { timeout: 30000 }).toContain("The quick online");
  }
  await saved(b);
  complete(stage);

  stage = "a comment follows edits around it; reply, resolve and reopen reach the other writer";
  await selectText(a, "brown fox");
  await a.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const composer = a
    .getByRole("dialog", { name: "Comment on selection", exact: true })
    .getByRole("textbox", { name: "Comment on selection", exact: true });
  await expect(composer).toBeFocused();
  await a.keyboard.type("Is it brown?");
  await a.keyboard.press("ControlOrMeta+Enter");
  await expect
    .poll(async () => (await tool(a, "list_page_comments", { page_id: pageId })).comments.length)
    .toBe(1);
  await selectText(b, "The quick", true);
  await b.keyboard.type(" very");
  await selectText(b, "brown", true);
  await b.keyboard.type(" small");
  await expect.poll(markdown).toContain("brown small fox");
  await expect
    .poll(
      async () =>
        (await tool(a, "list_page_comments", { page_id: pageId })).comments[0].selectionContext,
    )
    .toMatchObject({ status: "attached", text: "brown small fox" });
  await b.getByRole("button", { name: /^Comments/ }).click();
  const thread = b.locator(".thread").first();
  await expect(thread).toContainText("Is it brown?");
  await thread.getByRole("button", { name: "Reply" }).click();
  await expect(thread.getByRole("textbox", { name: "Reply" })).toBeFocused();
  await b.keyboard.type("Yes, brown.");
  await thread.getByRole("button", { name: "Send" }).click();
  await a.getByRole("button", { name: /^Comments/ }).click();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await expect(a.locator("details.resolved-threads > summary")).toHaveText(/Resolved \(1\)/);
  const resolved = a.locator("details.resolved-threads");
  if (!(await resolved.evaluate((element) => element.open)))
    await resolved.locator("summary").click();
  await resolved.locator(".thread").getByRole("button", { name: "1 reply" }).click();
  await expect(resolved.locator(".thread")).toContainText("Yes, brown.");
  await resolved.locator(".thread").getByRole("button", { name: "Reopen" }).click();
  await expect(b.locator(".thread:not(.resolved)")).toHaveCount(1);
  complete(stage);

  stage = "Move to Trash refused by a peer's edit says so in plain words";
  await saved(a);
  // Hold A's delete request until B's edit reaches the host, so the heads A
  // sends are behind the Page.
  let release, intercepted;
  const held = new Promise((resolve) => (release = resolve));
  const deleting = new Promise((resolve) => (intercepted = resolve));
  await a.route("**/api/tools", async (route) => {
    if (route.request().postDataJSON()?.operation === "delete_page") {
      intercepted();
      await held;
    }
    await route.continue();
  });
  a.once("dialog", (dialog) => dialog.accept());
  await a.getByLabel("Document actions").click();
  await a.getByRole("button", { name: /Move to Trash/ }).click();
  // A's delete_page, with the heads A has seen, is parked in the route.
  await deleting;
  await selectText(b, "Offline line.", true);
  await b.keyboard.type(" Peer edit.");
  await expect.poll(markdown).toContain("Peer edit.");
  release();
  await expect(
    a.getByText("Someone edited this Page while it was moving to Trash. Try again."),
  ).toBeVisible();
  await a.unroute("**/api/tools");
  assert.equal((await read()).blocks.length > 0, true, "the Page is still active");
  complete(stage);

  await todo(
    "an agent's same-length edit earlier in a paragraph moves a typist's caret",
    async () => {
      // Wordgard reads the typist's pending DOM input against the agent's newer
      // text and inserts it at the agent's edit (wordgard 0.6.2 addDOMChange).
      const page = (
        await mutate("create_page", { title: "Caret race", markdown: "Status: aaaa. Tail." })
      ).page_id;
      try {
        await a.goto(`${origin}/p/${page}`);
        await selectText(a, "Tail.", true);
        // Each round types one chunk while one agent patch is in flight,
        // then waits for both to show: the chunk at the typist's caret and
        // the patch's replacement. The overlap inside a round is the race
        // this records; nothing else depends on timing.
        const rounds = [
          [" person", "aaaa", "bbbb"],
          [" keeps", "bbbb", "cccc"],
          [" typing", "cccc", "dddd"],
        ];
        let typed = "Status: aaaa. Tail.";
        for (const [chunk, from, to] of rounds) {
          const current = await tool(a, "read_page", { page_id: page });
          await Promise.all([
            a.keyboard.type(chunk, { delay: 40 }),
            tool(a, "patch_page", {
              page_id: page,
              base_heads: current.heads,
              conflict_scope: "target",
              retry_token: current.retry_token,
              idempotency_key: current.retry_key_prefix + crypto.randomUUID(),
              operations: [
                {
                  op: "replace_match",
                  block_id: current.blocks[0].id,
                  match_text: from,
                  replacement: to,
                },
              ],
            }),
          ]);
          typed = typed.replace(from, to) + chunk;
          await expect.poll(() => textOf(a)).toContain(to);
          await expect.poll(async () => (await textOf(a)).length).toBe(typed.length);
        }
        await expect.poll(() => textOf(a)).toBe("Status: dddd. Tail. person keeps typing");
      } finally {
        const current = await tool(a, "read_page", { page_id: page });
        const authority = await tool(a, "list_pages");
        await tool(a, "delete_page", {
          page_id: page,
          base_heads: current.heads,
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
        });
        await purgeTrashedFixture(
          (name, args) => tool(a, name, args),
          page,
          async () => {
            const fresh = await tool(a, "list_pages");
            return {
              retry_token: fresh.retry_token,
              idempotency_key: fresh.retry_key_prefix + crypto.randomUUID(),
            };
          },
        );
      }
    },
  );

  assert.deepEqual(report.errors, [], "no unhandled browser errors");
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = String(error.stack ?? error);
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
    try {
      await a.unroute("**/api/tools").catch(() => {});
      await mutate("delete_page", { page_id: pageId, base_heads: (await read()).heads });
      await purgeTrashedFixture(
        (name, args) => tool(a, name, args),
        pageId,
        async () => {
          const authority = await tool(a, "list_pages");
          return {
            retry_token: authority.retry_token,
            idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
          };
        },
      );
      report.cleanedUp = true;
    } catch (error) {
      report.cleanedUp = false;
      report.cleanupFailure = error.message;
      process.exitCode = 1;
    }
  }
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
