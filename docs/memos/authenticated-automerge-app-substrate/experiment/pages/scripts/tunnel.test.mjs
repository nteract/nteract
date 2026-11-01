import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  accountId,
  installTunnelFiles,
  provisionTunnel,
  removeOwnedFiles,
} from "./deployment/tunnel.mjs";
import { provisionTarget } from "./deployment/provision.mjs";

const tunnelId = "8e7399d8-7fcf-463a-b2b1-18f5512bedbd";

function cloudflare(tunnels = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, pathname, body: init.body && JSON.parse(init.body) });
    assert.equal(pathname.startsWith(`/client/v4/accounts/${accountId}/cfd_tunnel`), true);
    if (init.method === "GET") {
      assert.equal(searchParams.get("is_deleted"), "false");
      const name = searchParams.get("name");
      return Response.json({ success: true, result: tunnels.filter((t) => t.name === name) });
    }
    if (init.method === "DELETE") return Response.json({ success: true, result: {} });
    const body = JSON.parse(init.body);
    return Response.json({ success: true, result: { id: tunnelId, name: body.name } });
  };
  return { calls, fetchImpl };
}

/**
 * Runs each remote script locally against `root` standing in for /etc.
 * `install` changes the install call: "lost" runs it and then reports an SSH
 * failure; "between" fails it after the credentials move.
 */
function host(root, { install, dropAfterInstall = 0 } = {}) {
  const runs = [];
  let installed = false;
  let dropped = 0;
  const run = (target, command, input) => {
    let script = command.at(-1).replaceAll("/etc/", root + "/");
    runs.push(script);
    if (installed && dropped < dropAfterInstall) {
      dropped++;
      throw new Error("ssh: connection lost");
    }
    const installing = script.includes("mktemp");
    if (installing && install === "between") script = script.replace(/mv -n "\$r"[^;]*;/, "false;");
    execFileSync("sh", ["-ec", script], { input: input ?? "", stdio: ["pipe", "ignore", "pipe"] });
    if (installing) installed = true;
    if (installing && install === "lost") throw new Error("ssh: connection lost");
  };
  return { run, runs };
}
const etc = () => {
  const root = mkdtempSync(path.join(tmpdir(), "tunnel-etc-"));
  execFileSync("mkdir", [path.join(root, "nteract-page9")]);
  return root;
};

test("inspection reports an absent tunnel without touching Cloudflare or the host", async () => {
  const cf = cloudflare();
  const h = host(etc());
  const result = await provisionTunnel({
    token: "t",
    target: "page9",
    fetchImpl: cf.fetchImpl,
    run: h.run,
  });
  assert.deepEqual(result, {
    name: "nteract-page9",
    tunnelId: null,
    created: false,
    installed: false,
  });
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
  assert.equal(h.runs.length, 0);
});

test("apply creates the tunnel and installs private credentials and a receipt", async () => {
  const root = etc();
  const cf = cloudflare();
  const result = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cf.fetchImpl,
    run: host(root).run,
    secret: Buffer.alloc(32, 7),
  });
  assert.equal(result.created, true);
  assert.equal(JSON.stringify(result).includes(Buffer.alloc(32, 7).toString("base64")), false);
  const d = path.join(root, "nteract-page9");
  const credentials = JSON.parse(readFileSync(path.join(d, "tunnel.json"), "utf8"));
  assert.deepEqual(credentials, {
    AccountTag: accountId,
    TunnelID: tunnelId,
    TunnelSecret: Buffer.alloc(32, 7).toString("base64"),
  });
  assert.equal(statSync(path.join(d, "tunnel.json")).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(d, "tunnel-provisioning.json")).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, "tunnel-provisioning.json"), "utf8")), {
    schema: 1,
    account_id: accountId,
    tunnel_id: tunnelId,
    name: "nteract-page9",
    config_src: "local",
  });
  assert.deepEqual(readdirSync(d).sort(), ["tunnel-provisioning.json", "tunnel.json"]);
  // A rerun finds the tunnel and the matching receipt and changes nothing.
  const again = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cloudflare([{ id: tunnelId, name: "nteract-page9" }]).fetchImpl,
    run: host(root).run,
  });
  assert.deepEqual(again, {
    name: "nteract-page9",
    tunnelId,
    created: false,
    installed: true,
  });
});

test("a failure between the two moves removes the stranded file and the new tunnel", async () => {
  const root = etc();
  const cf = cloudflare();
  await assert.rejects(
    provisionTunnel({
      token: "t",
      target: "page9",
      apply: true,
      fetchImpl: cf.fetchImpl,
      run: host(root, { install: "between" }).run,
    }),
    /tunnel and its partial files were removed/,
  );
  assert.deepEqual(
    cf.calls.map(({ method }) => method),
    ["GET", "POST", "DELETE"],
  );
  assert.equal(cf.calls.at(-1).pathname.endsWith(`/cfd_tunnel/${tunnelId}`), true);
  assert.deepEqual(readdirSync(path.join(root, "nteract-page9")), []);
  // A rerun starts clean.
  const rerun = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cloudflare().fetchImpl,
    run: host(root).run,
  });
  assert.equal(rerun.installed, true);
});

test("a lost acknowledgement after both files land keeps the tunnel", async () => {
  const root = etc();
  const cf = cloudflare();
  const result = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cf.fetchImpl,
    run: host(root, { install: "lost" }).run,
  });
  assert.deepEqual(result, { name: "nteract-page9", tunnelId, created: true, installed: true });
  assert.ok(cf.calls.every(({ method }) => method !== "DELETE"));
  assert.deepEqual(readdirSync(path.join(root, "nteract-page9")).sort(), [
    "tunnel-provisioning.json",
    "tunnel.json",
  ]);
});

test("an unanswered reconcile check leaves the tunnel and its files for an operator", async () => {
  const root = etc();
  const cf = cloudflare();
  await assert.rejects(
    provisionTunnel({
      token: "t",
      target: "page9",
      apply: true,
      fetchImpl: cf.fetchImpl,
      run: host(root, { install: "lost", dropAfterInstall: 1 }).run,
    }),
    /didn't answer a check/,
  );
  assert.ok(cf.calls.every(({ method }) => method !== "DELETE"));
  assert.deepEqual(readdirSync(path.join(root, "nteract-page9")).sort(), [
    "tunnel-provisioning.json",
    "tunnel.json",
  ]);
});

test("cleanup removes this tunnel's files whatever their JSON spacing", () => {
  const root = etc();
  const d = path.join(root, "nteract-page9");
  writeFileSync(path.join(d, "tunnel.json"), `{ "TunnelID" :  "${tunnelId}" }`);
  removeOwnedFiles("page9", tunnelId, { run: host(root).run });
  assert.deepEqual(readdirSync(d), []);
});

test("an unreadable tunnel file counts as unknown, never as absent", async () => {
  const root = etc();
  const d = path.join(root, "nteract-page9");
  writeFileSync(path.join(d, "tunnel-provisioning.json"), `{"tunnel_id":"${tunnelId}"}`);
  // A directory named like the credentials file makes grep fail to read it.
  execFileSync("mkdir", [path.join(d, "tunnel.json")]);
  const cf = cloudflare([{ id: tunnelId, name: "nteract-page9" }]);
  await assert.rejects(
    provisionTunnel({
      token: "t",
      target: "page9",
      apply: true,
      fetchImpl: cf.fetchImpl,
      run: host(root).run,
    }),
    /Could not read the host's tunnel files/,
  );
  assert.throws(() => removeOwnedFiles("page9", tunnelId, { run: host(root).run }));
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
});

test("cleanup leaves files that name another tunnel", () => {
  const root = etc();
  const d = path.join(root, "nteract-page9");
  writeFileSync(path.join(d, "tunnel.json"), '{"TunnelID":"00000000-0000-4000-8000-000000000000"}');
  removeOwnedFiles("page9", tunnelId, { run: host(root).run });
  assert.deepEqual(readdirSync(d), ["tunnel.json"]);
});

test("a host that isn't ready stops before Cloudflare creates anything", async () => {
  for (const prepare of [
    (root) => execFileSync("rmdir", [path.join(root, "nteract-page9")]),
    (root) => writeFileSync(path.join(root, "nteract-page9", "tunnel.json"), "{}"),
  ]) {
    const root = etc();
    prepare(root);
    const cf = cloudflare();
    await assert.rejects(
      provisionTunnel({
        token: "t",
        target: "page9",
        apply: true,
        fetchImpl: cf.fetchImpl,
        run: host(root).run,
      }),
    );
    assert.ok(cf.calls.every(({ method }) => method === "GET"));
  }
});

test("an existing tunnel without matching host credentials refuses with a recovery step", async () => {
  const cf = cloudflare([{ id: tunnelId, name: "nteract-page9" }]);
  await assert.rejects(
    provisionTunnel({
      token: "t",
      target: "page9",
      apply: true,
      fetchImpl: cf.fetchImpl,
      run: host(etc()).run,
    }),
    /delete the tunnel in Cloudflare/,
  );
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
});

test("an ambiguous listing refuses", async () => {
  const cf = cloudflare([
    { id: tunnelId, name: "nteract-page9" },
    { id: tunnelId, name: "nteract-page9" },
  ]);
  await assert.rejects(
    provisionTunnel({ token: "t", target: "page9", apply: true, fetchImpl: cf.fetchImpl }),
    /ambiguous/,
  );
});

test("install never replaces a file that appeared after the check", () => {
  const root = etc();
  const d = path.join(root, "nteract-page9");
  writeFileSync(path.join(d, "tunnel-provisioning.json"), "existing");
  assert.throws(() =>
    installTunnelFiles(
      "page9",
      { credentials: { TunnelSecret: "s" }, receipt: { schema: 1 } },
      { run: host(root).run },
    ),
  );
  assert.equal(readFileSync(path.join(d, "tunnel-provisioning.json"), "utf8"), "existing");
  assert.deepEqual(readdirSync(d), ["tunnel-provisioning.json"]);
});

// `deploy.mjs provision`: the tunnel step, then DNS for the tunnel it reports.
const zone = "7de7c86232f80c97a7aabfc880186b63";
const token = "fixture-token-never-printed";

/** One Cloudflare API: the tunnel fake above plus the runtimed.run DNS zone. */
function edge(tunnels = [], records = []) {
  const tunnel = cloudflare(tunnels);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, pathname, authorization: init.headers.Authorization });
    if (pathname.includes("/cfd_tunnel")) return tunnel.fetchImpl(url, init);
    if (pathname === `/client/v4/zones/${zone}`)
      return Response.json({
        success: true,
        result: { id: zone, name: "runtimed.run", status: "active", type: "full" },
      });
    assert.equal(pathname, `/client/v4/zones/${zone}/dns_records`);
    if (init.method === "POST") {
      records = [{ ...JSON.parse(init.body), id: "a".repeat(32) }];
      return Response.json({ success: true, result: records[0] });
    }
    return Response.json({
      success: true,
      result: records,
      result_info: { page: 1, count: records.length, total_count: records.length },
    });
  };
  return { calls, fetchImpl, records: () => records };
}
const etcFor = (target) => {
  const root = mkdtempSync(path.join(tmpdir(), "provision-etc-"));
  execFileSync("mkdir", [path.join(root, "nteract-" + target)]);
  return root;
};
const page10Record = {
  id: "a".repeat(32),
  name: "page10.runtimed.run",
  type: "CNAME",
  content: `${tunnelId}.cfargotunnel.com`,
  proxied: true,
  ttl: 1,
  comment: "nteract/pages:experiment:page10",
};

test("provision inspection before anything exists makes only tunnel reads", async () => {
  const cf = edge();
  const h = host(etcFor("page10"));
  const result = await provisionTarget({
    token,
    target: "page10",
    fetchImpl: cf.fetchImpl,
    run: h.run,
  });
  assert.deepEqual(result, {
    target: "page10",
    applied: false,
    tunnel: { name: "nteract-page10", tunnelId: null, created: false, installed: false },
    dns: null,
  });
  assert.deepEqual(
    cf.calls.map(({ method, pathname }) => method + " " + pathname.split("/").at(-1)),
    ["GET cfd_tunnel"],
  );
  assert.equal(h.runs.length, 0);
});

test("provision --apply creates the tunnel, installs it, then points DNS at it", async () => {
  const root = etcFor("page10");
  const cf = edge();
  const result = await provisionTarget({
    token,
    target: "page10",
    apply: true,
    fetchImpl: cf.fetchImpl,
    run: host(root).run,
  });
  assert.deepEqual(result, {
    target: "page10",
    applied: true,
    tunnel: { name: "nteract-page10", tunnelId, created: true, installed: true },
    dns: {
      name: "page10.runtimed.run",
      target: `${tunnelId}.cfargotunnel.com`,
      present: true,
      recordId: "a".repeat(32),
      changed: true,
    },
  });
  // Tunnel first, then DNS; one create each.
  assert.deepEqual(
    cf.calls.map(({ method, pathname }) => method + " " + pathname.split("/").at(-1)),
    [
      "GET cfd_tunnel",
      "POST cfd_tunnel",
      "GET " + zone,
      "GET dns_records",
      "POST dns_records",
      "GET dns_records",
    ],
  );
  assert.deepEqual(cf.records(), [page10Record]);
  // The token travels only as the bearer header; the result holds no secret.
  assert.ok(cf.calls.every(({ authorization }) => authorization === `Bearer ${token}`));
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("TunnelSecret"), false);
  const d = path.join(root, "nteract-page10");
  assert.deepEqual(readdirSync(d).sort(), ["tunnel-provisioning.json", "tunnel.json"]);
  assert.equal(statSync(path.join(d, "tunnel.json")).mode & 0o777, 0o600);

  // A rerun finds both and creates nothing.
  const again = edge([{ id: tunnelId, name: "nteract-page10" }], cf.records());
  const rerun = await provisionTarget({
    token,
    target: "page10",
    apply: true,
    fetchImpl: again.fetchImpl,
    run: host(root).run,
  });
  assert.equal(rerun.tunnel.created, false);
  assert.equal(rerun.dns.changed, false);
  assert.ok(again.calls.every(({ method }) => method === "GET"));

  // Inspection afterwards reports both present and writes nothing.
  const inspect = edge([{ id: tunnelId, name: "nteract-page10" }], cf.records());
  const seen = await provisionTarget({
    token,
    target: "page10",
    fetchImpl: inspect.fetchImpl,
    run: host(root).run,
  });
  assert.equal(seen.applied, false);
  assert.equal(seen.tunnel.installed, true);
  assert.equal(seen.dns.present, true);
  assert.ok(inspect.calls.every(({ method }) => method === "GET"));
});

test("provision inspection of an installed tunnel reports missing DNS without creating it", async () => {
  const root = etcFor("page10");
  await provisionTunnel({
    token,
    target: "page10",
    apply: true,
    fetchImpl: cloudflare().fetchImpl,
    run: host(root).run,
  });
  const cf = edge([{ id: tunnelId, name: "nteract-page10" }]);
  const result = await provisionTarget({
    token,
    target: "page10",
    fetchImpl: cf.fetchImpl,
    run: host(root).run,
  });
  assert.equal(result.tunnel.installed, true);
  assert.deepEqual(result.dns, {
    name: "page10.runtimed.run",
    target: `${tunnelId}.cfargotunnel.com`,
    present: false,
    recordId: null,
    changed: false,
  });
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
});

test("provision refuses a DNS record another target owns", async () => {
  const root = etcFor("page10");
  await provisionTunnel({
    token,
    target: "page10",
    apply: true,
    fetchImpl: cloudflare().fetchImpl,
    run: host(root).run,
  });
  const foreign = { ...page10Record, comment: "nteract/pages:experiment:page9" };
  const cf = edge([{ id: tunnelId, name: "nteract-page10" }], [foreign]);
  await assert.rejects(
    provisionTarget({
      token,
      target: "page10",
      apply: true,
      fetchImpl: cf.fetchImpl,
      run: host(root).run,
    }),
    /conflicts with exact Pages ownership/,
  );
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
  assert.deepEqual(cf.records(), [foreign]);
});

test("provision without a token stops before Cloudflare or the host", async () => {
  for (const missing of [undefined, ""]) {
    const cf = edge();
    const h = host(etcFor("page10"));
    await assert.rejects(
      provisionTarget({
        token: missing,
        target: "page10",
        apply: true,
        fetchImpl: cf.fetchImpl,
        run: h.run,
      }),
      /Cloudflare token required/,
    );
    assert.equal(cf.calls.length, 0);
    assert.equal(h.runs.length, 0);
  }
});
