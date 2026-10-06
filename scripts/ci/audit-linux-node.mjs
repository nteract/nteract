#!/usr/bin/env node
// Audit the installed npm tarball's ELF addon before loading or publishing it.
// Requires GNU readelf (binutils); READELF may select llvm-readelf for local QA.
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const machines = {x64: /Advanced Micro Devices X86-64|AMD x86-64/, arm64: /AArch64/};
const libraries = new Set([
  "libssl.so.3", "libcrypto.so.3", "libgcc_s.so.1", "libm.so.6", "libc.so.6",
]);

// Version definitions from Jammy's original libgcc-s1 12-20220319-1ubuntu1
// packages. ARM64 and x64 export different nodes; package versions are not ABIs.
const gccVersions = {
  x64: new Set(["3.0", "3.3", "3.3.1", "3.4", "3.4.2", "3.4.4", "4.0.0", "4.2.0", "4.3.0", "4.7.0", "4.8.0", "7.0.0", "12.0.0"]),
  arm64: new Set(["3.0", "3.3", "3.3.1", "3.4", "3.4.2", "3.4.4", "4.0.0", "4.2.0", "4.3.0", "4.5.0", "4.7.0", "7.0.0", "11.0"]),
};

function newerThan(version, ceiling) {
  const parts = version.split(".").map(Number);
  const limit = ceiling.split(".").map(Number);
  for (let i = 0; i < Math.max(parts.length, limit.length); i++) {
    const difference = (parts[i] ?? 0) - (limit[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function auditLinuxNode(output, arch) {
  if (!machines[arch]) throw new Error(`Unsupported architecture: ${arch}`);
  const machine = /^\s*Machine:\s*(.+)$/m.exec(output)?.[1];
  if (!machine || !machines[arch].test(machine)) throw new Error(`Expected ${arch} ELF, got ${machine}`);
  if (!/^\s*Class:\s*ELF64\s*$/m.test(output) || !/^\s*Type:\s*DYN\b/m.test(output)) {
    throw new Error("Expected an ELF64 shared object");
  }
  const needed = [...output.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g)].map(match => match[1]);
  if (!needed.includes("libc.so.6")) throw new Error("Missing libc dependency in readelf output");
  const loader = arch === "x64" ? "ld-linux-x86-64.so.2" : "ld-linux-aarch64.so.1";
  for (const library of needed) {
    if (!libraries.has(library) && library !== loader) throw new Error(`Unexpected shared library: ${library}`);
  }
  // Inspect version requirements, including weak imports. Weak symbols can
  // still produce mandatory GLIBC_2.39 entries in .gnu.version_r.
  const versions = [...output.matchAll(/Name:\s+((?:GLIBC|OPENSSL|GCC)_[\w.]+)/g)].map(match => match[1]);
  if (!versions.some(version => version.startsWith("GLIBC_"))) throw new Error("Missing glibc version requirements");
  const ceilings = {GLIBC: "2.35", OPENSSL: "3.0.0"};
  for (const version of versions) {
    const match = /^(GLIBC|OPENSSL|GCC)_([0-9]+(?:\.[0-9]+)*)$/.exec(version);
    if (!match || (match[1] === "GCC" ? !gccVersions[arch].has(match[2]) : newerThan(match[2], ceilings[match[1]]))) {
      throw new Error(`${version} exceeds the Ubuntu 22.04 baseline`);
    }
  }
  return {arch, needed, versions: [...new Set(versions)]};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [arch, addon, ...extra] = process.argv.slice(2);
    if (!machines[arch] || !addon || extra.length) throw new Error("usage: audit-linux-node.mjs <x64|arm64> <addon.node>");
    const output = execFileSync(process.env.READELF || "readelf", ["--wide", "--file-header", "--dynamic", "--version-info", resolve(addon)], {
      encoding: "utf8", env: {...process.env, LC_ALL: "C"},
    });
    console.log(JSON.stringify(auditLinuxNode(output, arch), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
