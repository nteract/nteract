/** Real local celld cloud UI smoke; requires the opt-in managed Python provider. */
import { chromium, expect } from "@playwright/test";
import { createHash } from "node:crypto";
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
const blobBytes = `concurrent immutable output ${notebook.notebook_id}`;
const blobHash = createHash("sha256").update(blobBytes).digest("hex");
const blobUrl = new URL(`/api/n/${notebook.notebook_id}/blobs/${blobHash}`, origin);
blobUrl.search = fixtureUrl.search;
const uploads = await Promise.all(
  Array.from({ length: 8 }, async (_, index) => {
    const contentType = index % 2 ? "text/html" : "text/plain";
    const response = await fetch(blobUrl, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: blobBytes,
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, contentType };
  }),
);
expect(uploads.filter((upload) => upload.status === 201)).toHaveLength(1);
expect(uploads.filter((upload) => upload.status === 200)).toHaveLength(7);
const storedBlob = await fetch(blobUrl, { signal: AbortSignal.timeout(30_000) });
expect(storedBlob.headers.get("content-type")).toBe(
  uploads.find((upload) => upload.status === 201).contentType,
);
expect(await storedBlob.text()).toBe(blobBytes);
const browser = await chromium.launch({ headless: true });
const started = performance.now();
const measurements = {};
let ownerPage;
const pendingRequests = new Map();
const browserErrors = [];
try {
  async function client(scope) {
    const clientUser = scope === "owner" ? user : `${user}-${scope}`;
    if (scope !== "owner") {
      const aclUrl = new URL(`/api/n/${notebook.notebook_id}/acl`, origin);
      aclUrl.search = fixtureUrl.search;
      const granted = await fetch(aclUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject_kind: "principal",
          subject: `user:dev:${clientUser}`,
          scope,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (granted.status !== 201)
        throw Error(`Grant ${scope}: ${granted.status} ${await granted.text()}`);
    }
    const context = await browser.newContext({
      storageState: storageStateForDevIdentity({
        origin: origin.origin,
        token: "local-dev-token",
        user: clientUser,
        scope,
      }),
    });
    await context.addInitScript(() => {
      const Original = window.WebSocket;
      window.__smokeRoomSockets = [];
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          this.heldNotebookSync = [];
          window.__smokeRoomSockets.push(this);
        }
        send(data) {
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null;
          if (window.__smokeHoldNotebookSync && bytes?.[0] === 0) {
            this.heldNotebookSync.push(data);
            return;
          }
          super.send(data);
          if (window.__smokeHoldNotebookSync && bytes?.[0] === 1) {
            window.__smokeHoldNotebookSync = false;
            window.__smokeReorderedSyncFrames = this.heldNotebookSync.length;
            for (const frame of this.heldNotebookSync.splice(0)) super.send(frame);
          }
        }
      };
    });
    const page = await context.newPage();
    page.on("request", (request) => pendingRequests.set(request, performance.now()));
    page.on("requestfinished", (request) => pendingRequests.delete(request));
    page.on("requestfailed", (request) => {
      pendingRequests.delete(request);
      browserErrors.push({ scope, url: request.url(), failure: request.failure() });
    });
    page.on("pageerror", (error) => browserErrors.push({ scope, error: String(error) }));
    page.setDefaultTimeout(60000);
    await page.goto(`${notebook.viewer_url}?mode=${scope === "viewer" ? "view" : "edit"}`);
    return page;
  }
  const owner = await client("owner");
  ownerPage = owner;
  const explicitAttach = process.env.NOTEBOOK_CLOUD_PYTHON_EXPLICIT_ATTACH === "1";
  if (explicitAttach) {
    await owner.getByRole("button", { name: "Start compute", exact: true }).click();
    measurements.attachClickedMs = performance.now() - started;
    await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toBeVisible({
      timeout: 60000,
    });
    measurements.readyMs = performance.now() - started;
  } else {
    await expect(owner.getByTestId("execute-button").first()).toBeEnabled();
    await expect(owner.getByRole("button", { name: "Restart kernel", exact: true })).toHaveCount(0);
  }
  async function execute(source, expected, state = "ran") {
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
    measurements.firstRunRequestedMs ??= performance.now() - started;
    await owner.getByTestId("execute-button").first().click();
    await expect(owner.getByText(expected, { exact: true })).toBeVisible({ timeout: 60000 });
    await expect(owner.getByTestId("execute-button").first()).toHaveAttribute(
      "data-execution-state",
      state,
      { timeout: 10000 },
    );
  }
  await execute(
    "persisted = 41\nprint('managed first output', persisted + 1)",
    "managed first output 42",
  );
  measurements.firstOutputMs = performance.now() - started;
  await execute("x", "NameError: name 'x' is not defined", "error");
  await execute("print('after name error', persisted)", "after name error 41");
  // A valid command naming a missing cell is rejected at the room boundary.
  // The document must stay editable and the next request must clear its notice.
  await owner.evaluate(() => {
    const socket = window.__smokeRoomSockets.find(
      (socket) => socket.readyState === 1 && new URL(socket.url).pathname.endsWith("/sync"),
    );
    const payload = new TextEncoder().encode(
      JSON.stringify({
        id: "missing-cell-probe",
        action: "execute_cell",
        cell_id: "missing-cell-probe",
      }),
    );
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = 1;
    frame.set(payload, 1);
    socket.send(frame);
  });
  await expect(owner.getByText("Request could not run.", { exact: true })).toBeVisible();
  await expect(owner.getByText("Unable to load notebook.", { exact: true })).toHaveCount(0);
  await execute("print('after rejected request', persisted)", "after rejected request 41");
  await expect(owner.getByText("Request could not run.", { exact: true })).toHaveCount(0);
  // Deliberately put execution ahead of the edit's sync frame on the same
  // socket. The room must keep reading while its causal fence waits.
  await owner.evaluate(() => {
    window.__smokeHoldNotebookSync = true;
  });
  await execute("print('managed retained value', persisted)", "managed retained value 41");
  expect(await owner.evaluate(() => window.__smokeReorderedSyncFrames)).toBeGreaterThan(0);
  const viewer = await client("viewer");
  await expect(viewer.getByText("managed retained value 41", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(viewer.getByRole("button", { name: "Restart kernel", exact: true })).toHaveCount(0);
  await expect(viewer.getByTestId("execute-button")).toHaveCount(0);
  const editor = await client("editor");
  await expect(editor.getByText("managed retained value 41", { exact: true })).toBeVisible();
  const cellId = await owner.locator("[data-cell-id]").first().getAttribute("data-cell-id");
  if (!cellId) throw Error("Missing synced cell identity");
  for (const [scope, page] of [
    ["viewer", viewer],
    ["editor", editor],
  ]) {
    await expect(page.getByTestId("execute-button")).toHaveCount(0);
    const denial = await page.evaluate(async (cellId) => {
      const socket = window.__smokeRoomSockets.find(
        (socket) => socket.readyState === 1 && new URL(socket.url).pathname.endsWith("/sync"),
      );
      if (!socket) throw Error("Missing notebook socket");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.removeEventListener("message", receive);
          reject(Error("Missing server denial"));
        }, 5000);
        async function receive(event) {
          if (typeof event.data === "string") return;
          const bytes = new Uint8Array(
            event.data instanceof Blob ? await event.data.arrayBuffer() : event.data,
          );
          if (bytes[0] !== 7) return;
          const message = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (message.type !== "cloud_frame_rejected") return;
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
          resolve(message);
        }
        socket.addEventListener("message", receive);
        const payload = new TextEncoder().encode(
          JSON.stringify({ id: "forbidden-execution", action: "execute_cell", cell_id: cellId }),
        );
        const frame = new Uint8Array(payload.length + 1);
        frame[0] = 1;
        frame.set(payload, 1);
        socket.send(frame);
      });
    }, cellId);
    expect(denial.reason).toContain(`${scope} cannot write request frames`);
    const attachment = await page.request.post(
      new URL(`/api/n/${notebook.notebook_id}/workstation-attachments`, origin).href,
      { data: { workstation_id: "celld-preview-python" } },
    );
    expect(attachment.status()).toBe(403);
  }
  await execute(
    "from IPython.display import display, clear_output\nprint('managed discarded output')\nclear_output(wait=True)\nlive_display = display('managed display before', display_id=True)\nlive_display.update('managed display ' + 'after')",
    "'managed display after'",
  );
  await expect(owner.getByText("managed discarded output", { exact: true })).toHaveCount(0);
  await expect(viewer.getByText("'managed display after'", { exact: true })).toBeVisible();
  await execute(
    "display('managed clear ' + 'gone')\nclear_output(wait=False)\nprint('managed clear remains', persisted)",
    "managed clear remains 41",
  );
  await expect(owner.getByText("'managed clear gone'", { exact: true })).toHaveCount(0);
  await execute(
    "import pandas as pd\nimport matplotlib.pyplot as plt\ndisplay(pd.DataFrame({'managed_sample': [2, 4]}))\nplt.plot([1, 2], [3, 4])\nplt.show()\nprint('managed science', persisted)",
    "managed science 41",
  );
  for (const page of [owner, viewer, editor]) {
    await expect(page.getByText("managed science 41", { exact: true })).toBeVisible();
    await expect(
      page.frameLocator('[data-slot="isolated-frame"]').getByRole("table"),
    ).toContainText("managed_sample");
    await expect
      .poll(async () =>
        page
          .locator("[data-cell-id] img")
          .evaluateAll((images) => images.some((img) => img.complete && img.naturalWidth > 100)),
      )
      .toBe(true);
  }
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
  // A running cell is interrupted cooperatively and keeps its variables.
  const interruptStarted = performance.now();
  await owner.getByRole("button", { name: "Interrupt kernel", exact: true }).click();
  await expect(owner.getByText("KeyboardInterrupt", { exact: false }).first()).toBeVisible({
    timeout: 10000,
  });
  measurements.interruptToKeyboardInterruptMs = performance.now() - interruptStarted;
  await execute("print('managed interrupt kept', interrupted_value)", "managed interrupt kept 123");
  // Interrupt with nothing running still terminates the session (and frees
  // its slot); Start compute creates a clean replacement.
  const detachStarted = performance.now();
  await owner.getByRole("button", { name: "Interrupt kernel", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Start compute", exact: true })).toBeVisible({
    timeout: 10000,
  });
  measurements.interruptToDetachedMs = performance.now() - detachStarted;
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
          "concurrent_blob_upload_preserves_first_writer_metadata",
          explicitAttach ? "first_attach_without_reconnect" : "first_run_allocates_without_attach",
          "persistent_variables",
          "name_error_is_cell_output_and_session_survives",
          "rejected_command_recovers_without_reload",
          "execution_waits_for_later_sync_on_same_socket",
          "viewer_convergence",
          "distinct_viewer_and_editor_converge",
          "viewer_and_editor_server_reject_execution_and_attachment",
          "display_update_and_clear_preserve_session",
          "dataframe_and_plot_render_for_three_clients",
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
  console.error(
    JSON.stringify(
      {
        browserErrors,
        pendingRequests: Array.from(pendingRequests, ([request, since]) => ({
          url: request.url(),
          ageMs: performance.now() - since,
        })),
      },
      null,
      2,
    ),
  );
  if (ownerPage) console.error(await ownerPage.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
