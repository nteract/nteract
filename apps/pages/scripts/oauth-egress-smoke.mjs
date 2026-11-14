#!/usr/bin/env node
// Exercise actual destination filtering in a disposable Linux network namespace.
// Requires Docker; never uses the host network or changes the host firewall.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicHttpsEgress } from "./deployment/firewall.mjs";

const directory = mkdtempSync(path.join(tmpdir(), "pages-oauth-egress-"));
const image = "pages-oauth-egress-test";
const run = (args) => execFileSync("docker", args, { stdio: "inherit", timeout: 300_000 });
try {
  writeFileSync(
    path.join(directory, "Dockerfile"),
    `FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nftables iproute2 && rm -rf /var/lib/apt/lists/*
`,
  );
  writeFileSync(
    path.join(directory, "rules.nft"),
    `table inet metadata_test {
${publicHttpsEgress(12345)}}
`,
  );
  copyFileSync(
    new URL("../test/fixtures/oauth-egress/probe.py", import.meta.url),
    path.join(directory, "probe.py"),
  );
  run(["build", "-t", image, directory]);
  run([
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-add",
    "NET_ADMIN",
    "-v",
    `${directory}:/test:ro`,
    image,
    "python",
    "/test/probe.py",
  ]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
