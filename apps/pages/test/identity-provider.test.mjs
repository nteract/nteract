import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentGuide } from "../agent-guide.mjs";
import { agentConnectionSetup, connectAgentResponse } from "../connect-agent.mjs";
import {
  claudeCodeOAuthCommand,
  keyFile,
  saveKeyCommand,
  setupPrompt,
} from "../agent-client-setup.mjs";
import { companyDomainValid, identityProvider } from "../identity-provider.mjs";
import { credentialRequired } from "../worker/auth.mjs";
import { companyViewDomains } from "../worker/domain-access.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
const production = {
  ...origin,
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
};
const kilo = { ...origin, PAGES_KILO_APP_URL: "https://kilo.example" };
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
  assert.ok(setupPrompt("https://pages.example", provider).includes(key.name));
  assert.ok(credentialRequired(production).message.includes(`Bearer <${key.name}>`));
});

test("PAGES_KILO_APP_URL selects Kilo, which has no API key and vouches for some accounts' email", () => {
  assert.deepEqual(identityProvider(kilo), {
    id: "kilo",
    label: "Kilo",
    companyDomains: [],
    organizations: true,
    apiKey: null,
    verifiedEmail: false,
  });
  // The setting's presence selects the provider; kiloSignIn validates the URL.
  assert.equal(identityProvider({ PAGES_KILO_APP_URL: "not a url" }).id, "kilo");
  for (const env of [undefined, {}, production, { PAGES_KILO_APP_URL: "" }]) {
    assert.equal(identityProvider(env).id, "anaconda");
    assert.equal(identityProvider(env).verifiedEmail, true);
    assert.equal(identityProvider(env).organizations, false);
  }
});

test("the guide and the connect page for a provider with no API key describe OAuth only", async () => {
  const provider = identityProvider(kilo);
  const guide = agentGuide(kilo);
  const page = await (
    await connectAgentResponse(new Request("https://pages.example/connect"), kilo)
  ).text();
  const keyFileHome = identityProvider(production).apiKey.homePath;
  for (const [name, text] of [
    ["guide", guide],
    ["page", page],
  ]) {
    for (const pattern of [
      /anaconda/i,
      /oauth: false/,
      /Authorization: Bearer </,
      /api-key\b.*recommended/i,
      /cloud:(read|write)/,
      /\$[A-Z_]*API_KEY/,
    ])
      assert.doesNotMatch(text, pattern, `${name} ${pattern}`);
    assert.ok(!text.includes(keyFileHome), `${name} key file`);
    assert.ok(!text.includes(saveKeyCommand), `${name} save command`);
    assert.ok(text.includes("pages-kilo"), name);
    assert.ok(text.includes("kilo mcp auth pages"), name);
    // An entry left from an API-key setup would be refused: both surfaces say to
    // take its header out.
    assert.match(text, /remove its\s+(?:<code>)?Authorization(?:<\/code>)?\s+header/, name);
    assert.ok(text.includes(claudeCodeOAuthCommand("https://pages.example")), name);
    assert.match(text, /no API keys/, name);
    assert.ok(text.includes("list_pages"), name);
  }
  for (const heading of [
    "API-key connection",
    "Save the key privately",
    "Check the account without exposing the key",
    "(API key, recommended)",
    "Codex Desktop / CLI",
    "Other MCP clients (API key)",
    "Get an API key",
    "use an API key",
  ])
    assert.ok(!guide.includes(heading), heading);
  assert.match(guide, /^- api_keys_unsupported \(401\)/m);
  assert.doesNotMatch(guide, /^- invalid_api_key/m);
  assert.match(guide, /^- auth_required \(401\): .*OAuth/m);
  assert.match(
    guide,
    /Only an account whose email address Kilo has verified can accept an\s+invitation by email here/,
  );
  assert.match(guide, /\/api\/tools accepts no\s+OAuth token/);
  assert.match(guide, /"X-Pages-Agent": "\{env:PAGES_AGENT\}" to the headers object/);
  assert.ok(
    guide.replace(/\s+/g, " ").includes(`"Sign in now" and "Use Claude's published identity"`),
  );
  assert.ok(guide.includes(`signs people and agents in with ${provider.label} accounts`));
  for (const heading of [
    "Create an API key",
    "Save it privately",
    "Check an API key",
    "header helper",
    "claude mcp add-json",
  ])
    assert.ok(!page.includes(heading), heading);
  for (const id of page.match(/data-copy="[^"]+"/g).map((attribute) => attribute.slice(11, -1)))
    assert.ok(page.includes(`id="${id}"`), `copy target ${id}`);
});

test("the guide keeps the same error codes, email note and client list for each provider", () => {
  for (const env of [kilo, production])
    assert.match(agentGuide(env), /client ID is the https URL of its client ID metadata/);
  // The email note belongs to a provider that doesn't verify every account's
  // email, not to Kilo by name.
  assert.doesNotMatch(agentGuide(production), /whose email address \w+ has verified/);
  assert.match(agentGuide(kilo), /whose email address Kilo has verified/);
  // Both variants answer every code a client can receive.
  assert.match(agentGuide(production), /^- invalid_api_key/m);
  assert.doesNotMatch(agentGuide(production), /api_keys_unsupported/);
});

test("setup, connection details and refusals for a provider with no API key name no key", () => {
  const provider = identityProvider(kilo);
  const prompt = setupPrompt("https://pages.example", provider);
  assert.match(prompt, /no API keys/);
  assert.match(prompt, /OAuth/);
  assert.match(prompt, /list_pages/);
  assert.doesNotMatch(prompt, /key file|~\/\.config|paste credentials into chat and/);
  assert.doesNotMatch(prompt, /Anaconda|API key;/);
  const setup = agentConnectionSetup(kilo);
  assert.equal(setup.apiKeyUrl, null);
  assert.doesNotMatch(setup.headers, /Authorization/);
  assert.match(setup.headers, /X-Pages-Driver/);
  const refusal = credentialRequired(kilo);
  assert.equal(refusal.status, 401);
  assert.equal(refusal.code, "auth_required");
  assert.match(refusal.message, /no API keys/);
  assert.match(refusal.message, /OAuth; see https:\/\/pages\.example\/connect$/);
  assert.doesNotMatch(refusal.message, /Bearer/);
});

test("a deployment can turn on only the provider's reviewed company domains", () => {
  const env = { NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "ns" };
  const on = (domains) => companyViewDomains({ ...env, PAGES_COMPANY_VIEW_DOMAINS: domains });
  assert.deepEqual(on("anaconda.com"), ["anaconda.com"]);
  assert.deepEqual(on(" anaconda.com , anaconda.com"), ["anaconda.com"]);
  assert.deepEqual(on("anaconda.com, example.com"), []);
  assert.deepEqual(on("example.com"), []);
  // Kilo reviews no company domains, so a Kilo deployment turns none on,
  // whatever address Kilo verifies for an account.
  for (const domains of ["anaconda.com", "example.com"])
    assert.deepEqual(
      companyViewDomains({ ...env, ...kilo, PAGES_COMPANY_VIEW_DOMAINS: domains }),
      [],
    );
});

test("a company domain value is a lower-case hostname of two or more labels", () => {
  for (const valid of ["anaconda.com", "a.b.c.example", "xn--bcher-kva.example", "a-1.co"])
    assert.equal(companyDomainValid(valid), true, valid);
  for (const invalid of [
    "",
    "com",
    "Anaconda.com",
    "ANACONDA.COM",
    "*.anaconda.com",
    "anaconda.com.",
    ".anaconda.com",
    "anaconda..com",
    "anaconda com",
    " anaconda.com",
    "anaconda.com\n",
    "-anaconda.com",
    "anaconda-.com",
    "anaconda_corp.com",
    "bücher.example",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
    "10.0.0.1",
    "127.1",
    "0x7f.0x1",
    "[::1]",
    "::1",
    "anaconda.com:443",
    "user@anaconda.com",
    "anaconda.com/path",
    undefined,
    null,
    42,
  ])
    assert.equal(companyDomainValid(invalid), false, String(invalid));
  // Line terminators and other whitespace or control characters, wherever
  // they sit. The label pattern's `$` has no `m` flag, so it matches only at
  // the end of the value, never before a final line terminator.
  for (const [form, invalid] of [
    ["trailing LF", "anaconda.com\n"],
    ["trailing CR", "anaconda.com\r"],
    ["trailing CRLF", "anaconda.com\r\n"],
    ["trailing LINE SEPARATOR", "anaconda.com\u2028"],
    ["trailing PARAGRAPH SEPARATOR", "anaconda.com\u2029"],
    ["leading LF", "\nanaconda.com"],
    ["LF inside a label", "ana\nconda.com"],
    ["LF as a label", "anaconda.\n.com"],
    ["tab", "anaconda.com\t"],
    ["embedded space", "ana conda.com"],
    ["embedded NUL", "ana\u0000conda.com"],
    ["trailing NUL", "anaconda.com\u0000"],
  ])
    assert.equal(companyDomainValid(invalid), false, form);
  // Each provider's reviewed list passes the same check; a bad entry would
  // have thrown when identity-provider.mjs loaded.
  for (const env of [production, kilo])
    for (const domain of identityProvider(env).companyDomains)
      assert.equal(companyDomainValid(domain), true, domain);
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
  [
    "auth-fixtures.mjs",
    "the tests' fake provider endpoints; not shipped, leaves if it moves under test/",
  ],
  ["worker/api-key-verifier.mjs", "calls the provider's verifier"],
  ["worker/usage.mjs", "a comment on why this operator may record principals"],
  ["viewer/ConnectedAgents.jsx", "viewer text; needs the provider in the session it loads"],
  ["worker/catalog-fixture.mjs", "a test namespace"],
  ["worker/gateway-fixture.mjs", "a test namespace"],
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
