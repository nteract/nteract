#!/usr/bin/env node
// Load one assembled Windows @runtimed/node addon in the current runtime
// (Node or Bun) and call into it.
//
// Usage: <node|bun> scripts/ci/smoke-windows-node-addon.cjs <x64|arm64> <addon.node>
//
// NAPI_RS_NATIVE_LIBRARY_PATH makes the napi-generated loader require exactly
// this file and skip its other candidates, so the image that loads is the one
// the CRT audit checked. The runtime must be native for the requested
// architecture: an emulated x64 process cannot load an ARM64 addon and would
// not prove the ARM64 image loads.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [arch, addonArg] = process.argv.slice(2);
if (!["x64", "arm64"].includes(arch) || !addonArg) {
  console.error("usage: smoke-windows-node-addon.cjs <x64|arm64> <addon.node>");
  process.exit(2);
}
const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
if (process.platform !== "win32") throw new Error(`${runtime} is on ${process.platform}, expected win32`);
if (process.arch !== arch) throw new Error(`${runtime} is ${process.arch}, expected native ${arch}`);

const addon = path.resolve(addonArg);
if (!fs.statSync(addon).isFile() || path.extname(addon) !== ".node") {
  throw new Error(`Not a native addon file: ${addon}`);
}
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;

const rt = require(path.resolve(__dirname, "../../packages/runtimed-node/src/index.cjs"));
const socket = rt.defaultSocketPath();
if (typeof socket !== "string" || !socket.startsWith("\\\\.\\pipe\\")) {
  throw new Error(`defaultSocketPath() returned ${JSON.stringify(socket)}, expected a Windows named pipe`);
}
if (!process.versions.bun) {
  // Node records native modules in require.cache under their resolved path.
  const loaded = Object.keys(require.cache).some((key) => key.toLowerCase() === addon.toLowerCase());
  if (!loaded) throw new Error(`${addon} is not in require.cache`);
}
console.log(`${runtime} ${process.arch} loaded ${addon}`);
console.log(`defaultSocketPath: ${socket}`);
