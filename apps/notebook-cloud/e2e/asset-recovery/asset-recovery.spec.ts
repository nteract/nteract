import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("aborts and retries a stalled successful WASM body in the browser", async ({
  page,
  request,
}) => {
  const id = randomUUID();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const headers = page.waitForResponse((response) => response.url().includes("/__wasm/binary"));
  await page.goto(`/__wasm?case=${id}`);
  expect((await headers).status()).toBe(200);
  // Wait for fetch fulfillment in the page, not only Playwright's network
  // event. Its promise microtasks (including clearing the header deadline)
  // finish before the next page task can advance the virtual clock.
  await expect(page.locator("body")).toHaveAttribute("data-headers-received", "true");
  await expect(page.getByText("Loading WASM", { exact: true })).toBeVisible();
  await page.clock.runFor(20_000);
  await expect
    .poll(async () => (await (await request.get(`/__status?case=${id}`)).json()).aborted)
    .toBe(true);
  await page.clock.runFor(150);
  await expect(page.getByText("WASM ready", { exact: true })).toBeVisible();
  expect((await (await request.get(`/__status?case=${id}`)).json()).requests).toBe(2);
});

for (const asset of ["notebook", "markdown-text", "workstations"]) {
  for (const status of [520, 404]) {
    test(`recovers a ${status} downloading ${asset} from the production bundle`, async ({
      page,
      request,
    }) => {
      const id = randomUUID();
      const path = asset === "workstations" ? "/workstations" : "/n/fixture";
      await page.goto(`${path}?case=${id}&asset=${asset}&status=${status}&failures=1`);
      await expect
        .poll(async () => (await (await request.get(`/__status?case=${id}`)).json()).documents)
        .toBe(2);
      await expect(page.getByText("Opening notebook", { exact: true })).toBeHidden();
      await expect(page.getByText(/Cloud viewer crashed|Couldn't download/)).toBeHidden();
      await expect(
        page.getByRole("region", {
          name: asset === "workstations" ? "Workstations" : "Hosted notebook",
          exact: true,
        }),
      ).toBeVisible();
      expect((await (await request.get(`/__status?case=${id}`)).json()).requests).toBe(2);
    });
  }
}

test("stops automatic reloads after a repeated failure and supports manual retry", async ({
  page,
  request,
}) => {
  const id = randomUUID();
  await page.goto(`/n/fixture?case=${id}&failures=2`);
  await expect(page.getByRole("button", { name: "Reload page" })).toBeVisible();
  expect((await (await request.get(`/__status?case=${id}`)).json()).documents).toBe(2);
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect
    .poll(async () => (await (await request.get(`/__status?case=${id}`)).json()).documents)
    .toBe(3);
  await expect(page.getByRole("button", { name: "Reload page" })).toBeHidden();
  await expect(page.getByText("Opening notebook", { exact: true })).toBeHidden();
  await expect(page.getByRole("region", { name: "Hosted notebook", exact: true })).toBeVisible();
  expect((await (await request.get(`/__status?case=${id}`)).json()).requests).toBe(3);
});

test("does not reload a module that throws an application error", async ({ page, request }) => {
  const id = randomUUID();
  await page.goto(`/n/fixture?case=${id}&status=evaluation&failures=1`);
  await expect(
    page.getByText("Cloud viewer crashed: Application initialization failed"),
  ).toBeVisible();
  expect((await (await request.get(`/__status?case=${id}`)).json()).documents).toBe(1);
});
