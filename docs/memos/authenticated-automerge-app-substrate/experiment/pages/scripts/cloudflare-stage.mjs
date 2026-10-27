#!/usr/bin/env node
// Prepare a separate Worker deployment; resource creation and domain attachment
// are explicit Wrangler/API operations outside this read/copy-only helper.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageArtifacts } from "./stage-artifacts.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";

export function cloudflareConfig(databaseId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId ?? ""))
    throw new Error("Provide the new Pages D1 database UUID");
  return {
    name: "nteract-pages-next",
    account_id: "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
    main: "worker/index.js",
    no_bundle: true,
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
        { name: "PAGE_RECORDS", class_name: "PageRecords" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
      { tag: "v2", new_sqlite_classes: ["PageRecords"] },
    ],
    d1_databases: [
      { binding: "DB", database_name: "nteract-pages-next-auth", database_id: databaseId },
    ],
    // Create this private R2 bucket before publishing the Cloudflare target.
    r2_buckets: [{ binding: "PAGES_ASSETS", bucket_name: "nteract-pages-images" }],
    observability: { enabled: true },
    vars: {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://preview.runt.run",
      NOTEBOOK_CLOUD_OIDC_FLOW: "server",
      NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "cec4781f-853c-4267-bf09-4bc59a2a3750",
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: "anaconda,cec4781f-853c-4267-bf09-4bc59a2a3750",
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
      NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Anaconda",
      NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "https://preview.runt.run/oidc",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL:
        "https://auth.stage.anaconda.com/api/auth/sessions/whoami",
    },
  };
}

export function stageCloudflareFiles(dist, destination, databaseId) {
  const config = cloudflareConfig(databaseId);
  stageArtifacts(dist, destination);
  mkdirSync(path.join(destination, "worker"));
  for (const file of ["index.js", "automerge.wasm", "subduction.wasm"])
    renameSync(path.join(destination, file), path.join(destination, "worker", file));
  // Keeping the assets outside the entrypoint directory prevents Wrangler from
  // attaching the browser WASM copies as duplicate Worker modules.
  writeFileSync(path.join(destination, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
  return path.join(destination, "wrangler.json");
}

export function prepareCloudflare(destination, databaseId) {
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
  return stageCloudflareFiles(dist, path.resolve(destination), databaseId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [destination, databaseId, ...extra] = process.argv.slice(2);
  if (!destination || !databaseId || extra.length)
    throw Error("Usage: cloudflare-stage.mjs NEW_DESTINATION D1_DATABASE_UUID");
  console.log(JSON.stringify({ config: prepareCloudflare(destination, databaseId) }));
}
