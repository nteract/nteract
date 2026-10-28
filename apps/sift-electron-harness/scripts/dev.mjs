// `pnpm dev -- <file.parquet> [--worker=0] [--autoLoad=manual] [--cap=N] [--origin=embedded]`
//
// Runs the built harness (predev builds it) in Electron. Arguments pass
// through to the main process, which turns them into the window's query.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");

const child = spawn(electron, [appDir, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
