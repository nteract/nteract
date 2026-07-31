import { expect, test } from "@playwright/test";
import {
  openHomePage,
  pauseForVideo,
  screenshot,
  signInWithLocalAuth,
  waitForNotebookToolbar,
} from "./helpers";

test.describe("cloud home to notebook", () => {
  test("signs in with local auth, creates a notebook, and lands on it", async ({ page }) => {
    test.setTimeout(180_000);

    await openHomePage(page);
    await screenshot(page, "signed-out");

    await signInWithLocalAuth(page);
    await pauseForVideo(page);
    await screenshot(page, "signed-in-notebook-list");

    await page
      .locator("header")
      .getByRole("button", { name: /new notebook/i })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await pauseForVideo(page, 300); // let the dialog's entrance animation settle
    await screenshot(page, "create-dialog");

    await pauseForVideo(page);
    await page.getByRole("button", { name: /^create$/i }).click();

    await waitForNotebookToolbar(page);
    await screenshot(page, "notebook-opened");

    await pauseForVideo(page, 1_500);
  });
});
