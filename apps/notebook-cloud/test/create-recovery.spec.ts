import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("confirmed create navigates to the created notebook without unconfirmed feedback", async ({
  page,
}) => {
  await page.goto(
    `/local-auth?user=create-success-${randomUUID()}&scope=owner&next=%2Fn`,
  );
  await page.getByRole("button", { name: "New notebook", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Title" }).fill("Confirmed local create");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/n\/[^/]+\/notebook\?mode=edit$/);
});

test("committed create with lost response resets dialog and warns before a separate create", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const probe: { committed: unknown; posts: number } = { committed: null, posts: 0 };
    (window as unknown as { createProbe: typeof probe }).createProbe = probe;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/n" || request.method !== "POST")
        return nativeFetch(input, init);
      probe.posts++;
      const response = await nativeFetch(input, init);
      probe.committed = await response.clone().json();
      // The Worker commits, but the browser never receives its confirmation.
      return new Promise<Response>(() => {});
    };
  });

  await page.goto(
    `/local-auth?user=create-browser-${randomUUID()}&scope=owner&next=%2Fn`,
  );
  const trigger = page.getByRole("button", { name: "New notebook", exact: true }).first();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole("textbox", { name: "Title" }).fill("Lost confirmation title");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).createProbe.committed?.notebook_id))
    .toBeTruthy();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Lost confirmation title");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create separate notebook", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Lost confirmation title");
  await expect
    .poll(() => page.evaluate(() => (window as any).createProbe.posts))
    .toBe(1);
});
