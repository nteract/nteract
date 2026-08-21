#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_CONFIG_URL = new URL("../wrangler.celld.jsonc", import.meta.url);

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`[celld-proof-config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  const source = await readFile(BASE_CONFIG_URL, "utf8");
  const config = parseJsonc(source);
  const generated = generatedCelldProofConfig(config, process.env);
  await writeFile(output, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output }));
}

export function generatedCelldProofConfig(base, env) {
  const applicationAccessKeyId = requiredEnv(
    env.NOTEBOOK_CLOUD_S3_ACCESS_KEY_ID,
    "NOTEBOOK_CLOUD_S3_ACCESS_KEY_ID",
  );
  const fleetAccessKeyId = requiredEnv(env.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID");
  if (applicationAccessKeyId === fleetAccessKeyId) {
    throw new Error("CellD fleet and notebook application-data access keys must differ");
  }

  return {
    ...base,
    vars: {
      ...base.vars,
      NOTEBOOK_CLOUD_S3_BUCKET: requiredEnv(
        env.NOTEBOOK_CLOUD_S3_BUCKET,
        "NOTEBOOK_CLOUD_S3_BUCKET",
      ),
      NOTEBOOK_CLOUD_S3_REGION: requiredEnv(
        env.NOTEBOOK_CLOUD_S3_REGION,
        "NOTEBOOK_CLOUD_S3_REGION",
      ),
      NOTEBOOK_CLOUD_S3_ENDPOINT: optionalEnv(env.NOTEBOOK_CLOUD_S3_ENDPOINT) ?? "",
      NOTEBOOK_CLOUD_S3_PREFIX: optionalEnv(env.NOTEBOOK_CLOUD_S3_PREFIX) ?? "",
      NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE:
        optionalEnv(env.NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE) ?? "false",
      AWS_ACCESS_KEY_ID: applicationAccessKeyId,
      AWS_SECRET_ACCESS_KEY: requiredEnv(
        env.NOTEBOOK_CLOUD_S3_SECRET_ACCESS_KEY,
        "NOTEBOOK_CLOUD_S3_SECRET_ACCESS_KEY",
      ),
      AWS_SESSION_TOKEN: optionalEnv(env.NOTEBOOK_CLOUD_S3_SESSION_TOKEN) ?? "",
      NOTEBOOK_CLOUD_DEV_TOKEN: requiredEnv(
        env.NOTEBOOK_CLOUD_DEV_TOKEN,
        "NOTEBOOK_CLOUD_DEV_TOKEN",
      ),
      NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS: "true",
    },
  };
}

export function parseJsonc(source) {
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}

function outputPath(args) {
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("usage: celld-proof-config.mjs --output PATH");
  }
  return resolve(args[1]);
}

function requiredEnv(value, name) {
  const normalized = optionalEnv(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function optionalEnv(value) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isMainModule(importMetaUrl, scriptPath) {
  return Boolean(scriptPath && fileURLToPath(importMetaUrl) === resolve(scriptPath));
}
