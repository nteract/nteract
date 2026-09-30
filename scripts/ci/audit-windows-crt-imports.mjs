#!/usr/bin/env node
// Audit Windows PE images for Visual C++ runtime DLL imports.
//
// nteract links its Windows MSVC artifacts with `+crt-static` (see
// .cargo/config.toml), so no shipped image may import VCRUNTIME140*.dll,
// MSVCP*.dll, or the other redistributable VC++ runtime DLLs. The Universal
// CRT (api-ms-win-crt-*.dll, ucrtbase.dll) is a Windows 10+ OS component and
// is reported but allowed.
//
// Inputs may be PE files (.exe/.dll/.pyd/.node), directories (scanned
// recursively for those extensions), or wheels (.whl, PE members are read
// from the zip). Both the regular and the delay-load import tables are read.
//
// Usage:
//   node scripts/ci/audit-windows-crt-imports.mjs [--machine x64|arm64|x86] [--json] <path>...
//
// Exit status: 0 clean, 1 violations found, 2 usage or parse error.

import {readFileSync, readdirSync, realpathSync, statSync} from "node:fs";
import {extname, join} from "node:path";
import {inflateRawSync} from "node:zlib";
import {fileURLToPath} from "node:url";

export const MACHINES = {
  0x014c: "x86",
  0x8664: "x64",
  0xaa64: "arm64",
  0xa641: "arm64ec",
  0x01c4: "arm",
};

const PE_EXTENSIONS = new Set([".exe", ".dll", ".pyd", ".node"]);

// Redistributable VC++ runtime DLLs from Microsoft's "Determine which DLLs to
// redistribute" table, plus debug variants and the vcruntime satellites
// (vcruntime140_1 for x64 C++ exception handling, vcruntime140_threads for
// C11 <threads.h>). Matching is case-insensitive because import names keep
// whatever case the import library used.
const FORBIDDEN_DLL =
  /^(vcruntime\d+(_\d+|_threads)?d?|msvcp\d+(_[a-z0-9_]+)?d?|concrt\d+d?|vccorlib\d+d?|vcomp\d+d?|vcamp\d+d?|mfcm?\d+[a-z]{0,3}|msvcr\d+d?|ucrtbased)\.dll$/i;
const UCRT_DLL = /^(api-ms-win-crt-[a-z0-9-]+|ucrtbase)\.dll$/i;

export function classifyDll(name) {
  if (FORBIDDEN_DLL.test(name)) return "forbidden";
  if (UCRT_DLL.test(name)) return "ucrt";
  return "other";
}

function readCString(buf, offset) {
  if (offset < 0 || offset >= buf.length) throw new Error(`string offset ${offset} out of range`);
  const end = buf.indexOf(0, offset);
  if (end === -1) throw new Error(`unterminated string at ${offset}`);
  return buf.toString("latin1", offset, end);
}

/**
 * Parse a PE image and return its machine and imported DLL names.
 * @param {Buffer} buf
 * @returns {{machine: string, imports: string[], delayImports: string[]}}
 */
export function parsePeImports(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE image (missing MZ header)");
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("not a PE image (missing PE signature)");
  }
  const coff = peOffset + 4;
  const machineId = buf.readUInt16LE(coff);
  const sectionCount = buf.readUInt16LE(coff + 2);
  const optionalSize = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buf.readUInt16LE(optional);
  let imageBase;
  let rvaCountOffset;
  if (magic === 0x10b) {
    imageBase = BigInt(buf.readUInt32LE(optional + 28));
    rvaCountOffset = optional + 92;
  } else if (magic === 0x20b) {
    imageBase = buf.readBigUInt64LE(optional + 24);
    rvaCountOffset = optional + 108;
  } else {
    throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  }
  const rvaCount = buf.readUInt32LE(rvaCountOffset);
  const directories = rvaCountOffset + 4;
  const directory = (index) =>
    index < rvaCount
      ? {rva: buf.readUInt32LE(directories + index * 8), size: buf.readUInt32LE(directories + index * 8 + 4)}
      : {rva: 0, size: 0};

  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = sectionTable + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPointer: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        return rva - s.virtualAddress + s.rawPointer;
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} is not inside any section`);
  };

  const imports = [];
  const importDir = directory(1);
  if (importDir.rva) {
    for (let d = rvaToOffset(importDir.rva); ; d += 20) {
      const originalFirstThunk = buf.readUInt32LE(d);
      const nameRva = buf.readUInt32LE(d + 12);
      const firstThunk = buf.readUInt32LE(d + 16);
      if (!originalFirstThunk && !nameRva && !firstThunk) break;
      imports.push(readCString(buf, rvaToOffset(nameRva)));
    }
  }

  const delayImports = [];
  const delayDir = directory(13);
  if (delayDir.rva) {
    for (let d = rvaToOffset(delayDir.rva); ; d += 32) {
      const attributes = buf.readUInt32LE(d);
      const nameField = buf.readUInt32LE(d + 4);
      const moduleHandle = buf.readUInt32LE(d + 8);
      if (!attributes && !nameField && !moduleHandle) break;
      // Attribute bit 0 set means RVAs; clear means legacy VAs.
      const nameRva = attributes & 1 ? nameField : Number(BigInt(nameField) - imageBase);
      delayImports.push(readCString(buf, rvaToOffset(nameRva)));
    }
  }

  return {machine: MACHINES[machineId] ?? `0x${machineId.toString(16)}`, imports, delayImports};
}

/** Yield {name, data} for every PE-extension member of a zip archive. */
export function* zipPeMembers(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive (no end of central directory)");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localHeader = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (!PE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const dataStart = localHeader + 30 + buf.readUInt16LE(localHeader + 26) + buf.readUInt16LE(localHeader + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) yield {name, data: raw};
    else if (method === 8) yield {name, data: inflateRawSync(raw)};
    else throw new Error(`${name}: unsupported zip compression method ${method}`);
  }
}

function collectImages(inputPath) {
  const stat = statSync(inputPath);
  if (stat.isDirectory()) {
    return readdirSync(inputPath, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const child = join(inputPath, entry.name);
        if (entry.isDirectory()) return collectImages(child);
        const ext = extname(entry.name).toLowerCase();
        return PE_EXTENSIONS.has(ext) || ext === ".whl" ? collectImages(child) : [];
      });
  }
  const buf = readFileSync(inputPath);
  if (extname(inputPath).toLowerCase() === ".whl") {
    const members = [...zipPeMembers(buf)].map(({name, data}) => ({path: `${inputPath}!${name}`, data}));
    if (members.length === 0) throw new Error(`${inputPath}: wheel contains no PE images`);
    return members;
  }
  return [{path: inputPath, data: buf}];
}

/**
 * Audit the given paths. Throws on unreadable or malformed input.
 * @param {string[]} paths
 * @param {{machine?: string}} [options]
 */
export function audit(paths, options = {}) {
  const images = paths.flatMap(collectImages);
  if (images.length === 0) throw new Error("no PE images found");
  return images.map(({path, data}) => {
    let parsed;
    try {
      parsed = parsePeImports(data);
    } catch (error) {
      throw new Error(`${path}: ${error.message}`);
    }
    const all = [...parsed.imports, ...parsed.delayImports];
    const problems = all
      .filter((dll) => classifyDll(dll) === "forbidden")
      .map((dll) => `imports ${dll}${parsed.delayImports.includes(dll) ? " (delay-load)" : ""}`);
    if (options.machine && parsed.machine !== options.machine) {
      problems.push(`machine is ${parsed.machine}, expected ${options.machine}`);
    }
    return {
      path,
      machine: parsed.machine,
      ucrt: all.some((dll) => classifyDll(dll) === "ucrt"),
      imports: parsed.imports,
      delayImports: parsed.delayImports,
      problems,
    };
  });
}

function main(argv) {
  const paths = [];
  let machine;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--machine") machine = argv[++i];
    else if (arg.startsWith("--machine=")) machine = arg.slice("--machine=".length);
    else if (arg.startsWith("--")) return usage(`unknown option ${arg}`);
    else paths.push(arg);
  }
  if (machine !== undefined && !Object.values(MACHINES).includes(machine)) return usage(`unknown machine ${machine}`);
  if (paths.length === 0) return usage("no input paths");

  let results;
  try {
    results = audit(paths, {machine});
  } catch (error) {
    console.error(`audit-windows-crt-imports: ${error.message}`);
    return 2;
  }
  const failed = results.filter((r) => r.problems.length > 0);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const status = r.problems.length ? "FAIL" : "ok  ";
      const crt = r.ucrt ? "ucrt" : "no-crt-dll";
      console.log(`${status} ${r.machine.padEnd(7)} ${crt.padEnd(10)} ${r.path}`);
      for (const problem of r.problems) console.log(`       ${problem}`);
    }
    console.log(`${results.length} image(s) audited, ${failed.length} with VC++ runtime problems`);
  }
  return failed.length ? 1 : 0;
}

function usage(message) {
  console.error(`audit-windows-crt-imports: ${message}`);
  console.error("usage: audit-windows-crt-imports.mjs [--machine x64|arm64|x86] [--json] <path>...");
  return 2;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
