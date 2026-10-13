import { expect, test } from "@playwright/test";

test.describe("Sift overlay surfaces", () => {
  test("category popover resolves host --sift-color-* inputs through its portal", async ({
    page,
  }) => {
    await page.goto("/?dataset=polars-utf8view");
    await page.waitForSelector(".sift-table-container");
    await page.waitForSelector(".sift-row");

    await page.locator('.sift-toggle-btn[data-mode="dark"]').click();

    // A host sets Sift's inputs on an ancestor. Radix portals the popover to
    // <body>, outside the table, so the content must carry its own .sift-root.
    await page.addStyleTag({
      content: `
        :root {
          --sift-color-panel: rgb(1, 2, 3) !important;
          --sift-color-rule: rgb(4, 5, 6) !important;
          --sift-color-ink: rgb(7, 8, 9) !important;
        }
      `,
    });

    await page
      .locator(".sift-th", { hasText: "NAME" })
      .locator(".sift-cat-row", {
        hasText: "others",
      })
      .click();

    const popoverContent = page.locator("[data-radix-popper-content-wrapper] > .sift-root").first();
    await expect(popoverContent).toBeVisible();
    await expect(popoverContent).toHaveClass(/sift-root/);

    const styles = await popoverContent.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    });

    expect(styles.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(styles.borderColor).toBe("rgb(4, 5, 6)");
    expect(styles.color).toBe("rgb(7, 8, 9)");
  });
});
