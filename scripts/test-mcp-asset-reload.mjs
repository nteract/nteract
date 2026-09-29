/** Opt-in development integration regression. Run in a disposable worktree:
 * node scripts/test-mcp-asset-reload.mjs
 * Builds source assets, starts an isolated MCP supervisor (no environment pools),
 * temporarily edits a lazy renderer and widget CSS, and restores both in finally.
 * Checks discovery and resource bytes, not host UI rendering or host cache policy.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
process.chdir(root);
process.env.RUNT_BUILD_CHANNEL ??= "nightly";
fs.mkdirSync(".context/mcp-asset-reload", { recursive: true });
const log = fs.openSync(".context/mcp-asset-reload/supervisor.log", "w");
const run = (args) => execFileSync("cargo", args, { cwd: root, stdio: ["ignore", log, log] });
run(["xtask", "artifacts", "ensure", "all"]);
run(["build", "-p", "runt", "-p", "runtimed", "-p", "mcp-supervisor"]);
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const source = "src/isolated-renderer/bokeh-renderer.tsx";
const css = "apps/mcp-app/src/style.css";
const original = fs.readFileSync(source, "utf8");
const originalCss = fs.readFileSync(css, "utf8");
const asset = "apps/notebook/src/renderer-plugins/bokeh.js";
const originalAsset = fs.readFileSync(asset);
const child = spawn("cargo", ["xtask", "run-mcp"], {
  cwd: root, detached: process.platform !== "win32",
  env: { ...process.env, RUST_LOG: "info", NTERACT_DEV_MODE: "isolated", NTERACT_DEV_WATCH: "1", SKIP_MATURIN: "1" },
  stdio: ["pipe", "pipe", log],
});
const pending = new Map();
child.on("exit", (code, signal) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`MCP exited: ${code ?? signal}`));
  }
  pending.clear();
});
let nextId = 0;
const notifications = [];
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line); // Any build chatter on MCP stdout fails this test.
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } else notifications.push(message.method);
});
function send(message) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 300_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
async function status() {
  const result = await request("tools/call", { name: "status", arguments: {} });
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
async function widgetUri() {
  const result = await request("tools/list");
  return result.tools.find((tool) => tool.name === "execute_cell")._meta.ui.resourceUri;
}
async function waitFor(check, label) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function resourceBytes(uri) {
  const result = await request("resources/read", { uri });
  const resource = result.contents.find((item) => item.uri === uri);
  assert.ok(resource, `resource response for ${uri}`);
  return "blob" in resource ? Buffer.from(resource.blob, "base64") : Buffer.from(resource.text);
}
const evidence = {};
try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "asset-reload-regression", version: "1" } });
  send({ method: "notifications/initialized" });
  await waitFor(async () => (await status()).child_running, "child startup");
  await waitFor(() => fs.readFileSync(".context/mcp-asset-reload/supervisor.log", "utf8").includes("Watching"), "watcher startup");
  const firstUri = await widgetUri();
  assert.match(firstUri, /^ui:\/\/nteract\/output-[0-9a-f]+\.html$/);
  const firstHtml = await resourceBytes(firstUri);
  assert.deepEqual(await resourceBytes("nteract://renderer-assets/bokeh.js"), originalAsset);
  const baselineStatus = await status();
  const stableOutput = "apps/notebook/src/renderer-plugins/plotly.js";
  const stableTime = fs.statSync(stableOutput).mtimeMs;
  // Timestamp-only edits must not relink or restart the child.
  const binaryTime = fs.statSync("target/debug/runt").mtimeMs;
  fs.utimesSync(source, new Date(), new Date());
  await waitFor(() => fs.readFileSync(".context/mcp-asset-reload/supervisor.log", "utf8").includes("Build was a no-op"), "no-op watcher build");
  assert.equal(fs.statSync("target/debug/runt").mtimeMs, binaryTime);
  assert.equal(await widgetUri(), firstUri);
  assert.equal((await status()).restart_count, baselineStatus.restart_count);
  console.log("No-op watcher build preserved child and widget identity");

  const marker = "MCP_ASSET_RELOAD_SENTINEL";
  assert.ok(original.includes("Failed to load Bokeh stylesheet"));
  fs.writeFileSync(source, original.replace("Failed to load Bokeh stylesheet", marker));
  const secondUri = await waitFor(async () => {
    const uri = await widgetUri();
    return uri !== firstUri ? uri : null;
  }, "lazy renderer discovery refresh");
  const updatedAsset = fs.readFileSync(asset);
  assert.ok(updatedAsset.includes(Buffer.from(marker)));
  assert.deepEqual(await resourceBytes("nteract://renderer-assets/bokeh.js"), updatedAsset);
  const secondHtml = await resourceBytes(secondUri);
  assert.notDeepEqual(secondHtml, firstHtml);
  assert.ok(secondHtml.includes(Buffer.from(digest(updatedAsset).slice(0, 16))));
  const listed = await request("resources/list");
  assert.ok(listed.resources.some((resource) => resource.uri === secondUri));
  assert.equal(fs.statSync(stableOutput).mtimeMs, stableTime, "unrelated plugin was not rebuilt");
  assert.equal((await status()).socket_path, baselineStatus.socket_path);
  console.log("Lazy renderer edit refreshed tools/resources and served exact new bytes");

  fs.writeFileSync(css, `${originalCss}\n/* dev reload probe */\nbody { --mcp-reload-probe: 1; }\n`);
  const thirdUri = await waitFor(async () => {
    const uri = await widgetUri();
    return uri !== secondUri ? uri : null;
  }, "widget CSS discovery refresh");
  assert.ok((await resourceBytes(thirdUri)).includes(Buffer.from("--mcp-reload-probe")));
  assert.equal(fs.statSync(stableOutput).mtimeMs, stableTime);
  assert.ok(notifications.includes("notifications/tools/list_changed"));
  assert.ok(notifications.includes("notifications/resources/list_changed"));
  Object.assign(evidence, { firstUri, secondUri, thirdUri, originalAssetSha256: digest(originalAsset), updatedAssetSha256: digest(updatedAsset), notifications });
  console.log("Widget CSS edit refreshed discovery; compatibility alias remains readable");
  assert.deepEqual(await resourceBytes("ui://nteract/output.html"), await resourceBytes(thirdUri));
} finally {
  fs.writeFileSync(source, original);
  fs.writeFileSync(css, originalCss);
  child.stdin.end();
  if (child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(15_000)]);
  }
  if (child.exitCode === null) {
    if (process.platform === "win32") child.kill();
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  }
  for (const request of pending.values()) clearTimeout(request.timer);
  fs.closeSync(log);
  fs.writeFileSync(".context/mcp-asset-reload/evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
}
