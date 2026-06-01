/**
 * E2E Test: Cell Visibility Toggles (fixture-based)
 *
 * Uses a pre-built notebook fixture with input + output already present.
 * No kernel launch needed — this tests pure UI behavior.
 *
 * Fixture: crates/notebook/fixtures/audit-test/14-cell-visibility.ipynb
 * Run with: cargo xtask e2e test-fixture \
 *   crates/notebook/fixtures/audit-test/14-cell-visibility.ipynb \
 *   e2e/specs/cell-visibility.spec.js
 *
 * Tests:
 * - Hide/show input via gutter button
 * - Hide/show outputs via gutter button
 * - Compact "Cell hidden" chip when both are hidden
 */

import { browser } from "@wdio/globals";
import { waitForAppReady, waitForNotebookSynced } from "../helpers.js";

/**
 * Focus a code cell by clicking its editor area.
 *
 * The right-gutter buttons (Hide input, Hide outputs, Delete) use
 * `sm:opacity-0 sm:group-hover:opacity-100` with an `isFocused && "sm:opacity-100"`
 * override. WebDriver's moveTo() does not reliably trigger CSS :hover in
 * WebKit/WRY, so we focus the cell instead — setting isFocused makes the
 * gutter buttons visible at sm:opacity-100.
 */
async function focusCell(codeCell) {
  const editor = await codeCell.$(".cm-content[contenteditable]");
  if (await editor.isExisting()) {
    await editor.click();
  } else {
    // If input is hidden, click the cell container itself
    await codeCell.click();
  }
  await browser.pause(300);
}

describe("Cell Visibility Toggles", () => {
  it("should have a cell with input and output from fixture", async () => {
    await waitForAppReady();
    await waitForNotebookSynced();

    // The fixture notebook has a code cell with pre-existing output
    const codeCell = await $('[data-cell-type="code"]');
    await codeCell.waitForExist({ timeout: 10000 });

    // Verify input is present
    const editor = await codeCell.$(".cm-content[contenteditable]");
    expect(await editor.isExisting()).toBe(true);

    // Verify output is present (stream output from the fixture)
    const outputArea = await codeCell.$('[data-slot="output-area"]');
    expect(await outputArea.isExisting()).toBe(true);
  });

  it("should hide input when clicking input toggle button", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Focus the cell to make gutter buttons visible (isFocused → sm:opacity-100).
    // moveTo() doesn't trigger CSS :hover in WRY's WebDriver.
    await focusCell(codeCell);

    // Find and click the input toggle button (Code2 icon with "Hide input" title)
    const hideInputButton = await codeCell.$('button[title="Hide input"]');
    await hideInputButton.waitForClickable({ timeout: 5000 });
    await hideInputButton.click();
    await browser.pause(300);

    // Verify the input disclosure appears (collapsed state)
    const inputDisclosure = await codeCell.$('button[title="Show input"]');
    expect(await inputDisclosure.isExisting()).toBe(true);

    // The editor should no longer be visible
    const editor = await codeCell.$('.cm-content[contenteditable="true"]');
    expect(await editor.isExisting()).toBe(false);
  });

  it("should show input when clicking the input disclosure", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Click the input disclosure to expand
    const inputDisclosure = await codeCell.$('button[title="Show input"]');
    await inputDisclosure.waitForClickable({ timeout: 5000 });
    await inputDisclosure.click();
    await browser.pause(300);

    // The editor should now be visible again
    const editor = await codeCell.$('.cm-content[contenteditable="true"]');
    await editor.waitForExist({ timeout: 5000 });
    expect(await editor.isExisting()).toBe(true);
  });

  it("should hide outputs when clicking output toggle button", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Focus the cell to make gutter buttons visible
    await focusCell(codeCell);

    // Find and click the output toggle button (EyeOff icon with "Hide outputs" title)
    const hideOutputButton = await codeCell.$('button[title="Hide outputs"]');
    await hideOutputButton.waitForClickable({ timeout: 5000 });
    await hideOutputButton.click();
    await browser.pause(300);

    // Verify the outputs disclosure appears
    const outputsDisclosure = await codeCell.$('button[title="Show outputs"]');
    expect(await outputsDisclosure.isExisting()).toBe(true);

    // The disclosure should use the hidden-output language from the app.
    const disclosureText = await outputsDisclosure.getText();
    expect(disclosureText).toContain("Output hidden");
  });

  it("should show outputs when clicking the outputs disclosure", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Click the outputs disclosure to expand
    const outputsDisclosure = await codeCell.$('button[title="Show outputs"]');
    await outputsDisclosure.waitForClickable({ timeout: 5000 });
    await outputsDisclosure.click();
    await browser.pause(300);

    // The output should be visible again
    const output = await codeCell.$('[data-slot="ansi-stream-output"]');
    await output.waitForExist({ timeout: 5000 });
    expect(await output.isExisting()).toBe(true);
  });

  it("should show compact layout when both input and outputs are hidden", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Focus the cell to make gutter buttons visible
    await focusCell(codeCell);

    // First hide input
    const hideInputButton = await codeCell.$('button[title="Hide input"]');
    await hideInputButton.waitForClickable({ timeout: 5000 });
    await hideInputButton.click();
    await browser.pause(300);

    // Re-focus to keep gutter buttons visible (focus may shift after input collapse)
    await codeCell.click();
    await browser.pause(300);

    // Then hide outputs
    const hideOutputButton = await codeCell.$('button[title="Hide outputs"]');
    await hideOutputButton.waitForClickable({ timeout: 5000 });
    await hideOutputButton.click();
    await browser.pause(300);

    // A single "Cell hidden" disclosure should appear (compact layout)
    const cellHiddenDisclosure = await codeCell.$('button[title="Show cell"]');
    expect(await cellHiddenDisclosure.isExisting()).toBe(true);
    const disclosureText = await cellHiddenDisclosure.getText();
    expect(disclosureText).toContain("Cell hidden");

    // The editor should not be visible
    const editor = await codeCell.$('.cm-content[contenteditable="true"]');
    expect(await editor.isExisting()).toBe(false);

    // The output area should not be visible
    const output = await codeCell.$('[data-slot="ansi-stream-output"]');
    expect(await output.isExisting()).toBe(false);
  });

  it("should restore cell when clicking Show cell from compact layout", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // Click the "Show cell" disclosure to expand both input and outputs
    const cellHiddenDisclosure = await codeCell.$('button[title="Show cell"]');
    await cellHiddenDisclosure.waitForClickable({ timeout: 5000 });
    await cellHiddenDisclosure.click();
    await browser.pause(300);

    // Both input and outputs should now be visible
    const editor = await codeCell.$('.cm-content[contenteditable="true"]');
    await editor.waitForExist({ timeout: 5000 });
    expect(await editor.isExisting()).toBe(true);

    const output = await codeCell.$('[data-slot="ansi-stream-output"]');
    await output.waitForExist({ timeout: 5000 });
    expect(await output.isExisting()).toBe(true);
  });

  // Skip: error count test requires a running kernel to produce error output.
  // This should be a separate fixture with pre-existing error output, or
  // tested alongside the kernel launch fixture specs.
  it.skip("should show error count on hidden cell chip when cell has error output", async () => {
    const codeCell = await $('[data-cell-type="code"]');

    // TODO: Use a fixture with pre-existing error output instead of executing code
    await focusCell(codeCell);
    const hideInputButton = await codeCell.$('button[title="Hide input"]');
    await hideInputButton.waitForClickable({ timeout: 5000 });
    await hideInputButton.click();
    await browser.pause(300);

    await codeCell.click();
    await browser.pause(300);
    const hideOutputButton = await codeCell.$('button[title="Hide outputs"]');
    await hideOutputButton.waitForClickable({ timeout: 5000 });
    await hideOutputButton.click();
    await browser.pause(300);

    // The disclosure should show "1 error"
    const cellHiddenDisclosure = await codeCell.$('button[title="Show cell"]');
    expect(await cellHiddenDisclosure.isExisting()).toBe(true);
    const chipText = await cellHiddenDisclosure.getText();
    expect(chipText).toContain("1 error");

    // Restore cell for subsequent tests
    await cellHiddenDisclosure.click();
    await browser.pause(300);
  });
});
