import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("celld aliases only verified identical stable and content-hashed renderer files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "celld-asset-aliases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const source = path.join(app, "dist/plugins");
  const output = path.join(root, "export");
  await mkdir(source, { recursive: true });
  const files = {
    "sift_wasm.wasm": "renderer wasm",
    "isolated-renderer.js": "renderer JavaScript",
    "isolated-renderer.css": "renderer CSS",
  };
  const expectedAliases = {};
  for (const [stable, contents] of Object.entries(files)) {
    const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
    const hashed = stable.replace(/\.(\w+)$/, `.${hash}.$1`);
    await writeFile(path.join(source, stable), contents);
    // Existing build output may use symlinks; export must still be regular files.
    await symlink(stable, path.join(source, hashed));
    expectedAliases[stable] = hashed;
  }
  await writeFile(path.join(source, "wrong.wasm"), "same bytes, invalid hash");
  await writeFile(path.join(source, "wrong.1234567890abcdef.wasm"), "same bytes, invalid hash");
  const oldHash = createHash("sha256").update("old renderer").digest("hex").slice(0, 16);
  await writeFile(path.join(source, "changed.js"), "new renderer");
  await writeFile(path.join(source, `changed.${oldHash}.js`), "old renderer");
  await mkdir(path.join(source, "directory.1234567890abcdef.js"));

  const aliases = await copyCelldProjectAssets(
    { name: "renderer-assets", assets: "dist/plugins" },
    app,
    output,
  );
  assert.deepEqual(aliases, expectedAliases);
  const exportedNames = await readdir(output);
  for (const [stable, contents] of Object.entries(files)) {
    assert.ok(!exportedNames.includes(stable));
    assert.equal(await readFile(path.join(output, aliases[stable]), "utf8"), contents);
    assert.equal(await readFile(path.join(source, stable), "utf8"), contents);
    assert.equal(await readFile(path.join(source, aliases[stable]), "utf8"), contents);
  }
  for (const stable of ["wrong.wasm", "changed.js"]) {
    assert.equal(
      await readFile(path.join(output, stable), "utf8"),
      await readFile(path.join(source, stable), "utf8"),
    );
  }
});
