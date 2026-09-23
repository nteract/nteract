/** Real local celld cloud UI smoke; requires the opt-in managed Python provider. */
import { chromium, expect } from "@playwright/test";
import { storageStateForDevIdentity } from "./hosted-collab-smoke-env.mjs";

const origin = new URL(
  process.env.NOTEBOOK_CLOUD_MANAGED_PYTHON_ORIGIN ?? "http://127.0.0.1:18476",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) {
  throw new Error("This smoke creates dev-auth fixtures and must target loopback");
}
const user = `python-browser-${Date.now()}`;
const fixtureUrl = new URL("/api/n", origin);
fixtureUrl.search = new URLSearchParams({ user, scope: "owner", operator: "browser:smoke" });
const response = await fetch(fixtureUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Managed Python browser smoke" }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Create notebook: ${response.status} ${await response.text()}`);
const notebook = await response.json();
const browser = await chromium.launch({ headless: true });
const started = performance.now();
const measurements = {};
let ownerPage;
try {
  async function client(scope) {
    const context = await browser.newContext({
      storageState: storageStateForDevIdentity({
        origin: origin.origin,
        token: "local-dev-token",
        user,
        scope,
      }),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${notebook.viewer_url}?mode=${scope === "owner" ? "edit" : "view"}`);
    return page;
  }
  const owner = await client("owner");
  ownerPage = owner;
  await owner.getByRole("button", { name: "Start compute", exact: true }).click();
  measurements.attachClickedMs = performance.now() - started;
  await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
    timeout: 60000,
  });
  measurements.readyMs = performance.now() - started;
  async function execute(source, expected) {
    console.error(`Checking: ${expected}`);
    const editor = owner.locator(".cm-content").first();
    // Replace through CodeMirror's transaction API, as the existing cloud
    // workstation smoke does. DOM fill can race its document reconciliation.
    await editor.evaluate((node, text) => {
      const view = node.cmTile?.view;
      if (!view) throw new Error("CodeMirror view unavailable");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      view.focus();
    }, source);
    await expect
      .poll(() => editor.evaluate((node) => node.cmTile.view.state.doc.toString()))
      .toBe(source);
    // The UI execution path flushes the live document before requesting by cell_id.
    await owner.getByTestId("execute-button").first().click();
    await expect(owner.getByText(expected, { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(owner.getByTestId("execute-button").first()).toHaveAttribute(
      "data-execution-state",
      "ran",
      { timeout: 10000 },
    );
  }
  await execute(
    "persisted = 41\nprint('managed first output', persisted + 1)",
    "managed first output 42",
  );
  measurements.firstOutputMs = performance.now() - started;
  await execute("print('managed retained value', persisted)", "managed retained value 41");
  const viewer = await client("viewer");
  await expect(viewer.getByText("managed retained value 41", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(viewer.getByRole("button", { name: "Restart kernel", exact: true })).toHaveCount(0);
  await expect(viewer.getByTestId("execute-button")).toHaveCount(0);
  const replacement = owner.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/workstation-attachments"),
  );
  await owner.getByRole("button", { name: "Restart kernel", exact: true }).click();
  const restarted = await replacement;
  if (restarted.status() !== 202) throw new Error(`Restart: ${await restarted.text()}`);
  await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
    timeout: 60000,
  });
  await execute("print('managed reset', 'persisted' in globals())", "managed reset False");
  await expect(viewer.getByText("managed reset False", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await owner.reload();
  await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
    timeout: 15000,
  });
  await execute("print('managed reconnect', 6 * 7)", "managed reconnect 42");
  await owner
    .locator(".cm-content")
    .first()
    .evaluate((node) => {
      const view = node.cmTile.view;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "import asyncio\ninterrupted_value = 123\nawait asyncio.sleep(60)",
        },
      });
      view.focus();
    });
  await owner.getByTestId("execute-button").first().click();
  await expect(owner.getByTestId("execute-button").first()).toHaveAttribute(
    "data-execution-state",
    "running",
  );
  const interruptStarted = performance.now();
  await owner.getByRole("button", { name: "Interrupt kernel", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Start compute", exact: true })).toBeVisible({
    timeout: 10000,
  });
  measurements.interruptToDetachedMs = performance.now() - interruptStarted;
  await owner.getByRole("button", { name: "Start compute", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
    timeout: 60000,
  });
  await execute(
    "print('managed interrupt replacement', 'interrupted_value' in globals())",
    "managed interrupt replacement False",
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        notebook: notebook.viewer_url,
        measurements,
        checks: [
          "first_attach_without_reconnect",
          "persistent_variables",
          "viewer_convergence",
          "viewer_cannot_execute",
          "restart_clears_variables",
          "owner_reconnect",
          "interrupt_detaches_and_replacement_is_clean",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (ownerPage) console.error(await ownerPage.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
