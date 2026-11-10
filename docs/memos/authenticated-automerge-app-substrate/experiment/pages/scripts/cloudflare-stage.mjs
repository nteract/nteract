#!/usr/bin/env node
// Package this build for one Cloudflare Workers deployment, described by a
// profile file kept outside the repository. Resource creation, secrets and
// domain attachment are explicit Wrangler operations; this helper only reads
// and copies.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageArtifacts } from "./stage-artifacts.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { AUTH_D1, USAGE_D1 } from "./deployment/profiles.mjs";
import { workerShape } from "./worker-shape.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Cloudflare's own limits: Worker names and R2 bucket names.
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// Session keys and client secrets go in with `wrangler secret put`. The other
// two switch on fixtures that must never run on a public host.
const REFUSED_VAR = /SECRET|SESSION_KEYS|DEV_TOKEN|LOCAL_OIDC|E2E_ONLY/;
const R2_BINDING = "PAGES_ASSETS";
const PROFILE_FIELDS = ["name", "account_id", "workers_dev", "d1", "r2_bucket", "vars"];

// A regular expression coerces what it tests, and the profile is JSON: without
// the type check a number or a one-element array would pass and reach Wrangler.
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

function database(profile, key, binding) {
  const entry = profile.d1?.[key];
  if (typeof entry?.database_name !== "string" || !entry.database_name)
    throw new Error(`Profile d1.${key}.database_name is required`);
  if (!matches(UUID, entry.database_id))
    throw new Error(`Profile d1.${key}.database_id must be the D1 database UUID`);
  return { binding, database_name: entry.database_name, database_id: entry.database_id };
}

/** The Wrangler configuration for one Cloudflare deployment of this build.
 *
 * Everything the build decides is fixed here: the entry module, the Durable
 * Object classes and their migrations, the cron triggers and the asset
 * handling. Everything a deployment decides comes from `profile`: its name
 * and account, its two D1 databases and R2 bucket, and its plain variables
 * (public origin, identity provider, quotas). A profile names resources that
 * already exist; nothing here creates them. */
export function cloudflareConfig(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("Provide a deployment profile object");
  const unknown = Object.keys(profile).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length) throw new Error(`Unknown profile field: ${unknown.join(", ")}`);
  if (!matches(WORKER_NAME, profile.name)) throw new Error("Profile name must be a Worker name");
  if (profile.account_id !== undefined && !matches(ACCOUNT_ID, profile.account_id))
    throw new Error("Profile account_id must be a Cloudflare account ID");
  if (typeof profile.workers_dev !== "boolean")
    throw new Error("Profile workers_dev must be true or false");
  if (!matches(BUCKET_NAME, profile.r2_bucket))
    throw new Error("Profile r2_bucket must be an R2 bucket name");
  const shape = workerShape();
  // A variable shares one namespace with the bindings; Wrangler refuses a
  // name declared twice.
  const bindings = new Set([
    shape.assets.binding,
    ...shape.durable_objects.bindings.map((binding) => binding.name),
    AUTH_D1.binding,
    USAGE_D1.binding,
    R2_BINDING,
  ]);
  const vars = profile.vars ?? {};
  if (vars === null || typeof vars !== "object" || Array.isArray(vars))
    throw new Error("Profile vars must be an object");
  for (const [key, value] of Object.entries(vars)) {
    if (bindings.has(key)) throw new Error(`Profile var ${key} is the name of a binding`);
    if (REFUSED_VAR.test(key)) throw new Error(`${key} does not belong in a profile's vars`);
    if (typeof value !== "string") throw new Error(`Profile var ${key} must be a string`);
  }
  let origin;
  try {
    origin = new URL(vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN);
  } catch {}
  if (origin?.protocol !== "https:" || origin.origin !== vars.NOTEBOOK_CLOUD_PUBLIC_ORIGIN)
    throw new Error("Profile vars need NOTEBOOK_CLOUD_PUBLIC_ORIGIN as an https origin");
  return {
    name: profile.name,
    // Without an account here Wrangler uses CLOUDFLARE_ACCOUNT_ID or asks.
    ...(profile.account_id && { account_id: profile.account_id }),
    main: "worker/index.js",
    ...shape,
    workers_dev: profile.workers_dev,
    preview_urls: false,
    d1_databases: [
      database(profile, "auth", AUTH_D1.binding),
      database(profile, "usage", USAGE_D1.binding),
    ],
    r2_buckets: [{ binding: R2_BINDING, bucket_name: profile.r2_bucket }],
    observability: { enabled: true },
    vars: { ...vars, ...shape.vars },
  };
}

export function stageCloudflareFiles(dist, destination, profile) {
  const config = cloudflareConfig(profile);
  stageArtifacts(dist, destination);
  mkdirSync(path.join(destination, "worker"));
  for (const file of ["index.js", "automerge.wasm"])
    renameSync(path.join(destination, file), path.join(destination, "worker", file));
  // Keeping the assets outside the entrypoint directory prevents Wrangler from
  // attaching the browser WASM copies as duplicate Worker modules.
  writeFileSync(path.join(destination, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
  return path.join(destination, "wrangler.json");
}

export function prepareCloudflare(destination, profile) {
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
  return stageCloudflareFiles(dist, path.resolve(destination), profile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [destination, profilePath, ...extra] = process.argv.slice(2);
  if (!destination || !profilePath || extra.length)
    throw Error("Usage: cloudflare-stage.mjs NEW_DESTINATION PROFILE.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  console.log(JSON.stringify({ config: prepareCloudflare(destination, profile) }));
}
