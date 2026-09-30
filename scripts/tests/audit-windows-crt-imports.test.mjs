import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {deflateRawSync} from "node:zlib";

import {audit, classifyDll, parsePeImports} from "../ci/audit-windows-crt-imports.mjs";

const script = fileURLToPath(new URL("../ci/audit-windows-crt-imports.mjs", import.meta.url));
const MACHINE = {x86: 0x014c, x64: 0x8664, arm64: 0xaa64};

// Build a minimal PE image with one section holding the import and
// delay-import tables. `legacyDelay` writes VA-based (attribute 0) delay
// descriptors, as old toolchains did.
function makePe({machine = "x64", pe32 = false, imports = [], delay = [], legacyDelay = false} = {}) {
  const fileAlign = 0x200;
  const sectionRva = 0x1000;
  const sectionRaw = 0x400;
  const imageBase = pe32 ? 0x400000n : 0x140000000n;
  const section = Buffer.alloc(0x1000);
  let cursor = 0;
  const alloc = (size) => {
    const at = cursor;
    cursor += size;
    return at;
  };
  const importTable = alloc((imports.length + 1) * 20);
  const delayTable = alloc((delay.length + 1) * 32);
  const putString = (s) => {
    const at = alloc(s.length + 1);
    section.write(s, at, "latin1");
    return sectionRva + at;
  };
  imports.forEach((dll, i) => {
    const nameRva = putString(dll);
    section.writeUInt32LE(sectionRva + 0x800, importTable + i * 20); // OriginalFirstThunk
    section.writeUInt32LE(nameRva, importTable + i * 20 + 12);
    section.writeUInt32LE(sectionRva + 0x900, importTable + i * 20 + 16); // FirstThunk
  });
  delay.forEach((dll, i) => {
    const nameRva = putString(dll);
    const d = delayTable + i * 32;
    section.writeUInt32LE(legacyDelay ? 0 : 1, d);
    section.writeUInt32LE(legacyDelay ? Number(imageBase) + nameRva : nameRva, d + 4);
    section.writeUInt32LE(sectionRva + 0xa00, d + 8);
  });

  const optionalSize = pe32 ? 224 : 240;
  const header = Buffer.alloc(sectionRaw);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(0x40, 0x3c);
  header.writeUInt32LE(0x00004550, 0x40);
  const coff = 0x44;
  header.writeUInt16LE(MACHINE[machine], coff);
  header.writeUInt16LE(1, coff + 2);
  header.writeUInt16LE(optionalSize, coff + 16);
  const opt = coff + 20;
  header.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt);
  if (pe32) header.writeUInt32LE(Number(imageBase), opt + 28);
  else header.writeBigUInt64LE(imageBase, opt + 24);
  const rvaCount = pe32 ? opt + 92 : opt + 108;
  header.writeUInt32LE(16, rvaCount);
  const dirs = rvaCount + 4;
  if (imports.length) header.writeUInt32LE(sectionRva + importTable, dirs + 1 * 8);
  if (delay.length) header.writeUInt32LE(sectionRva + delayTable, dirs + 13 * 8);
  const sec = opt + optionalSize;
  header.write(".idata", sec, "latin1");
  header.writeUInt32LE(section.length, sec + 8);
  header.writeUInt32LE(sectionRva, sec + 12);
  header.writeUInt32LE(section.length, sec + 16);
  header.writeUInt32LE(sectionRaw, sec + 20);
  assert.ok(sectionRaw % fileAlign === 0);
  return Buffer.concat([header, section]);
}

// Minimal zip writer: deflated (method 8) or stored (method 0) members.
function makeZip(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const {name, data, store = false} of members) {
    const body = store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "crt-audit-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], {encoding: "utf8"});
}

test("classifies VC++ redistributable DLLs as forbidden and UCRT as allowed", () => {
  for (const dll of ["VCRUNTIME140.dll", "vcruntime140_1.dll", "VCRUNTIME140D.dll", "MSVCP140.dll", "msvcp140_atomic_wait.dll", "CONCRT140.dll", "vcomp140.dll", "vcamp140.dll", "mfc140u.dll", "mfcm140u.dll", "MSVCR120.dll", "ucrtbased.dll"]) {
    assert.equal(classifyDll(dll), "forbidden", dll);
  }
  for (const dll of ["api-ms-win-crt-runtime-l1-1-0.dll", "API-MS-WIN-CRT-HEAP-L1-1-0.DLL", "ucrtbase.dll"]) {
    assert.equal(classifyDll(dll), "ucrt", dll);
  }
  for (const dll of ["KERNEL32.dll", "ntdll.dll", "api-ms-win-core-synch-l1-2-0.dll", "WebView2Loader.dll", "python3.dll"]) {
    assert.equal(classifyDll(dll), "other", dll);
  }
});

test("reads PE32+ import tables for x64 and arm64", () => {
  for (const machine of ["x64", "arm64"]) {
    const parsed = parsePeImports(makePe({machine, imports: ["KERNEL32.dll", "VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll"]}));
    assert.deepEqual(parsed, {machine, imports: ["KERNEL32.dll", "VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll"], delayImports: []});
  }
});

test("reads RVA and legacy VA delay-load descriptors", () => {
  assert.deepEqual(parsePeImports(makePe({imports: ["KERNEL32.dll"], delay: ["VCRUNTIME140_1.dll"]})).delayImports, ["VCRUNTIME140_1.dll"]);
  const legacy = parsePeImports(makePe({machine: "x86", pe32: true, delay: ["MSVCP140.dll"], legacyDelay: true}));
  assert.equal(legacy.machine, "x86");
  assert.deepEqual(legacy.delayImports, ["MSVCP140.dll"]);
});

test("rejects files that are not PE images", () => {
  assert.throws(() => parsePeImports(Buffer.from("#!/bin/sh\n")), /missing MZ header/);
  const noPe = Buffer.alloc(0x100);
  noPe.writeUInt16LE(0x5a4d, 0);
  noPe.writeUInt32LE(0x40, 0x3c);
  assert.throws(() => parsePeImports(noPe), /missing PE signature/);
});

test("flags forbidden imports, delay-loads, and machine mismatches", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "static.exe"), makePe({machine: "arm64", imports: ["KERNEL32.dll", "ntdll.dll"]}));
    writeFileSync(join(dir, "hybrid.exe"), makePe({machine: "arm64", imports: ["KERNEL32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"]}));
    writeFileSync(join(dir, "dynamic.node"), makePe({machine: "arm64", imports: ["VCRUNTIME140.dll"], delay: ["VCRUNTIME140_1.dll"]}));
    writeFileSync(join(dir, "wrong-arch.dll"), makePe({machine: "x64", imports: ["KERNEL32.dll"]}));
    writeFileSync(join(dir, "README.txt"), "not scanned");
    const results = Object.fromEntries(audit([dir], {machine: "arm64"}).map((r) => [r.path.split(/[\\/]/).at(-1), r]));
    assert.deepEqual(Object.keys(results).sort(), ["dynamic.node", "hybrid.exe", "static.exe", "wrong-arch.dll"]);
    assert.deepEqual(results["static.exe"].problems, []);
    assert.equal(results["static.exe"].ucrt, false);
    assert.deepEqual(results["hybrid.exe"].problems, []);
    assert.equal(results["hybrid.exe"].ucrt, true);
    assert.deepEqual(results["dynamic.node"].problems, ["imports VCRUNTIME140.dll", "imports VCRUNTIME140_1.dll (delay-load)"]);
    assert.deepEqual(results["wrong-arch.dll"].problems, ["machine is x64, expected arm64"]);
  });
});

test("audits PE members inside wheels", () => {
  withTempDir((dir) => {
    const wheel = join(dir, "runtimed-0.0.0-cp39-abi3-win_amd64.whl");
    writeFileSync(
      wheel,
      makeZip([
        {name: "runtimed/__init__.py", data: Buffer.from("")},
        {name: "runtimed/_internals.pyd", data: makePe({imports: ["python3.dll", "VCRUNTIME140.dll"]})},
        {name: "runtimed/_bin/runtimed.exe", data: makePe({imports: ["KERNEL32.dll"]}), store: true},
      ]),
    );
    const results = audit([wheel], {machine: "x64"});
    assert.deepEqual(
      results.map((r) => [r.path.split("!")[1], r.problems]),
      [
        ["runtimed/_internals.pyd", ["imports VCRUNTIME140.dll"]],
        ["runtimed/_bin/runtimed.exe", []],
      ],
    );
  });
});

test("CLI exit status separates clean, violating, and unusable input", () => {
  withTempDir((dir) => {
    const clean = join(dir, "clean.exe");
    const dirty = join(dir, "dirty.exe");
    const notPe = join(dir, "script.exe");
    writeFileSync(clean, makePe({imports: ["KERNEL32.dll"]}));
    writeFileSync(dirty, makePe({imports: ["MSVCP140.dll"]}));
    writeFileSync(notPe, "echo hi\n");

    const ok = runCli(["--machine", "x64", clean]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /1 image\(s\) audited, 0 with VC\+\+ runtime problems/);

    const bad = runCli([clean, dirty]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL x64 .*dirty\.exe\n\s+imports MSVCP140\.dll/);

    const json = runCli(["--json", dirty]);
    assert.equal(json.status, 1);
    assert.deepEqual(JSON.parse(json.stdout)[0].problems, ["imports MSVCP140.dll"]);

    assert.equal(runCli([notPe]).status, 2);
    assert.equal(runCli([]).status, 2);
    assert.equal(runCli(["--machine", "sparc", clean]).status, 2);
    const empty = join(dir, "empty");
    mkdirSync(empty);
    assert.equal(runCli([empty]).status, 2);
  });
});

test("Cargo config links every Windows MSVC target with the static CRT", () => {
  const config = readFileSync(new URL("../../.cargo/config.toml", import.meta.url), "utf8");
  const table = config.split(`[target.'cfg(all(target_os = "windows", target_env = "msvc"))']\n`)[1]?.split("\n[")[0];
  assert.ok(table, "missing Windows MSVC target table");
  assert.match(table, /^rustflags = \["-C", "target-feature=\+crt-static"\]$/m);
  const env = config.split("\n[env]\n")[1]?.split("\n[")[0];
  assert.match(env ?? "", /^STATIC_VCRUNTIME = \{ value = "false", force = true \}$/m);
});
