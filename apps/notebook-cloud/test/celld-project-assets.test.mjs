import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyCelldProjectAssets } from "../scripts/celld-project-assets.mjs";

test("celld copies renderer sidecars once and preserves the Cloudflare dist", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "celld-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const plugins = ["sift_wasm.wasm", "sift_wasm.1234567890abcdef.wasm"];
  await mkdir(path.join(app, "dist/plugins"), { recursive: true });
  await mkdir(path.join(app, "dist/assets"));
  await mkdir(path.join(app, "dist-output-document"));
  await writeFile(path.join(app, "dist/assets/viewer.js"), "viewer");
  await writeFile(path.join(app, "dist/assets/runtime.wasm"), "runtime");
  await writeFile(path.join(app, "dist-output-document/index.html"), "frame");
  await writeFile(path.join(app, "dist/plugins", plugins[0]), "renderer wasm");
  await symlink(plugins[0], path.join(app, "dist/plugins", plugins[1]));

  for (const worker of [
    { name: "main", assets: "dist" },
    { name: "renderer-assets", assets: "dist/plugins" },
    { name: "outputs", assets: "dist-output-document" },
  ]) {
    await copyCelldProjectAssets(worker, app, path.join(root, worker.name));
  }
  assert.deepEqual(await readdir(path.join(root, "main")), ["assets"]);
  assert.equal(await readFile(path.join(root, "main/assets/viewer.js"), "utf8"), "viewer");
  assert.equal(await readFile(path.join(root, "main/assets/runtime.wasm"), "utf8"), "runtime");
  assert.equal(await readFile(path.join(root, "outputs/index.html"), "utf8"), "frame");
  assert.deepEqual((await readdir(path.join(root, "renderer-assets"))).sort(), plugins.sort());
  for (const name of plugins) {
    assert.equal(await readFile(path.join(root, "renderer-assets", name), "utf8"), "renderer wasm");
    assert.equal(await readFile(path.join(app, "dist/plugins", name), "utf8"), "renderer wasm");
  }
});
