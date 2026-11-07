#!/usr/bin/env node
// Prepare a separate Worker deployment; resource creation and domain attachment
// are explicit Wrangler/API operations outside this read/copy-only helper.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageArtifacts } from "./stage-artifacts.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { CRONS } from "../shared/schedule.mjs";

const INPUTS = Object.freeze([
  "accountId",
  "workerName",
  "databaseId",
  "databaseName",
  "usageDatabaseId",
  "usageDatabaseName",
  "assetsBucket",
  "publicOrigin",
  "oidcIssuer",
  "oidcClientId",
  "oidcAudience",
  "principalNamespace",
  "oidcUserinfoOrigin",
  "apiKeyUserinfoUrl",
  "oidcTokenAuthMethod",
]);

export function cloudflareConfig(target) {
  if (!target || typeof target !== "object" || Array.isArray(target))
    throw new Error("Provide an explicit non-secret Cloudflare target JSON object");
  for (const key of Object.keys(target))
    if (!INPUTS.includes(key))
      throw new Error("Unknown Cloudflare target input; see the documented field allowlist");
  for (const key of INPUTS)
    if (
      typeof target[key] !== "string" ||
      !target[key].trim() ||
      target[key] !== target[key].trim()
    )
      throw new Error(`Provide ${key} as a non-empty, trimmed string`);
  if (!/^[0-9a-f]{32}$/.test(target.accountId)) throw new Error("Provide the Cloudflare accountId");
  for (const key of ["databaseId", "usageDatabaseId"])
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target[key]))
      throw new Error(`Provide ${key} as a D1 database UUID`);
  if (
    target.databaseId === target.usageDatabaseId ||
    target.databaseName === target.usageDatabaseName
  )
    throw new Error("Auth and usage must use separate D1 databases");
  for (const key of ["workerName", "databaseName", "usageDatabaseName", "assetsBucket"])
    if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(target[key]))
      throw new Error(`Provide ${key} as a 3-63 character lowercase resource name`);
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(target.principalNamespace))
    throw new Error("Provide a stable principalNamespace for both authentication paths");
  for (const key of ["publicOrigin", "oidcIssuer", "oidcUserinfoOrigin", "apiKeyUserinfoUrl"]) {
    let url;
    try {
      url = new URL(target[key]);
    } catch {
      throw new Error(`${key} must be a valid HTTPS URL`);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname.includes(".") ||
      url.hostname.endsWith(".") ||
      /^(localhost|127\.|\[)/.test(url.hostname)
    )
      throw new Error(`${key} must be a public HTTPS URL without credentials, query or fragment`);
    if (["publicOrigin", "oidcUserinfoOrigin"].includes(key) && target[key] !== url.origin)
      throw new Error(`${key} must be a canonical HTTPS origin without a path or trailing slash`);
  }
  if (!["none", "client_secret_basic", "client_secret_post"].includes(target.oidcTokenAuthMethod))
    throw new Error("oidcTokenAuthMethod must be none, client_secret_basic or client_secret_post");
  return {
    name: target.workerName,
    account_id: target.accountId,
    main: "worker/index.js",
    no_bundle: true,
    base_dir: "worker",
    find_additional_modules: true,
    rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false }],
    compatibility_date: "2026-10-01",
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: "public",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    durable_objects: {
      bindings: [
        { name: "PAGES", class_name: "Page" },
        { name: "CATALOGS", class_name: "Catalog" },
        // Delete-only: purge clears old buffered records
        // (worker/page-records.mjs).
        { name: "PAGE_RECORDS", class_name: "PageRecords" },
        // Projects keep the Space class: the class name is the storage identity for
        // Projects, and celld 0.6.3 refuses renamed_classes migrations.
        { name: "PROJECTS", class_name: "Space" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
      { tag: "v2", new_sqlite_classes: ["PageRecords"] },
      { tag: "v3", new_sqlite_classes: ["Space"] },
    ],
    d1_databases: [
      { binding: "DB", database_name: target.databaseName, database_id: target.databaseId },
      {
        binding: "PAGES_USAGE",
        database_name: target.usageDatabaseName,
        database_id: target.usageDatabaseId,
      },
    ],
    triggers: { crons: [...CRONS] },
    // Create this private R2 bucket before publishing the Cloudflare target.
    r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: target.assetsBucket }],
    observability: { enabled: true },
    vars: {
      PAGES_CATALOG_INDEX: "1",
      PAGES_DEFAULT_PAGE_QUOTA: "250",
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: target.publicOrigin,
      NOTEBOOK_CLOUD_OIDC_FLOW: "server",
      NOTEBOOK_CLOUD_OIDC_ISSUER: target.oidcIssuer,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: target.oidcClientId,
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: target.oidcAudience,
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: target.principalNamespace,
      NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Anaconda",
      NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: target.publicOrigin + "/oidc",
      NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD: target.oidcTokenAuthMethod,
      NOTEBOOK_CLOUD_OIDC_USERINFO: "true",
      NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN: target.oidcUserinfoOrigin,
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: target.principalNamespace,
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: target.apiKeyUserinfoUrl,
    },
  };
}

export function stageCloudflareFiles(dist, destination, target) {
  const config = cloudflareConfig(target);
  stageArtifacts(dist, destination);
  mkdirSync(path.join(destination, "worker"));
  for (const file of ["index.js", "automerge.wasm"])
    renameSync(path.join(destination, file), path.join(destination, "worker", file));
  // Keeping the assets outside the entrypoint directory prevents Wrangler from
  // attaching the browser WASM copies as duplicate Worker modules.
  writeFileSync(path.join(destination, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
  return path.join(destination, "wrangler.json");
}

export function prepareCloudflare(destination, target) {
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const git = (...args) => execFileSync("git", args, { cwd: app, encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) throw Error("Commit the reviewed source before staging");
  const dist = path.join(app, "dist");
  const receipt = JSON.parse(readFileSync(path.join(dist, "build-receipt.json")));
  if (
    receipt.source_dirty ||
    receipt.source_sha !== git("rev-parse", "HEAD") ||
    receipt.fingerprint?.sha256 !== sourceFingerprint(app).sha256
  )
    throw Error("Rebuild the clean committed source before staging");
  return stageCloudflareFiles(dist, path.resolve(destination), target);
}

// Qualification may use an uncommitted build, but cannot produce a retained
// release or read Wrangler credentials, dotenv files, or global configuration.
export function dryRunCloudflare(dist, target, { exec = execFileSync } = {}) {
  cloudflareConfig(target);
  const temporary = mkdtempSync(path.join(tmpdir(), "pages-cloudflare-check-"));
  try {
    const config = stageCloudflareFiles(dist, path.join(temporary, "release"), target);
    const home = path.join(temporary, "home");
    mkdirSync(home);
    const wranglerPackage = createRequire(import.meta.url).resolve("wrangler/package.json");
    const wrangler = path.join(path.dirname(wranglerPackage), "bin/wrangler.js");
    exec(
      process.execPath,
      [
        wrangler,
        "deploy",
        "--config",
        config,
        "--dry-run",
        "--outdir",
        path.join(temporary, "upload"),
      ],
      {
        cwd: temporary,
        stdio: "inherit",
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: temporary,
          XDG_CONFIG_HOME: home,
          WRANGLER_HOME: home,
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          CI: "true",
        },
      },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, targetFile, destination, ...extra] = process.argv.slice(2);
  if (
    !targetFile ||
    extra.length ||
    !["check", "dry-run", "prepare"].includes(command) ||
    (command === "check" ? destination : !destination)
  )
    throw Error(
      "Usage: cloudflare-stage.mjs check TARGET.json | dry-run TARGET.json DIST | prepare TARGET.json NEW_DESTINATION",
    );
  let target;
  try {
    target = JSON.parse(readFileSync(targetFile, "utf8"));
  } catch {
    throw new Error("Target file must be readable, valid JSON");
  }
  if (command === "check") console.log(JSON.stringify(cloudflareConfig(target), null, 2));
  else if (command === "dry-run") dryRunCloudflare(path.resolve(destination), target);
  else console.log(JSON.stringify({ config: prepareCloudflare(destination, target) }));
}
