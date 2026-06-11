import { expect, test } from "@playwright/test";

test.describe("Sift overlay surfaces", () => {
  test("category popover remains opaque when theme panel variables are missing", async ({
    page,
  }) => {
    await page.goto("/?dataset=polars-utf8view");
    await page.waitForSelector(".sift-table-container");
    await page.waitForSelector(".sift-row");

    await page.locator('.sift-toggle-btn[data-mode="dark"]').click();

    await page.addStyleTag({
      content: `
        :root,
        :root[data-theme="dark"],
        :root.dark {
          --sift-panel: initial !important;
          --sift-rule: initial !important;
          --sift-ink: initial !important;
        }
      `,
    });

    await page
      .locator(".sift-th", { hasText: "NAME" })
      .locator(".sift-cat-row", {
        hasText: "others",
      })
      .click();

    const popoverContent = page
      .locator("[data-radix-popper-content-wrapper] > .sift-overlay-surface")
      .first();
    await expect(popoverContent).toBeVisible();

    const styles = await popoverContent.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    });

    expect(styles.backgroundColor).toBe("rgb(23, 23, 23)");
    expect(styles.borderColor).toBe("rgb(42, 42, 42)");
    expect(styles.color).toBe("rgb(229, 229, 229)");
  });
});
