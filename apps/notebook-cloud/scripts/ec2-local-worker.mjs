import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { notebookCloudAppDir, notebookCloudWorkspaceRoot } from "./local-dev.mjs";

const DEFAULT_EC2_PORT = 8787;
const DEFAULT_EC2_HOST = "0.0.0.0";

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const workspaceRoot = notebookCloudWorkspaceRoot();
  const appDir = notebookCloudAppDir();
  const plan = ec2LocalWorkerPlan({
    appDir,
    env: process.env,
    workspaceRoot,
  });

  printPlan(plan);

  const child = spawn("pnpm", plan.args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Failed to start EC2 notebook-cloud Worker: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

export function ec2LocalWorkerPlan({ appDir, env, workspaceRoot }) {
  const port = positiveInteger(env.NOTEBOOK_CLOUD_EC2_PORT, DEFAULT_EC2_PORT);
  const host = env.NOTEBOOK_CLOUD_EC2_HOST?.trim() || DEFAULT_EC2_HOST;
  const publicOrigin =
    normalizedOrigin(
      env.NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN || env.NTERACT_CLOUD_URL || env.NOTEBOOK_CLOUD_URL,
    ) ?? `http://localhost:${port}`;
  const persistTo = path.resolve(
    workspaceRoot,
    env.NOTEBOOK_CLOUD_EC2_PERSIST_TO || path.join(".context", "ec2", "notebook-cloud-state"),
  );
  const configPath = path.relative(workspaceRoot, path.join(appDir, "wrangler.toml"));
  const devToken = env.NOTEBOOK_CLOUD_DEV_TOKEN?.trim() || randomDevToken();
  const generatedDevToken = !env.NOTEBOOK_CLOUD_DEV_TOKEN?.trim();
  const oidcEnabled = env.NOTEBOOK_CLOUD_EC2_ENABLE_OIDC === "1";

  const vars = {
    DEPLOYMENT_ENV: "ec2",
    NOTEBOOK_CLOUD_ALLOWED_ORIGINS: publicOrigin,
    NOTEBOOK_CLOUD_DEV_TOKEN: devToken,
    // EC2 fallback defaults to same-origin assets and srcdoc output frames.
    RENDERER_ASSETS_BASE_URL: "",
    RUNTIMED_WASM_BASE_URL: "",
    OUTPUT_DOCUMENT_BASE_URL: "",
    ...(oidcEnabled
      ? {
          NOTEBOOK_CLOUD_OIDC_REDIRECT_URI:
            env.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI || `${publicOrigin}/oidc`,
        }
      : disabledOidcVars()),
  };

  const args = [
    "--workspace-root",
    "exec",
    "wrangler",
    "dev",
    "--config",
    configPath,
    "--local",
    "--ip",
    host,
    "--port",
    String(port),
    "--persist-to",
    persistTo,
    "--live-reload=false",
    "--show-interactive-dev-session=false",
  ];
  for (const [name, value] of Object.entries(vars)) {
    args.push("--var", `${name}:${value}`);
  }
  args.push(...extraWranglerArgs(env));

  return {
    args,
    devToken,
    generatedDevToken,
    host,
    oidcEnabled,
    persistTo,
    port,
    publicOrigin,
  };
}

function disabledOidcVars() {
  return {
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "",
    NOTEBOOK_CLOUD_OIDC_AUDIENCE: "",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "",
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: "",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "",
    NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "",
  };
}

function printPlan(plan) {
  console.error(`Starting notebook-cloud EC2 fallback on ${plan.host}:${plan.port}`);
  console.error(`Public origin: ${plan.publicOrigin}`);
  console.error(`Persisted Miniflare state: ${plan.persistTo}`);
  console.error(
    plan.oidcEnabled
      ? "OIDC override enabled; make sure the redirect URI is registered."
      : "OIDC disabled; use prototype dev-token auth for browser access.",
  );
  if (plan.generatedDevToken) {
    console.error(`Generated ephemeral NOTEBOOK_CLOUD_DEV_TOKEN: ${plan.devToken}`);
  }
  console.error(`Open ${plan.publicOrigin}/?dev_auth=1 to enter the dev token.`);
}

function positiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("NOTEBOOK_CLOUD_EC2_PORT must be an integer TCP port between 1 and 65535");
  }
  return parsed;
}

function normalizedOrigin(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    throw new Error(`NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN must be an absolute URL, got ${trimmed}`);
  }
}

function randomDevToken() {
  return `ec2-${randomBytes(24).toString("base64url")}`;
}

function extraWranglerArgs(env) {
  const raw = env.NOTEBOOK_CLOUD_EC2_WRANGLER_ARGS?.trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function isMainModule() {
  return import.meta.url === new URL(process.argv[1], "file:").href;
}
