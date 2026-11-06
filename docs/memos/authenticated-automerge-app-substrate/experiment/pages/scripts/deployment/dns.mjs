// Exact owned CNAME only. Default is inspection; no adoption, updates or deletion.
import { pathToFileURL } from "node:url";
import { deploymentProfile, selectTarget, assertQualifiedDeploymentTarget } from "./profiles.mjs";
import { accountId } from "./tunnel.mjs";

// The Cloudflare zones a Pages hostname may live in. Zone IDs are public
// identifiers, not credentials. A zone without a pinned id is found by exact
// name and must be the only active full zone with that name in the tunnel's
// account: a CNAME only routes to a tunnel in the zone's own account. Pin its
// id here once the operator has confirmed it.
export const DNS_ZONES = Object.freeze({
  "runtimed.run": Object.freeze({ id: "7de7c86232f80c97a7aabfc880186b63" }),
  "runt.run": Object.freeze({ id: null }),
});

/** The allowlisted zone that holds `hostname`, or an error for any other. */
export function zoneForHostname(hostname) {
  const zone =
    typeof hostname === "string"
      ? Object.keys(DNS_ZONES).find(
          (name) =>
            hostname.endsWith("." + name) &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(hostname.slice(0, -name.length - 1)),
        )
      : undefined;
  if (!zone)
    throw new Error(
      `Pages hostnames must be one label under ${Object.keys(DNS_ZONES).join(" or ")}`,
    );
  return { name: zone, id: DNS_ZONES[zone].id };
}

export async function configureDns({
  token,
  tunnelId,
  apply = false,
  fetchImpl = fetch,
  target = "pages-next",
}) {
  const name = deploymentProfile(target).deployment.hostname;
  const expectedZone = zoneForHostname(name);
  if (
    typeof token !== "string" ||
    !token ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(tunnelId ?? "") ||
    typeof apply !== "boolean"
  )
    throw new Error("Cloudflare token and verified tunnel UUID required");
  const desired = {
    name,
    type: "CNAME",
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: "nteract/pages:experiment:" + target,
  };
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
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Cloudflare returned invalid JSON");
    }
    if (data.success !== true) throw new Error("Cloudflare request was not successful");
    return data;
  }
  function validate(record) {
    if (
      !/^[a-f0-9]{32}$/.test(record?.id ?? "") ||
      !Object.entries(desired).every(([key, value]) => record[key] === value)
    )
      throw new Error("Existing DNS record conflicts with exact Pages ownership or target");
    return record;
  }
  async function findZone() {
    if (expectedZone.id) return (await request(`/zones/${expectedZone.id}`)).result;
    const data = await request(
      `/zones?name=${encodeURIComponent(expectedZone.name)}&account.id=${accountId}&page=1&per_page=50`,
    );
    if (!Array.isArray(data.result) || data.result.length !== 1)
      throw new Error(`Expected exactly one Cloudflare zone named ${expectedZone.name}`);
    const [found] = data.result;
    if (found?.account?.id !== accountId)
      throw new Error(`Cloudflare zone ${expectedZone.name} is not in the tunnel's account`);
    return found;
  }
  const actualZone = await findZone();
  const zone = actualZone?.id;
  if (
    !/^[a-f0-9]{32}$/.test(zone ?? "") ||
    (expectedZone.id && zone !== expectedZone.id) ||
    actualZone.name !== expectedZone.name ||
    actualZone.status !== "active" ||
    actualZone.type !== "full"
  )
    throw new Error("Unexpected Cloudflare zone");
  const records = `/zones/${zone}/dns_records`;
  async function read() {
    const data = await request(
      `${records}?name.exact=${encodeURIComponent(name)}&page=1&per_page=100`,
    );
    if (
      !Array.isArray(data.result) ||
      data.result_info?.page !== 1 ||
      data.result_info.count !== data.result.length ||
      data.result_info.total_count !== data.result.length ||
      data.result.length > 1
    )
      throw new Error("DNS listing is incomplete or ambiguous");
    return data.result.length ? validate(data.result[0]) : undefined;
  }
  let record = await read(),
    changed = false;
  if (apply && !record) {
    const created = validate((await request(records, "POST", desired)).result);
    record = await read();
    if (record?.id !== created.id)
      throw new Error("DNS creation could not be verified; inspect before retrying");
    changed = true;
  }
  return {
    name,
    target: desired.content,
    present: Boolean(record),
    recordId: record?.id ?? null,
    changed,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { target, args } = selectTarget(process.argv.slice(2));
  const [tunnelId, mode, extra] = args;
  if (extra || (mode && mode !== "--apply"))
    throw new Error(
      "Usage: dns.mjs [--target pages-next|page3|page4|page5|page6|page7|page8|page9|page10|pages|pages2] VERIFIED_TUNNEL_UUID [--apply]",
    );
  try {
    if (mode === "--apply") assertQualifiedDeploymentTarget(target);
    console.log(
      JSON.stringify(
        await configureDns({
          token: process.env.CLOUDFLARE_API_TOKEN,
          tunnelId,
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
