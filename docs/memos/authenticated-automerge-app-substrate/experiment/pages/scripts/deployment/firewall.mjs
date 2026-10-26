#!/usr/bin/env node
// Trusted ExecStartPre for this one service. Never called from app artifacts.
import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deploymentProfile, selectTarget, assertQualifiedDeploymentTarget } from "./profiles.mjs";

export function pagesFirewall(uid, existing = false, target = "pages-next") {
  const profile = deploymentProfile(target);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("Dedicated operator UID required");
  return `${existing ? "delete table inet " + profile.firewallTable + "\n" : ""}table inet ${profile.firewallTable} {
  comment "${profile.firewallComment}";
  chain trusted_local {
    type filter hook output priority filter + 5; policy accept;
    ip daddr 127.0.0.0/8 meta l4proto tcp meta skuid { 0, ${uid} } ct mark set ct mark | ${profile.firewallMark}
  }
  chain private_listener {
    type filter hook input priority filter + 5; policy accept;
    ct direction original meta l4proto tcp socket cgroupv2 level 2 "system.slice/${profile.deployment.service}.service" ct mark & ${profile.firewallMark} == 0 counter reject with tcp reset
  }
}\n`;
}

export function applyPagesFirewall(
  uid,
  existing = false,
  run = execFileSync,
  target = "pages-next",
) {
  const rules = pagesFirewall(uid, existing, target);
  // nft rejects Node's socket-backed stdin on this host. Give it a regular
  // file in a private root-owned directory; -f still applies one transaction.
  const directory = mkdtempSync(
    path.join(tmpdir(), deploymentProfile(target).deployment.service + "-firewall-"),
  );
  const file = path.join(directory, "rules.nft");
  try {
    writeFileSync(file, rules, { mode: 0o600, flag: "wx" });
    run("/usr/sbin/nft", ["-f", file], { stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  const { target, args } = selectTarget(process.argv.slice(2));
  assertQualifiedDeploymentTarget(target);
  if (process.getuid() !== 0) throw new Error("Pages firewall setup requires root");
  if (args.length) throw new Error("Unexpected firewall argument");
  const profile = deploymentProfile(target);
  const uid = Number(
    execFileSync("/usr/bin/id", ["-u", profile.deployment.service], { encoding: "utf8" }).trim(),
  );
  let existing = false;
  // Listing all tables succeeds even on a host with no nft rules. An nft error
  // must stop startup rather than being mistaken for a missing table.
  const listed = JSON.parse(
    execFileSync("/usr/sbin/nft", ["-j", "list", "tables"], { encoding: "utf8" }),
  );
  existing = listed.nftables.some(
    ({ table }) => table?.family === "inet" && table.name === profile.firewallTable,
  );
  if (existing) {
    const current = JSON.parse(
      execFileSync("/usr/sbin/nft", ["-j", "list", "table", "inet", profile.firewallTable], {
        encoding: "utf8",
      }),
    );
    if (!current.nftables.some(({ table }) => table?.comment === profile.firewallComment))
      throw new Error("Pages nft table is not owned by preview-infra");
  }
  // One atomic transaction. The service cgroup already exists during ExecStartPre,
  // so its ID is refreshed on each start before any celld socket can open.
  applyPagesFirewall(uid, existing, execFileSync, target);
}
