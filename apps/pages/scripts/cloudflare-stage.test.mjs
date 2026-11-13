import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageCloudflareFiles, cloudflareConfig } from "./cloudflare-stage.mjs";
import { workerShape } from "./worker-shape.mjs";
import { releaseArtifacts, releaseFilesOf } from "./stage-artifacts.mjs";
import { VIEWER_ASSETS, hashedAssetPath } from "./viewer-chunks.mjs";

test("Cloudflare staging separates native modules from browser assets and excludes local secrets/state", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-cloudflare-stage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = path.join(dir, "dist");
  mkdirSync(path.join(dist, "public"), { recursive: true });
  const chunk = "public/chunks/ABCDEFGH.js";
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const assets = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [hashedAssetPath(name, name), name]),
  );
  mkdirSync(path.join(dist, "public/chunks"));
  const contents = (file) => assets[file] ?? file;
  for (const file of [...releaseArtifacts, chunk, ...Object.keys(assets)])
    writeFileSync(
      path.join(dist, file),
      file === "build-receipt.json"
        ? JSON.stringify({
            viewer_chunks: { [chunk]: sha256(chunk) },
            viewer_assets: Object.fromEntries(
              Object.entries(assets).map(([path, bytes]) => [path, sha256(bytes)]),
            ),
            files: Object.fromEntries(
              releaseFilesOf([chunk], Object.keys(assets)).map((file) => [
                file,
                sha256(contents(file)),
              ]),
            ),
          })
        : contents(file),
    );
  writeFileSync(path.join(dist, ".dev.vars"), "secret-that-must-stay-local");
  mkdirSync(path.join(dist, ".celld"));
  writeFileSync(path.join(dist, ".celld", "private.db"), "private");
  const destination = path.join(dir, "release");
  const config = JSON.parse(readFileSync(stageCloudflareFiles(dist, destination, profile())));
  assert.deepEqual(readdirSync(destination).sort(), [
    "build-receipt.json",
    "public",
    "worker",
    "wrangler.json",
  ]);
  assert.deepEqual(readdirSync(path.join(destination, "worker")).sort(), [
    "automerge.wasm",
    "index.js",
    "sift.wasm",
  ]);
  const mermaid = hashedAssetPath("mermaid.js", "mermaid.js");
  assert.equal(readFileSync(path.join(destination, mermaid), "utf8"), "mermaid.js");
  assert.deepEqual(readdirSync(path.join(destination, "public/chunks")), ["ABCDEFGH.js"]);
  assert.equal(config.main, "worker/index.js");
  assert.throws(() => stageCloudflareFiles(dist, destination, profile()), /must be new/);
});

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const USAGE_ID = "22222222-2222-4222-8222-222222222222";
const profile = (changes = {}) => ({
  name: "pages-example",
  workers_dev: true,
  d1: {
    auth: { database_name: "pages-example-auth", database_id: AUTH_ID },
    usage: { database_name: "pages-example-usage", database_id: USAGE_ID },
  },
  r2_bucket: "pages-example-assets",
  vars: {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages-example.example.workers.dev",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://id.example/auth",
    PAGES_CATALOG_INDEX: "d1",
  },
  ...changes,
});

test("the profile supplies the deployment's name, databases, bucket and variables", () => {
  const config = cloudflareConfig(profile());
  assert.equal(config.name, "pages-example");
  assert.equal(
    config.account_id,
    undefined,
    "Wrangler picks the account when the profile has none",
  );
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.d1_databases, [
    { binding: "DB", database_name: "pages-example-auth", database_id: AUTH_ID },
    { binding: "PAGES_USAGE", database_name: "pages-example-usage", database_id: USAGE_ID },
  ]);
  assert.deepEqual(config.r2_buckets, [
    { binding: "PAGES_ASSETS", bucket_name: "pages-example-assets" },
  ]);
  assert.deepEqual(config.vars, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages-example.example.workers.dev",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://id.example/auth",
    PAGES_CATALOG_INDEX: "d1",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
  });
  assert.equal(config.routes, undefined, "a profile without a custom domain sets no route");
  const account = "0123456789abcdef0123456789abcdef";
  assert.equal(cloudflareConfig(profile({ account_id: account })).account_id, account);
});

const DOMAIN = { hostname: "pages.example.com", zone_name: "example.com" };
const onDomain = (changes = {}) =>
  profile({
    workers_dev: false,
    custom_domain: DOMAIN,
    vars: { ...profile().vars, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example.com" },
    ...changes,
  });

test("a profile's custom domain becomes one route that names its zone", () => {
  const config = cloudflareConfig(onDomain());
  assert.deepEqual(config.routes, [
    { pattern: "pages.example.com", zone_name: "example.com", custom_domain: true },
  ]);
  assert.equal(config.workers_dev, false);
  // A zone can be several labels up from the hostname, or the hostname itself.
  const deep = { hostname: "pages.dev.example.co.uk", zone_name: "example.co.uk" };
  assert.deepEqual(
    cloudflareConfig(
      onDomain({
        custom_domain: deep,
        vars: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.dev.example.co.uk" },
      }),
    ).routes,
    [{ pattern: deep.hostname, zone_name: deep.zone_name, custom_domain: true }],
  );
  const apex = { hostname: "example.com", zone_name: "example.com" };
  assert.equal(
    cloudflareConfig(
      onDomain({
        custom_domain: apex,
        vars: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://example.com" },
      }),
    ).routes[0].pattern,
    "example.com",
  );
});

test("a custom domain is refused unless it is the deployment's one address", () => {
  const refuses = (changes, pattern) =>
    assert.throws(() => cloudflareConfig(onDomain(changes)), pattern);
  refuses({ workers_dev: true }, /workers_dev must be false/);
  const vars = onDomain().vars;
  refuses(
    {
      vars: { ...vars, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages-example.example.workers.dev" },
    },
    /must be the custom domain/,
  );
  refuses(
    { vars: { ...vars, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example.com:8443" } },
    /must be the custom domain/,
  );
  refuses({ custom_domain: "pages.example.com" }, /custom_domain must be an object/);
  refuses({ custom_domain: [DOMAIN] }, /custom_domain must be an object/);
  refuses({ custom_domain: null }, /custom_domain must be an object/);
  refuses({ custom_domain: { ...DOMAIN, path: "/p" } }, /Unknown profile custom_domain field/);
  refuses({ custom_domain: { hostname: DOMAIN.hostname } }, /zone_name must be the zone/);
  for (const hostname of [
    "Pages.example.com",
    "pages.example.com.",
    "pages.example.com/p",
    "https://pages.example.com",
    "*.example.com",
    "localhost",
    "pages..example.com",
    ["pages.example.com"],
    undefined,
  ])
    refuses({ custom_domain: { ...DOMAIN, hostname } }, /hostname must be a lowercase DNS name/);
  for (const zone_name of ["other.com", "ample.com", "pages.example.com.evil.com", "com", 7])
    refuses({ custom_domain: { ...DOMAIN, zone_name } }, /zone_name must be the zone/);
});

test("the Worker's classes, migrations, schedule and asset handling come from the shared shape", () => {
  const shape = workerShape();
  const config = cloudflareConfig(profile());
  for (const field of Object.keys(shape).filter((field) => field !== "vars"))
    assert.deepEqual(config[field], shape[field], field);
  assert.deepEqual(config.triggers, { crons: ["5 0 * * *", "35 * * * *"] });
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name),
    ["PAGES", "CATALOGS", "PAGE_RECORDS", "PROJECTS"],
  );
  const overridden = cloudflareConfig(
    profile({ vars: { ...profile().vars, NOTEBOOK_CLOUD_OIDC_FLOW: "browser" } }),
  );
  assert.equal(overridden.vars.NOTEBOOK_CLOUD_OIDC_FLOW, "server");
});

test("a profile is refused when it is incomplete, carries a secret or names an unknown field", () => {
  const refuses = (changes, pattern) =>
    assert.throws(() => cloudflareConfig(profile(changes)), pattern);
  assert.throws(() => cloudflareConfig("11111111-1111-4111-8111-111111111111"), /profile object/);
  refuses({ name: "Pages Example" }, /Worker name/);
  // JSON values a pattern would coerce to a matching string.
  refuses({ name: 123 }, /Worker name/);
  refuses({ r2_bucket: 123456 }, /R2 bucket name/);
  refuses({ account_id: ["0123456789abcdef0123456789abcdef"] }, /account ID/);
  refuses(
    { d1: { ...profile().d1, auth: { database_name: "auth", database_id: [AUTH_ID] } } },
    /d1\.auth\.database_id must be the D1 database UUID/,
  );
  refuses({ vars: ["NOTEBOOK_CLOUD_PUBLIC_ORIGIN"] }, /vars must be an object/);
  refuses({ account_id: "not-an-account" }, /account ID/);
  refuses({ workers_dev: undefined }, /workers_dev/);
  refuses({ r2_bucket: "Bad_Bucket" }, /R2 bucket name/);
  refuses({ routes: [{ pattern: "pages.example", custom_domain: true }] }, /Unknown profile field/);
  refuses({ d1: { auth: profile().d1.auth } }, /d1\.usage\.database_name/);
  refuses(
    { d1: { ...profile().d1, usage: { database_name: "usage", database_id: "usage" } } },
    /d1\.usage\.database_id must be the D1 database UUID/,
  );
  const vars = profile().vars;
  refuses({ vars: { ...vars, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://pages.example" } }, /https/);
  refuses({ vars: { ...vars, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example/p" } }, /https/);
  refuses({ vars: { PAGES_CATALOG_INDEX: "d1" } }, /NOTEBOOK_CLOUD_PUBLIC_ORIGIN/);
  refuses({ vars: { ...vars, PAGES_DEFAULT_PAGE_QUOTA: 50 } }, /must be a string/);
  for (const name of ["constructor", "toString", "__proto__", "pages_catalog_index", "1ST"])
    refuses({ vars: { ...vars, ...JSON.parse(`{"${name}":"x"}`) } }, /must be upper snake case/);
  for (const binding of [
    "ASSETS",
    "PAGES",
    "CATALOGS",
    "PAGE_RECORDS",
    "PROJECTS",
    "DB",
    "PAGES_USAGE",
    "PAGES_ASSETS",
  ])
    refuses({ vars: { ...vars, [binding]: "x" } }, /name of a binding/);
  for (const secret of [
    "NOTEBOOK_CLOUD_APP_SESSION_SECRET",
    "NOTEBOOK_CLOUD_APP_SESSION_KEYS",
    "NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET",
    "NOTEBOOK_CLOUD_LOCAL_OIDC",
    "PAGES_E2E_ONLY",
  ])
    refuses({ vars: { ...vars, [secret]: "x" } }, /does not belong/);
});
