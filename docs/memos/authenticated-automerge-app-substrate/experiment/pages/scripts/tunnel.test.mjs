import assert from "node:assert/strict";
import { test } from "node:test";
import { accountId, installTunnelFiles, provisionTunnel } from "./deployment/tunnel.mjs";

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
    const body = JSON.parse(init.body);
    return Response.json({ success: true, result: { id: tunnelId, name: body.name } });
  };
  return { calls, fetchImpl };
}

test("inspection reports an absent tunnel without creating one", async () => {
  const cf = cloudflare();
  const result = await provisionTunnel({ token: "t", target: "page9", fetchImpl: cf.fetchImpl });
  assert.deepEqual(result, { name: "nteract-page9", tunnelId: null, created: false });
  assert.ok(cf.calls.every(({ method }) => method === "GET"));
});

test("apply creates a locally managed tunnel and returns its credentials once", async () => {
  const cf = cloudflare();
  const result = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cf.fetchImpl,
    secret: () => Buffer.alloc(32, 7),
  });
  const secret = Buffer.alloc(32, 7).toString("base64");
  assert.deepEqual(cf.calls.at(-1).body, {
    name: "nteract-page9",
    tunnel_secret: secret,
    config_src: "local",
  });
  assert.deepEqual(result.credentials, {
    AccountTag: accountId,
    TunnelID: tunnelId,
    TunnelSecret: secret,
  });
  assert.deepEqual(result.receipt, {
    schema: 1,
    account_id: accountId,
    tunnel_id: tunnelId,
    name: "nteract-page9",
    config_src: "local",
  });
});

test("an existing tunnel is reported, never adopted or rotated", async () => {
  const cf = cloudflare([{ id: tunnelId, name: "nteract-page9" }]);
  const result = await provisionTunnel({
    token: "t",
    target: "page9",
    apply: true,
    fetchImpl: cf.fetchImpl,
  });
  assert.deepEqual(result, { name: "nteract-page9", tunnelId, created: false });
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

test("credential files go to the existing target directory, private and never overwritten", () => {
  const runs = [];
  const written = installTunnelFiles(
    "page9",
    { credentials: { TunnelSecret: "s" }, receipt: { schema: 1 } },
    { run: (host, command, input) => runs.push({ host, command, input }) },
  );
  assert.deepEqual(written, [
    "/etc/nteract-page9/tunnel.json",
    "/etc/nteract-page9/tunnel-provisioning.json",
  ]);
  assert.equal(runs.length, 2);
  for (const { host, command } of runs) {
    assert.equal(host, "lab1");
    const script = command.at(-1);
    assert.match(script, /test -d \/etc\/nteract-page9;/);
    assert.match(script, /test ! -e \/etc\/nteract-page9\/tunnel/);
    assert.match(script, /umask 077/);
    assert.match(script, /mv -n /);
  }
  assert.match(runs[0].command.at(-1), /chmod 0600/);
  assert.equal(runs[0].input, '{"TunnelSecret":"s"}\n');
});
