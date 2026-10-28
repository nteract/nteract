// Downloads the Electron binary on demand.
//
// `pnpm-workspace.yaml` keeps electron off its `allowBuilds` list, so
// `pnpm install` never runs electron's postinstall and never downloads the
// binary. The harness's `predev` / `pretest:e2e` call this instead: it runs
// `electron/install.js` only when `path.txt` (written by a finished install)
// is missing.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve("electron/package.json"));

if (existsSync(path.join(electronDir, "path.txt"))) {
  process.exit(0);
}

console.log(`[sift-electron-harness] downloading the Electron binary into ${electronDir}`);
const result = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
  cwd: electronDir,
  stdio: "inherit",
});
if (result.status !== 0 || !existsSync(path.join(electronDir, "path.txt"))) {
  console.error("[sift-electron-harness] electron/install.js failed");
  process.exit(result.status || 1);
}
