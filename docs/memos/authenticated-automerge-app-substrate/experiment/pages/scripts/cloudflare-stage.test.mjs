import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageCloudflareFiles, cloudflareConfig, dryRunCloudflare } from "./cloudflare-stage.mjs";
import { releaseArtifacts, releaseFilesOf } from "./stage-artifacts.mjs";
import { VIEWER_ASSETS, hashedAssetPath } from "./viewer-chunks.mjs";
import { CRONS } from "../shared/schedule.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAuthFixture } from "../../auth-fixtures.mjs";

test("generated trust configuration authenticates discovered cross-origin userinfo", async (t) => {
  const { authenticateOidcRequest } = await import("@cloud/identity.ts");
  const fixture = await createAuthFixture();
  const issuer = "https://issuer-config-test.invalid";
  const endpoint = "https://profile-config-test.invalid/discovered-userinfo";
  const config = cloudflareConfig({
    ...target,
    oidcIssuer: issuer,
    oidcClientId: fixture.env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
    oidcAudience: fixture.env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
    oidcUserinfoOrigin: new URL(endpoint).origin,
  });
  const env = {
    ...config.vars,
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: fixture.env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON,
  };
  const token = await fixture.sign({ iss: issuer });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url) === issuer + "/.well-known/openid-configuration")
      return Response.json({ issuer, userinfo_endpoint: endpoint });
    assert.equal(String(url), endpoint);
    return Response.json({
      sub: fixture.subject,
      name: "Discovered Profile",
      email: "verified@example.invalid",
      email_verified: true,
    });
  });
  const request = new Request(target.publicOrigin);
  const credential = { token, transport: "header" };
  const untrusted = { ...env };
  delete untrusted.NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN;
  await assert.rejects(
    authenticateOidcRequest(request, untrusted, credential),
    /trusted https origin/,
  );
  assert.equal(calls.includes(endpoint), false, "never send a token to an untrusted origin");
  const identity = await authenticateOidcRequest(request, env, credential);
  assert.equal(identity.metadata.displayName, "Discovered Profile");
  assert.equal(identity.metadata.emailVerified, true);
  assert.ok(calls.includes(endpoint));
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_USERINFO_URL, undefined);
  const wrongOrigin = { ...env, NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN: "https://wrong.invalid" };
  await assert.rejects(
    authenticateOidcRequest(request, wrongOrigin, credential),
    /trusted https origin/,
  );
  assert.equal(calls.filter((url) => url === endpoint).length, 1);
});

test("generated same-origin userinfo follows discovery, not a configured endpoint path", async (t) => {
  const { authenticateOidcRequest } = await import("@cloud/identity.ts");
  const fixture = await createAuthFixture();
  const issuer = "https://same-origin-config-test.invalid";
  const endpoint = issuer + "/discovered-profile";
  const env = {
    ...cloudflareConfig({
      ...target,
      oidcIssuer: issuer,
      oidcClientId: fixture.env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
      oidcAudience: fixture.env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
      oidcUserinfoOrigin: issuer,
    }).vars,
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: fixture.env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON,
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === issuer + "/.well-known/openid-configuration")
      return Response.json({ issuer, userinfo_endpoint: endpoint });
    assert.equal(String(url), endpoint);
    return Response.json({ sub: fixture.subject, name: "Same Origin Profile" });
  });
  const identity = await authenticateOidcRequest(new Request(target.publicOrigin), env, {
    token: await fixture.sign({ iss: issuer }),
    transport: "header",
  });
  assert.equal(identity.metadata.displayName, "Same Origin Profile");
});

// Synthetic identifiers only; never an account or resource to deploy to.
const target = {
  accountId: "0".repeat(32),
  workerName: "pages-test-only",
  databaseId: "11111111-1111-4111-8111-111111111111",
  databaseName: "pages-test-auth",
  usageDatabaseId: "22222222-2222-4222-8222-222222222222",
  usageDatabaseName: "pages-test-usage",
  assetsBucket: "pages-test-assets",
  publicOrigin: "https://pages.example.invalid",
  oidcIssuer: "https://auth.example.invalid/api/auth",
  oidcClientId: "test-client",
  oidcAudience: "test-audience,test-client",
  principalNamespace: "pages-test-anaconda",
  oidcUserinfoOrigin: "https://auth.example.invalid",
  apiKeyUserinfoUrl: "https://auth.example.invalid/api/auth/sessions/whoami",
  oidcTokenAuthMethod: "none",
};

test("check CLI generates configuration offline and rejects incomplete target files", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pages-cloudflare-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "target.json");
  writeFileSync(file, JSON.stringify(target));
  const script = fileURLToPath(new URL("./cloudflare-stage.mjs", import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory },
    });
  const checked = run("check", file);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), cloudflareConfig(target));
  assert.deepEqual(readdirSync(directory), ["target.json"]);
  assert.notEqual(run("check", file, "unexpected-output").status, 0);
  assert.notEqual(run("prepare", file).status, 0);
  assert.notEqual(run("dry-run", file).status, 0);
  writeFileSync(file, JSON.stringify({ ...target, usageDatabaseId: "missing" }));
  const refused = run("check", file);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /D1 database UUID/);
  assert.equal(refused.stdout, "");
});

test("CLI invalid inputs never echo synthetic credentials", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pages-cloudflare-errors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "target.json");
  const script = fileURLToPath(new URL("./cloudflare-stage.mjs", import.meta.url));
  const cases = [
    ...["publicOrigin", "oidcIssuer", "oidcUserinfoOrigin", "apiKeyUserinfoUrl"].map((key) => [
      key,
      JSON.stringify({ ...target, [key]: "https://operator:EXAMPLE_SECRET@." }),
    ]),
    ...["publicOrigin", "oidcIssuer", "oidcUserinfoOrigin", "apiKeyUserinfoUrl"].map((key) => [
      key + " parse failure",
      JSON.stringify({ ...target, [key]: "https://operator:EXAMPLE_SECRET@[" }),
    ]),
    ["unknown field", JSON.stringify({ ...target, EXAMPLE_SECRET: "invalid" })],
    ["invalid JSON", '{"EXAMPLE_SECRET": INVALID}'],
    ...Object.keys(target).map((key) => [
      key + " invalid value",
      JSON.stringify({ ...target, [key]: " EXAMPLE_SECRET " }),
    ]),
  ];
  for (const [label, input] of cases)
    await t.test(label, () => {
      writeFileSync(file, input);
      const result = spawnSync(process.execPath, [script, "check", file], {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: directory },
      });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /EXAMPLE_SECRET|operator/);
    });
  const missing = spawnSync(process.execPath, [script, "check", "EXAMPLE_SECRET.json"], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: directory },
  });
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout + missing.stderr, /EXAMPLE_SECRET/);
});

test("Cloudflare config completes the current Worker contract without changing migration history", () => {
  const config = cloudflareConfig(target);
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "PAGES", class_name: "Page" },
    { name: "CATALOGS", class_name: "Catalog" },
    { name: "PAGE_RECORDS", class_name: "PageRecords" },
    { name: "PROJECTS", class_name: "Space" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["Page", "Catalog"] },
    { tag: "v2", new_sqlite_classes: ["PageRecords"] },
    { tag: "v3", new_sqlite_classes: ["Space"] },
  ]);
  assert.deepEqual(config.d1_databases, [
    { binding: "DB", database_name: target.databaseName, database_id: target.databaseId },
    {
      binding: "PAGES_USAGE",
      database_name: target.usageDatabaseName,
      database_id: target.usageDatabaseId,
    },
  ]);
  assert.deepEqual(config.triggers, { crons: [...CRONS] });
  assert.deepEqual(config.assets, {
    directory: "public",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: true,
  });
  assert.equal(config.base_dir, "worker");
  assert.equal(config.find_additional_modules, true);
  assert.deepEqual(config.rules, [
    { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: false },
  ]);
  assert.equal(config.vars.PAGES_CATALOG_INDEX, "1");
  assert.equal(config.vars.PAGES_DEFAULT_PAGE_QUOTA, "250");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_USERINFO, "true");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN, target.oidcUserinfoOrigin);
  assert.equal(
    config.vars.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
    config.vars.NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE,
  );
  assert.equal(config.account_id, target.accountId);
  assert.equal(config.name, target.workerName);
});

test("target inputs fail closed before staging and never accept secrets or arbitrary Wrangler overrides", () => {
  assert.throws(() => cloudflareConfig(target.databaseId), /JSON object/);
  for (const key of Object.keys(target)) {
    const incomplete = { ...target };
    delete incomplete[key];
    assert.throws(() => cloudflareConfig(incomplete), new RegExp(key));
  }
  for (const changed of [
    { databaseId: "not-a-uuid" },
    { accountId: "not-an-account" },
    { usageDatabaseId: target.databaseId },
    { usageDatabaseName: target.databaseName },
    { assetsBucket: "../bucket" },
    { workerName: "worker/other" },
    { publicOrigin: "http://pages.example.invalid" },
    { publicOrigin: "https://pages.example.invalid/oidc" },
    { publicOrigin: "https://pages.example.invalid/" },
    { publicOrigin: "https://name:password@pages.example.invalid" },
    { oidcIssuer: "https://localhost" },
    { oidcIssuer: "https://127.0.0.1" },
    { oidcUserinfoOrigin: "https://auth.example.invalid/userinfo" },
    { oidcUserinfoOrigin: "https://auth.example.invalid/" },
    { oidcUserinfoUrl: "https://auth.example.invalid/userinfo" },
    { apiKeyUserinfoUrl: "https://auth.example.invalid/whoami?token=x" },
    { oidcTokenAuthMethod: "guess" },
    { principalNamespace: " " },
    { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "not-allowed" },
    { vars: {} },
    { routes: ["example.invalid/*"] },
    { profile: "fresh" },
  ])
    assert.throws(() => cloudflareConfig({ ...target, ...changed }));
});

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
  const labConfig = readFileSync(path.join(dist, "wrangler.json"));
  const labReceipt = readFileSync(path.join(dist, "build-receipt.json"));
  const config = JSON.parse(readFileSync(stageCloudflareFiles(dist, destination, target)));
  assert.deepEqual(readFileSync(path.join(dist, "wrangler.json")), labConfig);
  assert.deepEqual(readFileSync(path.join(dist, "build-receipt.json")), labReceipt);
  assert.deepEqual(readFileSync(path.join(destination, "build-receipt.json")), labReceipt);
  assert.deepEqual(readdirSync(destination).sort(), [
    "build-receipt.json",
    "public",
    "worker",
    "wrangler.json",
  ]);
  assert.deepEqual(readdirSync(path.join(destination, "worker")).sort(), [
    "automerge.wasm",
    "index.js",
  ]);
  const mermaid = hashedAssetPath("mermaid.js", "mermaid.js");
  assert.equal(readFileSync(path.join(destination, mermaid), "utf8"), "mermaid.js");
  assert.deepEqual(readdirSync(path.join(destination, "public/chunks")), ["ABCDEFGH.js"]);
  assert.equal(config.main, "worker/index.js");
  assert.equal(config.d1_databases[0].database_id, target.databaseId);
  assert.deepEqual(config.r2_buckets, [
    { binding: "PAGES_ASSETS", bucket_name: target.assetsBucket },
  ]);
  assert.equal(config.routes, undefined, "domain reassignment is a separate verified action");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, target.publicOrigin + "/oidc");
  assert.equal(
    Object.keys(config.vars).some((k) => /SECRET|SESSION_KEYS|DEV_TOKEN|LOCAL_OIDC/.test(k)),
    false,
  );
  assert.throws(() => stageCloudflareFiles(dist, destination, target), /must be new/);
  for (const fails of [false, true]) {
    let temporary;
    const run = () =>
      dryRunCloudflare(dist, target, {
        exec: (node, args, options) => {
          temporary = options.cwd;
          assert.equal(node, process.execPath);
          assert.ok(args.includes("--dry-run"));
          assert.equal(args[1], "deploy");
          assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
          assert.equal(options.env.NODE_OPTIONS, undefined);
          assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
          assert.equal(options.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
          assert.equal(options.env.HOME, path.join(temporary, "home"));
          const staged = path.join(temporary, "release");
          assert.equal(existsSync(path.join(staged, ".dev.vars")), false);
          assert.equal(existsSync(path.join(staged, ".celld")), false);
          if (fails) throw new Error("synthetic Wrangler failure");
        },
      });
    if (fails) assert.throws(run, /synthetic Wrangler failure/);
    else run();
    assert.equal(existsSync(temporary), false, "qualification retains no release even on failure");
  }
});
