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
