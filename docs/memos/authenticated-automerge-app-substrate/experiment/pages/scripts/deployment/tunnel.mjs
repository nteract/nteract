// Create a target's dedicated, locally managed Cloudflare Tunnel and install
// its credentials on the host. Default is inspection. --apply creates only an
// absent tunnel; it never adopts, rotates or overwrites one.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/deployment/tunnel.mjs --target page9 [--apply]
//
// Cloudflare returns a tunnel's secret only to the request that sets it, so
// creation and credential installation happen in one run:
//
// 1. Check the host: the target directory exists (installation creates it)
//    and holds neither tunnel file.
// 2. Create the tunnel.
// 3. Write both files in one SSH call. If that fails, delete the tunnel just
//    created, so a rerun starts clean.
//
// A tunnel that already exists passes only when the host's receipt names it.
// Run this after `deploy.mjs install` and before `deploy.mjs publish`.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deploymentProfile, selectTarget, assertQualifiedDeploymentTarget } from "./profiles.mjs";

export const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** The Cloudflare tunnel API for one target's tunnel name. */
export function tunnelApi({ token, target, fetchImpl = fetch }) {
  if (typeof token !== "string" || !token) throw new Error("Cloudflare token required");
  const name = deploymentProfile(target).deployment.service;
  const tunnels = `/accounts/${accountId}/cfd_tunnel`;
  async function request(path, method = "GET", body) {
    let response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error("Cloudflare request failed; inspect before retrying");
    }
    if (!response.ok) throw new Error(`Cloudflare ${method} failed (HTTP ${response.status})`);
    const data = await response.json().catch(() => {
      throw new Error("Cloudflare returned invalid JSON");
    });
    if (data.success !== true) throw new Error("Cloudflare request was not successful");
    return data.result;
  }
  return {
    name,
    /** The live tunnel with this target's name, or undefined. */
    async find() {
      const listed = await request(`${tunnels}?name=${encodeURIComponent(name)}&is_deleted=false`);
      if (!Array.isArray(listed) || listed.length > 1)
        throw new Error("Tunnel listing is ambiguous; inspect before retrying");
      const existing = listed[0];
      if (existing && (existing.name !== name || !uuid.test(existing.id ?? "")))
        throw new Error("Existing tunnel conflicts with exact Pages ownership");
      return existing;
    },
    /** Create the tunnel. Returns its credentials and nonsecret receipt. */
    async create(secret = randomBytes(32)) {
      if (secret.length !== 32) throw new Error("A tunnel secret is 32 bytes");
      const tunnelSecret = Buffer.from(secret).toString("base64");
      const created = await request(tunnels, "POST", {
        name,
        tunnel_secret: tunnelSecret,
        config_src: "local",
      });
      if (created?.name !== name || !uuid.test(created.id ?? ""))
        throw new Error("Tunnel creation could not be verified; inspect before retrying");
      return {
        tunnelId: created.id,
        credentials: { AccountTag: accountId, TunnelID: created.id, TunnelSecret: tunnelSecret },
        receipt: {
          schema: 1,
          account_id: accountId,
          tunnel_id: created.id,
          name,
          config_src: "local",
        },
      };
    },
    /** Delete a tunnel this run created and could not install. */
    async remove(tunnelId) {
      if (!uuid.test(tunnelId ?? "")) throw new Error("Tunnel UUID required");
      await request(`${tunnels}/${tunnelId}`, "DELETE");
    },
  };
}

const directoryOf = (target) => "/etc/" + deploymentProfile(target).deployment.service;
const hostOf = (target) => deploymentProfile(target).deployment.host;

/** Fails unless the target directory exists and holds neither tunnel file. */
export function checkHostReady(target, { run = runRemote } = {}) {
  const d = directoryOf(target);
  run(hostOf(target), [
    "sudo",
    "sh",
    "-ec",
    `test -d ${d}; test ! -e ${d}/tunnel.json; test ! -e ${d}/tunnel-provisioning.json`,
  ]);
}

/** Fails unless the host's receipt and credentials name `tunnelId`. */
export function checkHostInstalled(target, tunnelId, { run = runRemote } = {}) {
  if (!uuid.test(tunnelId ?? "")) throw new Error("Tunnel UUID required");
  const d = directoryOf(target);
  run(hostOf(target), [
    "sudo",
    "sh",
    "-ec",
    `grep -Eq '"tunnel_id": ?"${tunnelId}"' ${d}/tunnel-provisioning.json; grep -Eq '"TunnelID": ?"${tunnelId}"' ${d}/tunnel.json`,
  ]);
}

/** Remove each tunnel file only if it names `tunnelId`. Files that name
 * another tunnel, or that are absent, are left alone. */
export function removeOwnedFiles(target, tunnelId, { run = runRemote } = {}) {
  if (!uuid.test(tunnelId ?? "")) throw new Error("Tunnel UUID required");
  const d = directoryOf(target);
  run(hostOf(target), [
    "sudo",
    "sh",
    "-ec",
    [
      `if grep -Eq '"TunnelID": ?"${tunnelId}"' ${d}/tunnel.json 2>/dev/null; then rm -f ${d}/tunnel.json; fi`,
      `if grep -Eq '"tunnel_id": ?"${tunnelId}"' ${d}/tunnel-provisioning.json 2>/dev/null; then rm -f ${d}/tunnel-provisioning.json; fi`,
      `test ! -e ${d}/tunnel.json || ! grep -q '${tunnelId}' ${d}/tunnel.json`,
      `test ! -e ${d}/tunnel-provisioning.json || ! grep -q '${tunnelId}' ${d}/tunnel-provisioning.json`,
    ].join("; "),
  ]);
}

/**
 * Write the credentials (mode 0600) and receipt (mode 0644) in one call.
 * Each goes to its own new temporary file first, then moves into place only if
 * its destination is still absent. The temporary files are removed on exit.
 */
export function installTunnelFiles(target, { credentials, receipt }, { run = runRemote } = {}) {
  const d = directoryOf(target);
  const script = [
    `test -d ${d}`,
    `test ! -e ${d}/tunnel.json`,
    `test ! -e ${d}/tunnel-provisioning.json`,
    "umask 077",
    `c=$(mktemp ${d}/.tunnel.XXXXXXXX)`,
    `r=$(mktemp ${d}/.receipt.XXXXXXXX)`,
    `trap 'rm -f "$c" "$r"' EXIT`,
    `IFS= read -r line; printf '%s\\n' "$line" > "$c"`,
    `IFS= read -r line; printf '%s\\n' "$line" > "$r"`,
    `chmod 0600 "$c"`,
    `chmod 0644 "$r"`,
    `mv -n "$c" ${d}/tunnel.json`,
    `test ! -e "$c"`,
    `mv -n "$r" ${d}/tunnel-provisioning.json`,
    `test ! -e "$r"`,
  ].join("; ");
  run(
    hostOf(target),
    ["sudo", "sh", "-ec", script],
    JSON.stringify(credentials) + "\n" + JSON.stringify(receipt) + "\n",
  );
  return [d + "/tunnel.json", d + "/tunnel-provisioning.json"];
}

/** Inspect, or with `apply` create and install, the target's tunnel. */
export async function provisionTunnel({
  token,
  target,
  apply = false,
  fetchImpl = fetch,
  run = runRemote,
  secret,
}) {
  if (typeof apply !== "boolean") throw new Error("apply must be a boolean");
  const api = tunnelApi({ token, target, fetchImpl });
  const existing = await api.find();
  if (existing) {
    try {
      checkHostInstalled(target, existing.id, { run });
    } catch {
      throw new Error(
        `Tunnel ${existing.id} exists but the host has no matching credentials. ` +
          "Its secret can't be recovered: delete the tunnel in Cloudflare, then rerun.",
      );
    }
    return { name: api.name, tunnelId: existing.id, created: false, installed: true };
  }
  if (!apply) return { name: api.name, tunnelId: null, created: false, installed: false };
  checkHostReady(target, { run });
  const created = await api.create(secret);
  try {
    installTunnelFiles(target, created, { run });
  } catch (error) {
    // The SSH call may have failed after the files landed, or between them.
    // Reconcile before undoing anything.
    try {
      checkHostInstalled(target, created.tunnelId, { run });
      return { name: api.name, tunnelId: created.tunnelId, created: true, installed: true };
    } catch {}
    const stranded = `Installing credentials for tunnel ${created.tunnelId} failed`;
    try {
      removeOwnedFiles(target, created.tunnelId, { run });
    } catch {
      throw new Error(
        `${stranded} and its files on the host could not be checked. Remove any tunnel file that names it, delete the tunnel in Cloudflare, then rerun.`,
        { cause: error },
      );
    }
    await api.remove(created.tunnelId).catch(() => {
      throw new Error(
        `${stranded} and it could not be deleted; delete it in Cloudflare, then rerun.`,
        {
          cause: error,
        },
      );
    });
    throw new Error(`${stranded}; the tunnel and its partial files were removed`, {
      cause: error,
    });
  }
  return { name: api.name, tunnelId: created.tunnelId, created: true, installed: true };
}

function runRemote(host, command, input) {
  execFileSync("ssh", ["-o", "BatchMode=yes", host, command.map(quote).join(" ")], {
    input: input ?? "",
    stdio: ["pipe", "ignore", "inherit"],
  });
}
const quote = (word) => (/^[\w./=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { target, args } = selectTarget(process.argv.slice(2));
  const [mode, extra] = args;
  if (extra || (mode && mode !== "--apply"))
    throw new Error("Usage: tunnel.mjs --target TARGET [--apply]");
  try {
    if (mode === "--apply") assertQualifiedDeploymentTarget(target);
    // The result never holds the secret.
    console.log(
      JSON.stringify(
        await provisionTunnel({
          token: process.env.CLOUDFLARE_API_TOKEN,
          target,
          apply: mode === "--apply",
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
