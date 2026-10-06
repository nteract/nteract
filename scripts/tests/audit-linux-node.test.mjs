import assert from "node:assert/strict";
import {test} from "node:test";
import {auditLinuxNode} from "../ci/audit-linux-node.mjs";

const elf = `ELF Header:
  Class: ELF64
  Type: DYN (Shared object file)
  Machine: Advanced Micro Devices X86-64
  0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
  0x0000000000000001 (NEEDED) Shared library: [libssl.so.3]
  0x0010: Name: GLIBC_2.2.5 Flags: none Version: 2
  0x0020: Name: GLIBC_2.35 Flags: none Version: 3
  0x0030: Name: OPENSSL_3.0.0 Flags: none Version: 4
  0x0040: Name: GCC_4.2.0 Flags: none Version: 5
`;

test("accepts the Ubuntu 22.04 baseline on both architectures", () => {
  assert.equal(auditLinuxNode(elf, "x64").arch, "x64");
  assert.equal(auditLinuxNode(elf.replace("Advanced Micro Devices X86-64", "AArch64"), "arm64").arch, "arm64");
});

test("rejects the published glibc 2.39 regression even with weak symbols", () => {
  const published = elf + "205: 0000000000000000 0 FUNC WEAK DEFAULT UND pidfd_spawnp@GLIBC_2.39\n  0x01e0: Name: GLIBC_2.39 Flags: none Version: 22\n";
  assert.throws(() => auditLinuxNode(published, "x64"), /GLIBC_2.39/);
});

test("compares version components numerically and fails on newer or private ABIs", () => {
  for (const version of ["GLIBC_2.100", "GLIBC_2.35.1", "GLIBC_PRIVATE", "GLIBC_ABI_DT_RELR", "OPENSSL_3.2.0", "GCC_13.0.0"]) {
    assert.throws(() => auditLinuxNode(elf + `Name: ${version}\n`, "x64"), /baseline/);
  }
  assert.doesNotThrow(() => auditLinuxNode(elf.replace("GLIBC_2.35", "GLIBC_2.9"), "x64"));
});

test("fails closed for malformed output, wrong architecture and unexpected dependencies", () => {
  for (const output of ["", elf.replace("ELF64", "ELF32"), elf.replace("DYN", "EXEC"), elf.replace("libc.so.6", "libc.so.7"), elf.replaceAll("Name: GLIBC_", "Name: OTHER_")]) {
    assert.throws(() => auditLinuxNode(output, "x64"));
  }
  assert.throws(() => auditLinuxNode(elf, "arm64"), /Expected arm64/);
  assert.throws(() => auditLinuxNode(elf + "(NEEDED) Shared library: [libstdc++.so.6]\n", "x64"), /Unexpected shared library/);
});

test("accepts Jammy libgcc version nodes for each architecture and rejects absent nodes", () => {
  const arm = elf.replace("Advanced Micro Devices X86-64", "AArch64");
  for (const [arch, output, accepted, absent] of [
    ["x64", elf, ["4.8.0", "7.0.0", "12.0.0"], ["4.5.0", "11.0", "13.0.0"]],
    ["arm64", arm, ["4.5.0", "7.0.0", "11.0"], ["4.8.0", "12.0.0", "13.0.0"]],
  ]) {
    for (const version of accepted) assert.doesNotThrow(() => auditLinuxNode(output + `Name: GCC_${version}\n`, arch));
    for (const version of absent) assert.throws(() => auditLinuxNode(output + `Name: GCC_${version}\n`, arch), /baseline/);
  }
});
