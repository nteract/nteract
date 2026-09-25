import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ensureCodeCell,
  getCellSource,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

let mcp: McpPeer;
test.afterEach(async () => {
  await mcp?.close();
});

function cellById(page: Page, id: string) {
  return page.locator(`[data-cell-type][data-cell-id="${id}"]`);
}
function editor(cell: Locator) {
  return cell.locator('.cm-content[contenteditable="true"]');
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
async function edit(cell: Locator) {
  if (!(await editor(cell).isVisible()))
    await cell.getByRole("textbox", { name: "Markdown cell content" }).press("Enter");
  await editor(cell).click();
  await expect(editor(cell)).toBeFocused();
  await settle(cell.page());
}
async function putCaret(cell: Locator, position: number) {
  await editor(cell).evaluate((node, anchor) => {
    const view = (
      node as HTMLElement & {
        cmTile: { view: { dispatch: (tr: unknown) => void; focus: () => void } };
      }
    ).cmTile.view;
    view.dispatch({ selection: { anchor } });
    view.focus();
  }, position);
}
async function caret(cell: Locator) {
  return editor(cell).evaluate(
    (node) =>
      (
        node as HTMLElement & {
          cmTile: { view: { state: { selection: { main: { anchor: number; head: number } } } } };
        }
      ).cmTile.view.state.selection.main.head,
  );
}
async function setup(page: Page) {
  const id = crypto.randomUUID();
  await openNotebookRoom(page, id);
  mcp = await McpPeer.start();
  await mcp.connectNotebook(id);
  const first = await ensureCodeCell(page);
  await setCellSource(first, "# original cell");
  return { id, first };
}

for (const from of ["code", "markdown"] as const) {
  for (const to of ["code", "markdown"] as const) {
    test(`editor Shift+Enter advances from ${from} to an existing ${to} editor`, async ({
      page,
    }) => {
      await setup(page);
      const sourceId = await mcp.createCell(from === "code" ? "# run me" : "# Render me", from);
      const nextId = await mcp.createCell(to === "code" ? "# destination" : "Destination", to);
      await waitForCellCount(page, 3);
      const source = cellById(page, sourceId);
      const next = cellById(page, nextId);
      await edit(source);
      await page.keyboard.press("Shift+Enter");
      await expect(editor(next)).toBeFocused();
      await settle(page);
      await expect(editor(next)).toBeFocused();
      await page.keyboard.type("typed_");
      await expect
        .poll(() => getCellSource(next))
        .toBe(`typed_${to === "code" ? "# destination" : "Destination"}`);
      if (from === "markdown") await expect(editor(source)).toBeHidden();
    });
  }
  for (const key of ["Shift+Enter", "ArrowDown"]) {
    test(`editor ${key} in the last ${from} cell creates a ready-to-type editor`, async ({
      page,
    }) => {
      const { first } = await setup(page);
      const firstId = await first.getAttribute("data-cell-id");
      const sourceId = await mcp.createCell(from === "code" ? "# run me" : "# Render me", from);
      await waitForCellCount(page, 2);
      const source = cellById(page, sourceId);
      await edit(source);
      await putCaret(source, (await getCellSource(source)).length);
      await page.keyboard.press(key);
      await waitForCellCount(page, 3);
      const next = page.locator(
        `[data-cell-type]:not([data-cell-id="${sourceId}"]):not([data-cell-id="${firstId}"])`,
      );
      await expect(editor(next)).toBeFocused();
      await settle(page);
      await page.keyboard.type("typed immediately");
      await expect.poll(() => getCellSource(next)).toBe("typed immediately");
    });
  }
}

for (const action of ["toolbar", "inline"] as const) {
  test(`local ${action} markdown insertion is immediately ready to type`, async ({ page }) => {
    await setup(page);
    if (action === "toolbar") await page.getByTestId("add-markdown-cell-button").click();
    else {
      const adder = page.locator('[data-slot="cell-adder"][data-terminal]');
      await adder.hover();
      await adder.getByRole("button", { name: "Add markdown cell", exact: true }).click();
    }
    await waitForCellCount(page, 2);
    const added = page.locator('[data-cell-type="markdown"]');
    await expect(editor(added)).toBeFocused();
    await page.keyboard.type("local insertion");
    await expect.poll(() => getCellSource(added)).toBe("local insertion");
  });
}

for (const typingIn of ["code", "markdown"] as const) {
  for (const action of [
    "render",
    "advance-existing",
    "advance-last",
    "insert-markdown",
    "insert-inline",
  ] as const) {
    test(`remote ${action} preserves another peer's ${typingIn} caret and subsequent typing`, async ({
      context,
      page,
    }) => {
      const { id, first } = await setup(page);
      const markdownId = await mcp.createCell("# Remote markdown", "markdown");
      if (action === "advance-existing") await mcp.createCell("# Next cell", "code");
      await waitForCellCount(page, action === "advance-existing" ? 3 : 2);
      const remoteMarkdown = cellById(page, markdownId);
      await edit(remoteMarkdown);
      const peer = await context.newPage();
      await openNotebookRoom(peer, id);
      const typingCell = cellById(
        peer,
        typingIn === "code" ? (await first.getAttribute("data-cell-id"))! : markdownId,
      );
      await edit(typingCell);
      await putCaret(typingCell, 3);
      const original = await getCellSource(typingCell);
      // Send real typing and presence before the other participant's action.
      await peer.keyboard.type("before_");
      await expect
        .poll(() => getCellSource(typingIn === "code" ? first : remoteMarkdown))
        .toBe(`${original.slice(0, 3)}before_${original.slice(3)}`);
      const position = 10;
      await expect.poll(() => caret(typingCell)).toBe(position);

      if (action === "insert-inline") {
        const adder = page.locator('[data-slot="cell-adder"][data-terminal]');
        await adder.hover();
        await adder.getByRole("button", { name: "Add markdown cell", exact: true }).click();
      } else if (action === "insert-markdown")
        await page.getByTestId("add-markdown-cell-button").click();
      else await page.keyboard.press(action === "render" ? "Control+Enter" : "Shift+Enter");
      if (action === "advance-last" || action === "insert-markdown" || action === "insert-inline")
        await waitForCellCount(peer, 3);
      if (action !== "insert-markdown" && action !== "insert-inline")
        await expect(editor(remoteMarkdown)).toBeHidden();
      await settle(peer);
      await expect(editor(typingCell)).toBeVisible();
      await expect(editor(typingCell)).toBeFocused();
      expect(await caret(typingCell)).toBe(position);
      await peer.keyboard.type("after_");
      const expected = `${original.slice(0, 3)}before_after_${original.slice(3)}`;
      await expect.poll(() => getCellSource(typingCell)).toBe(expected);
      await expect
        .poll(() => getCellSource(typingIn === "code" ? first : remoteMarkdown))
        .toBe(expected);
      await peer.close();
    });
  }
}
