import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("celld prepare and export wire deduplicated assets into the renderer Worker", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "celld-export-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realApp = fileURLToPath(new URL("../", import.meta.url));
  const app = path.join(root, "apps/notebook-cloud");
  for (const directory of [
    "scripts",
    "src",
    "dist/plugins",
    "dist-output-document",
    "migrations",
  ]) {
    await mkdir(path.join(app, directory), { recursive: true });
  }
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(app, "package.json"), '{"type":"module"}');
  await symlink(path.join(realApp, "node_modules"), path.join(app, "node_modules"));
  for (const file of [
    "scripts/celld-local.mjs",
    "scripts/celld-project-assets.mjs",
    "src/renderer-assets-worker.ts",
  ]) {
    await cp(path.join(realApp, file), path.join(app, file));
  }
  await writeFile(
    path.join(app, "src/index.ts"),
    "export default {}; export class NotebookRoom {} export class WorkstationEvents {} export class OwnerComputeIndex {} export class NotebookHome {}",
  );
  await writeFile(path.join(app, "src/output-document-worker.ts"), "export default {};");
  await writeFile(
    path.join(app, "src/runtimed-wasm.ts"),
    "export function initializeRuntimedWasm() {}",
  );
  const wasmDir = path.join(root, "apps/notebook/src/wasm/runtimed-wasm");
  await mkdir(wasmDir, { recursive: true });
  await writeFile(
    path.join(wasmDir, "runtimed_wasm_bg.wasm"),
    Buffer.from("0061736d01000000", "hex"),
  );
  await writeFile(path.join(app, "dist-output-document/index.html"), "output frame");
  const bytes = Buffer.from("renderer fixture");
  const hashed = `sift_wasm.${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.wasm`;
  for (const name of ["sift_wasm.wasm", hashed])
    await writeFile(path.join(app, "dist/plugins", name), bytes);

  for (const command of ["prepare", "export"]) {
    const exportRoot = path.join(root, "export");
    const result = spawnSync(
      process.execPath,
      [path.join(app, "scripts/celld-local.mjs"), command, exportRoot],
      {
        cwd: app,
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("NOTEBOOK_CLOUD_")),
        ),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const project = path.join(
      command === "prepare" ? path.join(app, ".celld-local") : exportRoot,
      "renderer-assets",
    );
    assert.deepEqual(await readdir(path.join(project, "assets")), [hashed]);
    const entry = path.join(project, "index.js");
    if (command === "prepare") {
      await build({
        entryPoints: [path.join(project, "worker.ts")],
        outfile: entry,
        bundle: true,
        format: "esm",
        logLevel: "silent",
      });
    }
    const { default: worker } = await import(pathToFileURL(entry).href);
    for (const name of ["sift_wasm.wasm", hashed]) {
      const response = await worker.fetch(
        new Request(`https://assets.test/renderer-assets/${name}`),
        {
          ASSETS: {
            fetch: async (request) =>
              new Response(
                await readFile(path.join(project, "assets", new URL(request.url).pathname)),
              ),
          },
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal(
        response.headers.get("Cache-Control"),
        name === hashed
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
      );
    }
  }
  assert.deepEqual(
    (await readdir(path.join(app, "dist/plugins"))).sort(),
    ["sift_wasm.wasm", hashed].sort(),
  );
});
