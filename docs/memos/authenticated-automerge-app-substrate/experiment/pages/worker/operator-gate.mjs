/**
 * The lab-only operator gate for the PageRecords sweep's route
 * (worker/page-records-sweep.mjs). ONE-SHOT MIGRATION: delete with that
 * module, with the installer's `operatorMigration` secret
 * (scripts/deployment/install.mjs) and scripts/operator-ssh.mjs.
 *
 * celld's internal listener answers its own operator routes and never
 * forwards to the Worker, so the Worker can't tell a request by how it
 * arrived. The gate is a secret instead:
 *
 * - PAGES_OPERATOR_SECRET is set only by the lab installer
 *   (scripts/deployment/install.mjs, `operatorMigration` profiles), from
 *   `/etc/<service>/operator-secret` (root-only). A Cloudflare deployment has
 *   none, so the routes are the unknown path there.
 * - The request carries it in OPERATOR_SECRET_HEADER, compared in constant
 *   time.
 * - A request the Cloudflare edge forwarded is refused even with the secret:
 *   the edge adds `cf-ray`, `cf-connecting-ip`, `cf-visitor` and `cdn-loop`,
 *   and a client can't strip them. The operator calls the public listener on
 *   loopback from lab1 (scripts/operator-ssh.mjs), whose firewall admits
 *   only root and the service user.
 *
 * Every refusal is the gateway's plain 404 for an unknown path.
 */

export const OPERATOR_SECRET_HEADER = "x-pages-operator-secret";
const EDGE_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-visitor", "cdn-loop"];
const MIN_SECRET_LENGTH = 32;

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Whether `request` may use the operator route under `env`. */
export async function operatorAuthorized(request, env) {
  const secret = env?.PAGES_OPERATOR_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return false;
  if (EDGE_HEADERS.some((header) => request.headers.has(header))) return false;
  const offered = request.headers.get(OPERATOR_SECRET_HEADER) ?? "";
  // Compare digests, so neither the length nor the first differing byte of
  // the secret shows in the timing.
  const [a, b] = await Promise.all([digest(offered), digest(secret)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
