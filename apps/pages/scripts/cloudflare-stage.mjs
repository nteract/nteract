#!/usr/bin/env node
// Package this build for one Cloudflare Workers deployment, described by a
// profile file kept outside the repository. Resource creation and secrets are
// explicit Wrangler operations; this helper only reads and copies. A profile
// that names a custom domain gets it as a route, and `wrangler deploy`
// attaches it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageArtifacts } from "./stage-artifacts.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { AUTH_D1, USAGE_D1 } from "./deployment/profiles.mjs";
import { workerShape } from "./worker-shape.mjs";
import { WORKER_MODULES } from "./worker-modules.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Cloudflare's own limits: Worker names and R2 bucket names.
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// Session keys and client secrets go in with `wrangler secret put`. The other
// two switch on fixtures that must never run on a public host.
const REFUSED_VAR = /SECRET|SESSION_KEYS|DEV_TOKEN|LOCAL_OIDC|E2E_ONLY/;
const VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
const R2_BINDING = "PAGES_ASSETS";
// A lowercase DNS name of two or more labels, with no trailing dot.
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROFILE_FIELDS = [
  "name",
  "account_id",
  "workers_dev",
  "custom_domain",
  "d1",
  "r2_bucket",
  "vars",
];

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

/** The route that attaches a profile's custom domain, or undefined when it
 * names none.
 *
 * The zone is named, never inferred: Cloudflare's API can fail to work the
 * zone out from the hostname alone ("Can't infer zone from route"), which is
 * all `wrangler deploy --domain` gives it. A deployment with a custom domain
 * has one address. Its public origin must be that hostname, and `workers_dev`
 * must be off, so the Worker never also serves people's documents from an
 * origin its own origin checks refuse. */
function customDomainRoute(profile, origin) {
  const domain = profile.custom_domain;
  if (domain === undefined) return undefined;
  if (domain === null || typeof domain !== "object" || Array.isArray(domain))
    throw new Error("Profile custom_domain must be an object");
  const unknown = Object.keys(domain).filter((key) => !["hostname", "zone_name"].includes(key));
  if (unknown.length) throw new Error(`Unknown profile custom_domain field: ${unknown.join(", ")}`);
  const { hostname, zone_name: zone } = domain;
  if (!matches(HOSTNAME, hostname))
    throw new Error("Profile custom_domain.hostname must be a lowercase DNS name");
  if (!matches(HOSTNAME, zone) || (hostname !== zone && !hostname.endsWith(`.${zone}`)))
    throw new Error("Profile custom_domain.zone_name must be the zone that holds the hostname");
  if (origin.host !== hostname)
    throw new Error("Profile vars NOTEBOOK_CLOUD_PUBLIC_ORIGIN must be the custom domain");
  if (profile.workers_dev)
    throw new Error("Profile workers_dev must be false when it names a custom_domain");
  return { pattern: hostname, zone_name: zone, custom_domain: true };
}

/** The Wrangler configuration for one Cloudflare deployment of this build.
 *
 * Everything the build decides is fixed here: the entry module, the Durable
 * Object classes and their migrations, the cron triggers and the asset
 * handling. Everything a deployment decides comes from `profile`: its name
 * and account, its custom domain, its two D1 databases and R2 bucket, and its
 * plain variables (public origin, identity provider, quotas). A profile names
 * resources that already exist; nothing here creates them. */
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
    // Every variable the Worker reads is upper snake case. Wrangler groups
    // bindings in a plain object, so a name such as `constructor` breaks it.
    if (!VAR_NAME.test(key)) throw new Error(`Profile var ${key} must be upper snake case`);
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
  const route = customDomainRoute(profile, origin);
  return {
    name: profile.name,
    // Without an account here Wrangler uses CLOUDFLARE_ACCOUNT_ID or asks.
    ...(profile.account_id && { account_id: profile.account_id }),
    main: "worker/index.js",
    ...shape,
    workers_dev: profile.workers_dev,
    preview_urls: false,
    ...(route && { routes: [route] }),
    d1_databases: [
      database(profile, "auth", AUTH_D1.binding),
      database(profile, "usage", USAGE_D1.binding),
    ],
    r2_buckets: [{ binding: R2_BINDING, bucket_name: profile.r2_bucket }],
    observability: { enabled: true },
    vars: { ...vars, ...shape.vars },
  };
}

/** The part of cloudflareConfig that no deployment decides: the fields the
 * Worker's code and this build fix, with no name, account, address, database,
 * bucket or variable of a deployment in it. A deployment's own Wrangler file
 * supplies those. The release package (release-package.mjs) ships exactly this
 * object as its wrangler.json.
 *
 * Structural: main, no_bundle, compatibility_date, assets, durable_objects,
 * migrations, triggers, preview_urls, observability, and the one shape var,
 * NOTEBOOK_CLOUD_OIDC_FLOW. Profile-bound: name, account_id, workers_dev,
 * routes, d1_databases, r2_buckets and every other var. */
export function structuralConfig() {
  const shape = workerShape();
  return {
    main: "worker/index.js",
    ...shape,
    preview_urls: false,
    observability: { enabled: true },
    vars: { ...shape.vars },
  };
}

/** Binding names the Worker expects a deployment to supply, by kind. Their
 * ids and bucket names are profile-bound; the names are fixed by the code. */
export function expectedBindings() {
  return { d1: [AUTH_D1.binding, USAGE_D1.binding], r2: [R2_BINDING] };
}

export function stageCloudflareFiles(dist, destination, profile) {
  return stageWithConfig(dist, destination, cloudflareConfig(profile));
}

/** Stage the Worker/assets layout and write `config` as wrangler.json. */
export function stageWithConfig(dist, destination, config) {
  stageArtifacts(dist, destination);
  mkdirSync(path.join(destination, "worker"));
  for (const file of ["index.js", ...WORKER_MODULES])
    renameSync(path.join(destination, file), path.join(destination, "worker", file));
  // Keeping the assets outside the entrypoint directory prevents Wrangler from
  // attaching the browser WASM copies as duplicate Worker modules.
  writeFileSync(path.join(destination, "wrangler.json"), JSON.stringify(config, null, 2) + "\n");
  return path.join(destination, "wrangler.json");
}

/** The dist directory of a clean, committed checkout whose build receipt
 * matches HEAD and the source on disk; throws otherwise. */
export function cleanBuildDist() {
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
  return dist;
}

export function prepareCloudflare(destination, profile) {
  return stageCloudflareFiles(cleanBuildDist(), path.resolve(destination), profile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [destination, profilePath, ...extra] = process.argv.slice(2);
  if (!destination || !profilePath || extra.length)
    throw Error("Usage: cloudflare-stage.mjs NEW_DESTINATION PROFILE.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  console.log(JSON.stringify({ config: prepareCloudflare(destination, profile) }));
}
