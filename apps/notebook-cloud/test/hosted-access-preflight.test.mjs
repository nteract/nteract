import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

describe("hosted Access preflight script", () => {
  it("reports configured Access health without requiring a JWT", async () => {
    const { result } = await runPreflight({
      auth: {
        cloudflare_access: {
          status: "configured",
          jwks: "remote",
        },
      },
    });

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.access_health, { status: "configured", jwks: "remote" });
    assert.deepEqual(payload.access_jwt, { present: false });
  });

  it("fails disabled Access health without leaking the JWT", async () => {
    const token = jwt({ sub: "access-user-123", email: "alice@example.com" });
    const { result, requestHeaders } = await runPreflight(
      {
        auth: {
          cloudflare_access: {
            status: "disabled",
            jwks: "none",
          },
        },
      },
      { token },
    );

    assert.equal(result.status, 1);
    assert.equal(requestHeaders["cf-access-token"], token);
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stderr.includes("alice@example.com"));
    assert.match(result.stderr, /Cloudflare Access auth is disabled/);
  });

  it("fingerprints the Access principal without printing raw identity claims", async () => {
    const token = jwt({ sub: "access-user-123", email: "alice@example.com" });
    const { result } = await runPreflight(
      {
        auth: {
          cloudflare_access: {
            status: "configured",
            jwks: "pinned",
          },
        },
      },
      { token },
    );

    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stdout.includes("access-user-123"));
    assert.ok(!result.stdout.includes("alice@example.com"));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.access_jwt.present, true);
    assert.match(payload.access_jwt.principal_fingerprint, /^[a-f0-9]{16}$/);
  });

  it("reports invalid base URLs without dumping the Access token", async () => {
    const token = jwt({ sub: "access-user-123" });
    const result = await runNodeScript({
      NOTEBOOK_CLOUD_URL: "not a url",
      NOTEBOOK_CLOUD_ACCESS_JWT: token,
    });

    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(token));
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.base_url, "<invalid>");
  });
});

async function runPreflight(healthPayload, { token } = {}) {
  const requestHeaders = {};
  const server = createServer((request, response) => {
    Object.assign(requestHeaders, request.headers);
    assert.equal(request.url, "/api/health");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(healthPayload));
  });

  try {
    await listen(server);
    const address = server.address();
    assert(address && typeof address === "object");
    const result = await runNodeScript({
      NOTEBOOK_CLOUD_URL: `http://127.0.0.1:${address.port}`,
      ...(token ? { NOTEBOOK_CLOUD_ACCESS_JWT: token } : {}),
    });
    return { result, requestHeaders };
  } finally {
    await close(server);
  }
}

function runNodeScript(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/hosted-access-preflight.mjs"],
      {
        cwd: appDir,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function jwt(payload) {
  return [base64UrlJson({ alg: "RS256", typ: "JWT" }), base64UrlJson(payload), "signature"].join(
    ".",
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
