// Pack the library and use it from outside the workspace: install the tarball
// into a scratch project, load the real WASM, and convert a CSV.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "sift-csv-package-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", scratch], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  const tarball = readdirSync(scratch).find((f) => f.endsWith(".tgz"));
  assert(tarball, "pnpm pack produced no tarball");
  const packed = join(scratch, "node_modules/@nteract/sift-csv");
  mkdirSync(packed, { recursive: true });
  execFileSync("tar", ["-xzf", join(scratch, tarball), "--strip-components=1", "-C", packed]);

  const files = readdirSync(join(packed, "lib"), { recursive: true }).map(String).sort();
  for (const file of [
    "index.js",
    "types/index.d.ts",
    "wasm/sift_csv_wasm.js",
    "wasm/sift_csv_wasm_bg.wasm",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    assert(files.includes(file), `packed lib/ is missing ${file}`);
  }

  // The consumer resolves the WASM next to the glue through import.meta.url,
  // the default path a bundler-free host takes.
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(scratch, "consumer.mjs"),
    `import { csvToArrowIpc } from "@nteract/sift-csv";
     const ipc = await csvToArrowIpc("name,score\\nann,1.5\\nbob,\\n");
     if (!(ipc instanceof Uint8Array) || ipc.length < 100) throw new Error("no IPC output");
     // An Arrow IPC stream starts with the 0xFFFFFFFF continuation marker.
     if (ipc[0] !== 0xff || ipc[1] !== 0xff || ipc[2] !== 0xff || ipc[3] !== 0xff) throw new Error("not an IPC stream");
     console.log("converted", ipc.length, "bytes");`,
  );
  execFileSync(process.execPath, [join(scratch, "consumer.mjs")], { stdio: "inherit" });
  console.log("Packed @nteract/sift-csv: files, real WASM load, and conversion passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
