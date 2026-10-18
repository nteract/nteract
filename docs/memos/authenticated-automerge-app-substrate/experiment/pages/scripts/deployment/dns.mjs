// Exact owned CNAME only. Default is inspection; no adoption, updates or deletion.
import { pathToFileURL } from "node:url";
const zone = "7de7c86232f80c97a7aabfc880186b63";
const name = "pages-next.runtimed.run";
export async function configureDns({ token, tunnelId, apply = false, fetchImpl = fetch }) {
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
    comment: "nteract/pages:experiment:pages-next",
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
      throw new Error("Existing DNS record conflicts with exact Pages-next ownership or target");
    return record;
  }
  const actualZone = (await request(`/zones/${zone}`)).result;
  if (
    actualZone.id !== zone ||
    actualZone.name !== "runtimed.run" ||
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
  const [tunnelId, mode] = process.argv.slice(2);
  if (mode && mode !== "--apply") throw new Error("Usage: dns.mjs VERIFIED_TUNNEL_UUID [--apply]");
  try {
    console.log(
      JSON.stringify(
        await configureDns({
          token: process.env.CLOUDFLARE_API_TOKEN,
          tunnelId,
          apply: mode === "--apply",
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
