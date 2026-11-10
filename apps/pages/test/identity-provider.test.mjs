import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentGuide } from "../agent-guide.mjs";
import { agentConnectionSetup, connectAgentResponse } from "../connect-agent.mjs";
import { keyFile, saveKeyCommand, setupPrompt } from "../agent-client-setup.mjs";
import { identityProvider } from "../identity-provider.mjs";
import { credentialRequired } from "../worker/auth.mjs";
import { companyViewDomains } from "../worker/domain-access.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
const production = {
  ...origin,
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
};
const staging = {
  ...origin,
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL:
    "https://auth.stage.anaconda.com/api/auth/sessions/whoami",
};

test("the provider's fixed names don't depend on the deployment", () => {
  for (const env of [undefined, {}, production, staging]) {
    const provider = identityProvider(env);
    assert.equal(provider.id, "anaconda");
    assert.equal(provider.label, "Anaconda");
    assert.deepEqual(provider.companyDomains, ["anaconda.com"]);
    assert.equal(provider.apiKey.name, "Anaconda API key");
    assert.equal(provider.apiKey.envVar, "ANACONDA_API_KEY");
    assert.equal(provider.apiKey.alternateEnvVar, "ANACONDA_AUTH_API_KEY");
    assert.equal(provider.apiKey.keyFile, "~/" + provider.apiKey.homePath);
  }
});

test("only the production account service has a page for creating a key", () => {
  const live = identityProvider(production).apiKey;
  assert.equal(live.createUrl, "https://anaconda.com/app/profile/api-keys");
  assert.ok(live.connectInstructions.includes(`href="${live.createUrl}"`));
  for (const env of [staging, origin, undefined]) {
    const other = identityProvider(env).apiKey;
    assert.equal(other.createUrl, null);
    assert.doesNotMatch(other.connectInstructions, /href=/);
    assert.match(other.connectInstructions, /Ask the deployment owner/);
  }
});

test("the guide, the connect page, the recipes and the refusals say what the provider says", async () => {
  const provider = identityProvider(production);
  const key = provider.apiKey;
  const guide = agentGuide(production);
  assert.ok(guide.includes(key.createGuide));
  assert.ok(guide.includes(`Authorization: Bearer <${key.name}>`));
  assert.ok(guide.includes("$" + key.envVar));
  assert.ok(guide.includes(key.alternateEnvVar));
  assert.ok(guide.includes(key.keyFile));
  const response = await connectAgentResponse(
    new Request("https://pages.example/connect"),
    production,
  );
  const page = await response.text();
  assert.ok(page.includes(key.connectInstructions));
  assert.ok(page.includes(`connect with an ${key.name}.`));
  assert.equal(agentConnectionSetup(production).apiKeyUrl, key.createUrl);
  assert.ok(agentConnectionSetup(production).headers.includes(`<YOUR_${key.envVar}>`));
  assert.equal(keyFile, key.keyFile);
  assert.ok(saveKeyCommand.includes(`"${key.homePath}"`));
  assert.ok(saveKeyCommand.includes(`${key.name} (hidden)`));
  assert.ok(setupPrompt("https://pages.example").includes(key.name));
  assert.ok(credentialRequired(production).message.includes(`Bearer <${key.name}>`));
});

test("a deployment can turn on only the provider's reviewed company domains", () => {
  const env = { NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "ns" };
  const on = (domains) => companyViewDomains({ ...env, PAGES_COMPANY_VIEW_DOMAINS: domains });
  assert.deepEqual(on("anaconda.com"), ["anaconda.com"]);
  assert.deepEqual(on(" Anaconda.com "), ["anaconda.com"]);
  assert.deepEqual(on("anaconda.com, example.com"), []);
  assert.deepEqual(on("example.com"), []);
});

// Code the Worker and the viewer ship: the modules at the top level, and
// everything under these directories. The top level also holds setup.mjs, the
// upstream patch modules and the test fixture auth-fixtures.mjs, so the scan
// reads those too. Deployment tooling under scripts/ names the provider's
// addresses on purpose, and tests may name anything.
const SHIPPED_DIRECTORIES = ["worker", "viewer", "shared", "model", "sync", "authz"];
const isSource = (file) => /\.(mjs|js|jsx|ts|tsx)$/.test(file) && !/\.test\./.test(file);
function shippedFiles(root = app) {
  const top = readdirSync(root).filter(isSource);
  const nested = SHIPPED_DIRECTORIES.flatMap((dir) =>
    readdirSync(path.join(root, dir), { recursive: true })
      .filter(isSource)
      .map((file) => `${dir}/${file.split(path.sep).join("/")}`),
  );
  return [...top, ...nested];
}
// Each entry says why the file names the provider and what would remove it.
const NAMES_THE_PROVIDER = new Map([
  ["identity-provider.mjs", "the description itself"],
  ["auth-fixtures.mjs", "the tests' fake provider endpoints; not shipped, leaves if it moves under test/"],
  ["worker/api-key-verifier.mjs", "calls the provider's verifier"],
  ["worker/usage.mjs", "a comment on why this operator may record principals"],
  ["viewer/ConnectedAgents.jsx", "viewer text; needs the provider in the session it loads"],
  ["worker/catalog-fixture.mjs", "a test namespace"],
  ["worker/projects-fixture.mjs", "a test namespace"],
  ["worker/trash-fixture.mjs", "a test namespace"],
]);

test("shipped code names the provider only where the list above says", () => {
  const files = shippedFiles();
  // The scan sees both levels; an empty or shallow listing would pass vacuously.
  assert.ok(files.includes("agent-guide.mjs") && files.includes("worker/auth.mjs"));
  const named = files.filter((file) =>
    /anaconda/i.test(readFileSync(path.join(app, file), "utf8")),
  );
  assert.deepEqual(named.sort(), [...NAMES_THE_PROVIDER.keys()].sort());
});

test("the scan reaches nested directories and skips tests and tooling", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pages-provider-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [...SHIPPED_DIRECTORIES, "viewer/panels/deep", "scripts"])
    mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of [
    "guide.mjs",
    "viewer/panels/deep/Provider.jsx",
    "viewer/panels/Provider.test.jsx",
    "viewer/notes.md",
    "scripts/install.mjs",
  ])
    writeFileSync(path.join(root, file), "");
  assert.deepEqual(shippedFiles(root), ["guide.mjs", "viewer/panels/deep/Provider.jsx"]);
});
