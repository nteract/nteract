// Create a target's dedicated, locally managed Cloudflare Tunnel and install
// its credentials on the host. Default is inspection. --apply creates only an
// absent tunnel; it never adopts, rotates or deletes one.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/deployment/tunnel.mjs --target page9 [--apply]
//
// Cloudflare returns a tunnel's secret only to the request that sets it, so
// creation and credential installation happen in one run. Run it after
// `deploy.mjs install`, which creates the target's /etc directory, and before
// `deploy.mjs publish`, which reads both files this writes.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deploymentProfile, selectTarget, assertQualifiedDeploymentTarget } from "./profiles.mjs";

export const accountId = "1cfb529b94b3d6cde3aaf49d1d6ed5e6";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Read or create the tunnel named after the target's service. Returns the
 * credentials only when this call created the tunnel. */
export async function provisionTunnel({
  token,
  target,
  apply = false,
  fetchImpl = fetch,
  secret = () => randomBytes(32),
}) {
  const name = deploymentProfile(target).deployment.service;
  if (typeof token !== "string" || !token || typeof apply !== "boolean")
    throw new Error("Cloudflare token required");
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
  const tunnels = `/accounts/${accountId}/cfd_tunnel`;
  const listed = await request(`${tunnels}?name=${encodeURIComponent(name)}&is_deleted=false`);
  if (!Array.isArray(listed) || listed.length > 1)
    throw new Error("Tunnel listing is ambiguous; inspect before retrying");
  const existing = listed[0];
  if (existing) {
    if (existing.name !== name || !uuid.test(existing.id ?? ""))
      throw new Error("Existing tunnel conflicts with exact Pages ownership");
    return { name, tunnelId: existing.id, created: false };
  }
  if (!apply) return { name, tunnelId: null, created: false };
  const bytes = secret();
  if (bytes.length !== 32) throw new Error("A tunnel secret is 32 bytes");
  const tunnelSecret = Buffer.from(bytes).toString("base64");
  const created = await request(tunnels, "POST", {
    name,
    tunnel_secret: tunnelSecret,
    config_src: "local",
  });
  if (created?.name !== name || !uuid.test(created.id ?? ""))
    throw new Error("Tunnel creation could not be verified; inspect before retrying");
  return {
    name,
    tunnelId: created.id,
    created: true,
    credentials: { AccountTag: accountId, TunnelID: created.id, TunnelSecret: tunnelSecret },
    receipt: { schema: 1, account_id: accountId, tunnel_id: created.id, name, config_src: "local" },
  };
}

/** Write the credentials and receipt as root-owned files that don't exist
 * yet. The target directory must already exist: installation owns it. */
export function installTunnelFiles(target, { credentials, receipt }, { run = runRemote } = {}) {
  const { host, service } = deploymentProfile(target).deployment;
  const directory = "/etc/" + service;
  const write = (file, contents, mode) =>
    run(
      host,
      [
        "sudo",
        "sh",
        "-ec",
        `test -d ${directory}; test ! -e ${file}; umask 077; cat > ${file}.new; chmod ${mode} ${file}.new; mv -n ${file}.new ${file}; test ! -e ${file}.new`,
      ],
      contents,
    );
  write(directory + "/tunnel.json", JSON.stringify(credentials) + "\n", "0600");
  write(directory + "/tunnel-provisioning.json", JSON.stringify(receipt, null, 2) + "\n", "0644");
  return [directory + "/tunnel.json", directory + "/tunnel-provisioning.json"];
}

function runRemote(host, command, input) {
  execFileSync("ssh", ["-o", "BatchMode=yes", host, command.map(quote).join(" ")], {
    input,
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
    const result = await provisionTunnel({
      token: process.env.CLOUDFLARE_API_TOKEN,
      target,
      apply: mode === "--apply",
    });
    const installed = result.created ? installTunnelFiles(target, result) : [];
    // Never print the secret.
    console.log(
      JSON.stringify({
        name: result.name,
        tunnelId: result.tunnelId,
        created: result.created,
        installed,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
