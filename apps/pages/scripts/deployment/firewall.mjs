#!/usr/bin/env node
// Trusted ExecStartPre for this one service. Never called from app artifacts.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deploymentProfile, selectTarget, assertQualifiedDeploymentTarget } from "./profiles.mjs";

/** Operator-owned egress configuration. `prepared` installs this node's
 * boundary; `public-https` additionally asserts that the entire fleet and
 * future node images are protected. Neither is inferred from release bytes. */
export function metadataEgressQualification(file, fs = { existsSync, lstatSync, readFileSync }) {
  if (!fs.existsSync(file)) return "unconfigured";
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
    throw new Error(`Invalid operator egress qualification: ${file}`);
  const phase = fs.readFileSync(file, "utf8").trim();
  if (!["prepared", "public-https"].includes(phase))
    throw new Error(`Invalid operator egress qualification: ${file}`);
  return phase;
}

/** Once installed, keep the boundary even when the marker is removed. A
 * fleet may still be serving a release whose metadata fetching is enabled.
 * Removing rules is a separate operator action after disabling fetches. */
export function enforcePublicHttps(phase, alreadyInstalled) {
  return phase !== "unconfigured" || alreadyInstalled;
}

/** Filter actual HTTPS destinations, after DNS resolution. Do not permit
 * established outbound flows ahead of this chain: upgrades must also close
 * pooled connections to forbidden destinations. Other ports and replies on
 * inbound connections are deliberately unaffected. The caller owns a private
 * nft table and installs it atomically before publishing/starting a Worker. */
export function publicHttpsEgress(uid) {
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("Dedicated operator UID required");
  return `  chain public_https {
    type filter hook output priority filter + 10; policy accept;
    meta skuid ${uid} ct direction original tcp dport 443 ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3 } counter reject
    meta skuid ${uid} ct direction original tcp dport 443 ip6 daddr != 2000::/3 counter reject
    meta skuid ${uid} ct direction original tcp dport 443 ip6 daddr { 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20 } counter reject
  }
`;
}

export function pagesFirewall(uid, existing = false, target, publicHttps = false) {
  const profile = deploymentProfile(target);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("Dedicated operator UID required");
  return `${existing ? "delete table inet " + profile.firewallTable + "\n" : ""}table inet ${profile.firewallTable} {
  comment "${profile.firewallComment}";
${publicHttps ? publicHttpsEgress(uid) : ""}  chain trusted_local {
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
  target,
  publicHttps = false,
) {
  const rules = pagesFirewall(uid, existing, target, publicHttps);
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
  let publicHttpsInstalled = false;
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
    publicHttpsInstalled = current.nftables.some(({ chain }) => chain?.name === "public_https");
    if (!current.nftables.some(({ table }) => table?.comment === profile.firewallComment))
      throw new Error("Pages nft table is not owned by preview-infra");
  }
  // One atomic transaction. The service cgroup already exists during ExecStartPre,
  // so its ID is refreshed on each start before any celld socket can open.
  const phase = metadataEgressQualification(
    `/etc/${profile.deployment.service}/oauth-metadata-egress`,
  );
  applyPagesFirewall(
    uid,
    existing,
    execFileSync,
    target,
    enforcePublicHttps(phase, publicHttpsInstalled),
  );
}
