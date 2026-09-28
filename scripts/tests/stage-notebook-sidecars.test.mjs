import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

const script = fileURLToPath(new URL("../ci/stage-notebook-sidecars.sh", import.meta.url));
const config = JSON.parse(readFileSync(new URL("../../crates/notebook/tauri.conf.json", import.meta.url), "utf8"));

for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin", "aarch64-pc-windows-msvc"]) {
  test(`stages every configured Tauri sidecar and artifact payload for ${target}`, () => {
    const root = mkdtempSync(join(tmpdir(), "notebook-sidecars-"));
    try {
      const suffix = target.includes("windows") ? ".exe" : "";
      mkdirSync(join(root, "target/release"), {recursive: true});
      for (const sidecar of config.bundle.externalBin) {
        const name = sidecar.split("/").at(-1);
        writeFileSync(join(root, `target/release/${name}${suffix}`), `${target}: ${name}\n`, {mode: 0o755});
      }
      const result = spawnSync("bash", [script, target], {cwd: root, encoding: "utf8"});
      assert.equal(result.status, 0, result.stderr);
      for (const sidecar of config.bundle.externalBin) {
        const name = sidecar.split("/").at(-1);
        for (const destination of ["crates/notebook/binaries", "target/release/binaries"]) {
          assert.equal(readFileSync(join(root, destination, `${name}-${target}${suffix}`), "utf8"), `${target}: ${name}\n`);
        }
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
}

test("PR binary generation uses the tested staging script on every platform", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-binary-generation.yml", import.meta.url), "utf8");
  const step = workflow.split("      - name: Build and stage external binaries\n")[1]?.split("\n      - name:")[0];
  assert.ok(step);
  assert.match(step, /shell: bash/);
  assert.match(step, /bash scripts\/ci\/stage-notebook-sidecars\.sh "\$TARGET"/);
  assert.doesNotMatch(step, /\n\s+if:/);
});
