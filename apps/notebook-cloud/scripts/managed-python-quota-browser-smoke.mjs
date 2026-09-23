/** Local celld regression: quota failure and same-page recovery. */
import { chromium, expect } from "@playwright/test";
import { storageStateForDevIdentity } from "./hosted-collab-smoke-env.mjs";
const origin = "http://127.0.0.1:18476",
  user = `quota-${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: storageStateForDevIdentity({
    origin,
    token: "local-dev-token",
    user,
    scope: "owner",
  }),
});
const pages = [];
try {
  for (let i = 0; i < 3; i++) {
    const url = new URL("/api/n", origin);
    url.search = new URLSearchParams({ user, scope: "owner", operator: "browser:quota" });
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `Quota recovery ${i}` }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Error(await r.text());
    const notebook = await r.json();
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(60000);
    await page.goto(`${notebook.viewer_url}?mode=edit`);
    await expect(page.locator(".cm-content").first()).toBeVisible();
    await page
      .locator(".cm-content")
      .first()
      .evaluate((node) => {
        const v = node.cmTile.view;
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: "print('quota recovery works')" },
        });
      });
    await page.getByTestId("execute-button").first().click();
    if (i < 2) await expect(page.getByText("quota recovery works", { exact: true })).toBeVisible();
  }
  const third = pages[2];
  await expect(third.getByText("Compute could not start.", { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(third.getByText(/Your Python session limit was reached/).first()).toBeVisible();
  await expect(third.getByText("Unable to load notebook.", { exact: true })).toHaveCount(0);
  await expect(third.getByRole("button", { name: "Retry compute", exact: true })).toBeEnabled();
  await pages[0].getByRole("button", { name: "Interrupt kernel", exact: true }).click();
  await expect(pages[0].getByRole("button", { name: "Start compute", exact: true })).toBeVisible();
  await third.getByRole("button", { name: "Retry compute", exact: true }).click();
  await expect(third.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
    timeout: 60000,
  });
  await third.getByTestId("execute-button").first().click();
  await expect(third.getByText("quota recovery works", { exact: true })).toBeVisible();
  await expect(third.getByText("Request could not run.", { exact: true })).toHaveCount(0);
  console.log(
    "PASS: quota error, usable controls, release another session, retry on same page without reload",
  );
} catch (error) {
  for (const page of pages) console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
