// Narrow tunnel change only. DNS is a separate operation after route validation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const routes = `  - hostname: pages-next.runtimed.run
    path: ^/(index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|api/(tools|connect|sync|saved|auth/(login|logout|session))|oidc)?$
    service: http://127.0.0.1:9472
  - hostname: pages-next.runtimed.run
    service: http_status:404
`;

export function insertRoutes(before) {
  if (before.includes("pages-next.runtimed.run")) {
    if (before.split(routes).length !== 2) throw new Error("Conflicting Pages-next routes");
    return before;
  }
  const anchor = '  - hostname: "*.runtimed.run"\n';
  if (before.split(anchor).length !== 2) throw new Error("Tunnel wildcard layout changed");
  return before.replace(anchor, routes + anchor);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, apply] = process.argv.slice(2);
  if (
    process.getuid() !== 0 ||
    apply !== "--apply" ||
    !/^\/tmp\/nteract-pages-next-stage-[A-Za-z0-9]{8}$/.test(stage ?? "")
  )
    throw new Error("Explicit root publication with prepared stage required");
  const manifest = JSON.parse(readFileSync(stage + "/manifest.json"));
  const ownership = JSON.parse(readFileSync("/etc/nteract-pages-next/ownership.json"));
  if (
    ownership.hostname !== "pages-next.runtimed.run" ||
    ownership.prefix !== "standalone/pages-next" ||
    manifest.deployment.hostname !== ownership.hostname
  )
    throw new Error("Unexpected publication target");
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
  if (run("systemctl", ["is-active", "nteract-pages-next"]) !== "active")
    throw new Error("Prototype service is not active");
  const health = JSON.parse(
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "http://127.0.0.1:9472/health",
    ]),
  );
  if (health.ok !== true || health.prototype !== "pages-celld-native")
    throw new Error("Unexpected local prototype health response");
  const config = "/etc/cloudflared/config.yml",
    before = readFileSync(config, "utf8");
  const anchor = '  - hostname: "*.runtimed.run"\n';
  if (before.includes("pages-next.runtimed.run")) {
    if (before.split(routes).length !== 2)
      throw new Error("Existing Pages-next routes differ; inspect instead of rewriting");
    console.log(JSON.stringify({ published: true, changed: false, hostname: ownership.hostname }));
    process.exit(0);
  }
  if (before.split(anchor).length !== 2)
    throw new Error("Tunnel wildcard layout changed; inspect before insertion");
  const candidate = "/etc/cloudflared/pages-next-candidate.yml";
  if (existsSync(candidate)) throw new Error("Existing candidate requires inspection");
  writeFileSync(candidate, insertRoutes(before), { mode: 0o600, flag: "wx" });
  try {
    run("/usr/bin/cloudflared", ["--config", candidate, "tunnel", "ingress", "validate"]);
    const checks = [
      ["https://pages-next.runtimed.run/", "127.0.0.1:9472"],
      ["https://pages-next.runtimed.run/api/sync?page=test", "127.0.0.1:9472"],
      ["https://pages-next.runtimed.run/mcp", "127.0.0.1:9472"],
      ["https://pages-next.runtimed.run/state", "http_status:404"],
      ["https://pages-next.runtimed.run/internal/create", "http_status:404"],
      ["https://pages-next.runtimed.run/dev/oidc/authorize", "http_status:404"],
    ];
    for (const [url, expected] of checks)
      if (
        !run("/usr/bin/cloudflared", [
          "--config",
          candidate,
          "tunnel",
          "ingress",
          "rule",
          url,
        ]).includes(expected)
      )
        throw new Error("New route validation failed for " + url);
    // Compare current routing itself, rather than assuming older fleet ports.
    for (const url of [
      "https://m.runtimed.run/",
      "https://m.runtimed.run/api/sync?page=test",
      "https://main.runtimed.run/",
      "https://deploy.runtimed.run/operator",
    ]) {
      const current = run("/usr/bin/cloudflared", [
        "--config",
        config,
        "tunnel",
        "ingress",
        "rule",
        url,
      ]);
      const next = run("/usr/bin/cloudflared", [
        "--config",
        candidate,
        "tunnel",
        "ingress",
        "rule",
        url,
      ]);
      const service = /service:\s*(\S+)/.exec(current)?.[1];
      if (!service || !next.includes("service: " + service))
        throw new Error("Existing hostname routing changed");
    }
    writeFileSync("/etc/nteract-pages-next/cloudflared.before.yml", before, {
      mode: 0o600,
      flag: "wx",
    });
    if (readFileSync(config, "utf8") !== before)
      throw new Error("Concurrent tunnel update; retry after inspection");
    renameSync(candidate, config);
    try {
      run("systemctl", ["restart", "cloudflared.service"]);
    } catch (error) {
      writeFileSync(config, before, { mode: 0o600 });
      run("systemctl", ["restart", "cloudflared.service"]);
      throw error;
    }
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
  console.log(
    JSON.stringify({
      published: true,
      changed: true,
      hostname: ownership.hostname,
      dnsConfigured: false,
    }),
  );
}
