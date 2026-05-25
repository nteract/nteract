import {
  accessAuthHeaders,
  accessPrincipalFromJwt,
  assertAccessHealthConfigured,
  safePublicBaseUrl,
} from "./hosted-access-smoke-env.mjs";
import { fingerprintPrincipal } from "./hosted-access-smoke-ws.mjs";

const DEFAULT_BASE_URL = "https://nteract-notebook-cloud.rgbkrk.workers.dev";
const baseUrl = process.env.NOTEBOOK_CLOUD_URL ?? DEFAULT_BASE_URL;
const accessToken = process.env.NOTEBOOK_CLOUD_ACCESS_JWT;
const startedAt = performance.now();

try {
  const accessHealth = await fetchAccessHealth();
  const result = {
    ok: true,
    auth_mode: "cloudflare_access",
    base_url: safePublicBaseUrl(baseUrl),
    access_health: accessHealth,
    access_jwt: accessToken
      ? {
          present: true,
          principal_fingerprint: fingerprintPrincipal(accessPrincipalFromJwt(accessToken)),
        }
      : {
          present: false,
        },
    checks: ["cloudflare_access_worker_configured"],
    timings_ms: {
      total: roundMs(performance.now() - startedAt),
    },
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    ok: false,
    auth_mode: "cloudflare_access",
    base_url: safePublicBaseUrl(baseUrl),
    error: error instanceof Error ? error.message : String(error),
    timings_ms: {
      total: roundMs(performance.now() - startedAt),
    },
  };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}

async function fetchAccessHealth() {
  const response = await fetch(new URL("/api/health", baseUrl), {
    headers: accessToken ? accessAuthHeaders(accessToken) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Access health preflight failed: ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Access health preflight did not return JSON");
  }

  return assertAccessHealthConfigured(payload, { baseUrl });
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}
