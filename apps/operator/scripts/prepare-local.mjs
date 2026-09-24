import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: ["src/dev-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist-dev/dev-worker.js",
});
let secret;
try {
  secret = JSON.parse(await readFile("wrangler.local.json", "utf8")).vars
    .NOTEBOOK_CLOUD_APP_SESSION_SECRET;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const config = JSON.parse(await readFile("wrangler.json.example", "utf8"));
config.main = "dist-dev/dev-worker.js";
config.durable_objects = { bindings: [{ name: "DEV_ISSUER", class_name: "LocalOperatorIssuer" }] };
config.migrations = [{ tag: "operator-dev-v1", new_sqlite_classes: ["LocalOperatorIssuer"] }];
Object.assign(config.vars, {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://localhost:9470",
  NOTEBOOK_CLOUD_OIDC_ISSUER: "http://localhost:9470/dev/oidc",
  NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: "http://localhost:9470/oidc",
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "local-operator",
  NOTEBOOK_CLOUD_OIDC_AUDIENCE: "local-operator",
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "local-operator",
  NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
  NOTEBOOK_CLOUD_APP_SESSION_SECRET: secret ?? randomBytes(32).toString("hex"),
  OPERATOR_ALLOWED_EMAILS: "operator@example.test",
});
await writeFile("wrangler.local.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(
  "Local development configuration prepared. Run celld dev wrangler.local.json --host 127.0.0.1 --port 9470.",
);
