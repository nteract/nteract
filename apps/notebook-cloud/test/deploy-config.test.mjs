import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const CONFIG_URL = new URL("../wrangler.toml", import.meta.url);

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
});
