import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function localClient(page, origin) {
  const login = await page.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  await page.goto(login.headers().location);
  const callback = origin + "/oauth/test/callback";
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const oauth = { client_id: "pages-local-e2e", redirect_uri: callback, resource: origin + "/mcp" };
  await page.goto(
    origin +
      "/oauth/authorize?" +
      new URLSearchParams({
        ...oauth,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        scope: "pages:read pages:write",
        state,
      }),
  );
  await page.getByRole("button", { name: "Allow access" }).click();
  await page.waitForURL((url) => url.pathname === "/oauth/test/callback");
  const returned = new URL(page.url()).searchParams;
  assert.equal(returned.get("state"), state);
  const response = await page.request.post(origin + "/oauth/token", {
    form: {
      ...oauth,
      grant_type: "authorization_code",
      code: returned.get("code"),
      code_verifier: verifier,
    },
  });
  assert.ok(response.ok(), "Local OAuth code exchange failed");
  const token = (await response.json()).access_token;
  const client = new Client({ name: "Local Pages trial", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  return { client, tool };
}

export function pageEdits(tool, page_id) {
  async function edit(operations) {
    const { revision } = await tool("read_page", { page_id });
    return tool("edit_page", { page_id, revision, operations, nonce: crypto.randomUUID() });
  }
  async function source(source_id, name, bytes, content_type, source_revision = null) {
    const cap = await tool("create_page_asset_upload", {
      page_id,
      content_type,
      size: bytes.length,
    });
    const uploaded = await fetch(cap.upload_url, {
      method: "POST",
      headers: cap.headers,
      body: bytes,
    });
    assert.ok(uploaded.ok, await uploaded.clone().text());
    const { asset_id } = await uploaded.json();
    await edit([{ op: "set_source", source_id, name, asset_id, source_revision }]);
    return asset_id;
  }
  return { edit, source };
}
