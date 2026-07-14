import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const CONFIG_URL = new URL("../wrangler.toml", import.meta.url);
const ASSET_WORKER_CONFIGS = [
  {
    name: "renderer assets Worker",
    url: new URL("../wrangler.renderer-assets.toml", import.meta.url),
  },
  {
    name: "output document Worker",
    url: new URL("../wrangler.output-document.toml", import.meta.url),
  },
];

async function readVarsBlock() {
  const config = await readFile(CONFIG_URL, "utf8");
  const vars = {};
  let inVars = false;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line === "[vars]") {
      inVars = true;
      continue;
    }
    if (inVars && line.startsWith("[")) {
      break;
    }
    if (!inVars) {
      continue;
    }

    const match = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }

  return vars;
}

describe("notebook cloud deploy config", () => {
  it("validates Anaconda API keys against the same environment as OIDC", async () => {
    const vars = await readVarsBlock();
    const oidcIssuer = new URL(vars.NOTEBOOK_CLOUD_OIDC_ISSUER);
    const apiKeyUserinfo = new URL(vars.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL);

    assert.equal(apiKeyUserinfo.origin, oidcIssuer.origin);
    assert.equal(apiKeyUserinfo.pathname, "/api/auth/sessions/whoami");
  });

  it("runs asset requests through each sidecar Worker before serving static files", async () => {
    for (const { name, url } of ASSET_WORKER_CONFIGS) {
      const config = await readFile(url, "utf8");
      const assetsBlock = config.match(/^\[assets\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";

      assert.match(
        assetsBlock,
        /^run_worker_first\s*=\s*true\s*$/m,
        `${name} must run first so its response headers cannot be bypassed`,
      );
    }
  });
});
