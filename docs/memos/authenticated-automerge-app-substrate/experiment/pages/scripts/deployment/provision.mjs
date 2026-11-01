// A target's Cloudflare edge: its dedicated tunnel, then the exact CNAME that
// points its hostname at that tunnel. Default is inspection. `apply` creates
// only what is absent; both steps refuse to adopt, update or delete anything.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target page10 provision [--apply]
//
// Runs after `deploy.mjs install` (which creates /etc/<service>) and before
// `deploy.mjs publish` (which reads the tunnel files this writes). The token
// is read by the caller and passed through; nothing here stores it.
import { configureDns } from "./dns.mjs";
import { provisionTunnel } from "./tunnel.mjs";

export async function provisionTarget({ token, target, apply = false, fetchImpl = fetch, run }) {
  if (typeof apply !== "boolean") throw new Error("apply must be a boolean");
  const tunnel = await provisionTunnel({ token, target, apply, fetchImpl, run });
  // Inspecting before the tunnel exists leaves no UUID for DNS to check against.
  const dns = tunnel.tunnelId
    ? await configureDns({ token, tunnelId: tunnel.tunnelId, target, apply, fetchImpl })
    : null;
  return { target, applied: apply, tunnel, dns };
}
