// Public recipes only. Neither the guide nor /connect handles a credential.
import { identityProvider } from "./identity-provider.mjs";

// These recipes are the keyed provider's: they use its fixed key names, which
// no deployment setting changes. A provider with no API key (`apiKey: null`)
// uses none of them, and its readers never call them.
const key = identityProvider().apiKey;
export const keyFile = key.keyFile;

export const saveKeyCommand = `python3 -c '
import getpass, os, pathlib, sys
if not sys.stdin.isatty():
    sys.exit("Run this in your own terminal to enter the key privately.")
path = pathlib.Path.home() / "${key.homePath}"
if path.exists() or path.is_symlink():
    sys.exit("No key saved: file already exists. Confirm reuse or choose a different account-specific filename.")
key = getpass.getpass("${key.name} (hidden): ").strip()
if not key or any(c.isspace() for c in key):
    sys.exit("No key saved: paste the API key only, without spaces.")
os.umask(0o077)
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
try:
    with path.open("x") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(key)
except FileExistsError:
    sys.exit("No key saved: file already exists. Confirm reuse or choose a different account-specific filename.")
print("Key saved privately. Tell your agent it is ready.")
'`;

export const pagesAgentEnvrc = `export PAGES_AGENT="release agent"`;

export function checkAccountCommand(origin) {
  return `python3 - <<'PY'
import http.client, json, pathlib, sys, urllib.error, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
try:
    key = (pathlib.Path.home() / "${key.homePath}").read_text().strip()
except OSError:
    sys.exit("Cannot read the Pages key file. Check the chosen path and permissions.")
if not key or any(c.isspace() for c in key):
    sys.exit("Invalid key file. Save only the raw API key privately.")
request = urllib.request.Request(${JSON.stringify(origin + "/whoami")}, headers={"Authorization": "Bearer " + key, "User-Agent": "pages-account-check"})
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        result = json.load(response)
    account, credential = result["account"], result["credential"]
    summary = {"account": {name: account[name] for name in ("principal", "display_name", "email") if name in account},
               "credential": {name: credential[name] for name in ("kind", "can_write")}}
    for fields in summary.values():
        for name, value in fields.items():
            if isinstance(value, str):
                fields[name] = value.replace(key, "[redacted]")
            elif value is not None and not isinstance(value, bool):
                raise ValueError("Unexpected summary field")
    print(json.dumps(summary))
except urllib.error.HTTPError as error:
    if 300 <= error.code < 400:
        sys.exit("Redirect refused. Check the configured Pages origin; the key was not forwarded.")
    sys.exit("Pages account check failed (HTTP %d). Check authorization or retry a server error later." % error.code)
except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, KeyError, TypeError):
    sys.exit("Pages account check failed. Check connectivity and the configured Pages origin.")
PY`;
}

export function setupPrompt(origin, provider) {
  if (!provider.apiKey) return oauthSetupPrompt(origin, provider);
  return `Configure Pages for ${origin}/ using the agent guide at ${origin}/llms.txt. Coding agents, CLIs, and scripts connect with an ${key.name}; ChatGPT and other interactive cloud clients use OAuth. Inspect filenames, not secrets, in ~/.config/pages; ask me before reusing or replacing an existing key. For multiple accounts, use an account-specific filename such as ${keyFile}-rgbkrk consistently in the save command and client recipe; ${keyFile} remains the default. Ask me early to save an API key privately through ${origin}/connect, or to complete browser authorization, as needed. Prepare the non-secret settings while I do that. Do not ask me to paste credentials into chat or enable an empty-key connection. Preserve my other client settings. Reload MCP or start a new session, then call list_pages from that session to verify the connection. Configuration alone is not verification.`;
}

function oauthSetupPrompt(origin, provider) {
  return `Configure Pages for ${origin}/ using the agent guide at ${origin}/llms.txt. This deployment has no API keys. It connects by OAuth with a ${provider.label} account. Add the Pages MCP server to my client with the recipe for that client. Ask me early to complete the browser authorization. Prepare the settings while I do that. Do not ask me to paste credentials into chat, and do not look for any other credential. Preserve my other client settings. Reload MCP or start a new session, then call list_pages from that session to verify the connection. Configuration alone is not verification.`;
}

export function kiloConfig(origin) {
  return JSON.stringify(
    {
      mcp: {
        pages: {
          type: "remote",
          url: origin + "/mcp",
          oauth: {
            clientId: "pages-kilo",
            scope: "pages:read pages:write offline_access",
          },
          enabled: true,
          headers: { "X-Pages-Driver": "Kilo" },
        },
      },
    },
    null,
    2,
  );
}

export function kiloApiKeyConfig(origin) {
  return JSON.stringify(
    {
      mcp: {
        pages: {
          type: "remote",
          url: origin + "/mcp",
          oauth: false,
          enabled: true,
          headers: {
            Authorization: `Bearer {file:${keyFile}}`,
            "X-Pages-Driver": "Kilo",
            "X-Pages-Agent": "{env:PAGES_AGENT}",
          },
        },
      },
    },
    null,
    2,
  );
}

// Both header helpers read the raw key the same way and hold no secret.
const readKeyForHelper = `try:
    key = (pathlib.Path.home() / "${key.homePath}").read_text().strip()
except OSError:
    sys.exit("Cannot read the Pages API key. Complete /connect and check file permissions.")
if not key or any(c.isspace() for c in key):
    sys.exit("Pages needs an API key. Complete /connect first.")`;

export const codexHeaderHelper = `import json, pathlib, sys
${readKeyForHelper}
print(json.dumps({"Authorization": "Bearer " + key}))`;

// Claude Code sends the helper's whole JSON object as request headers. The
// session label comes from PAGES_AGENT in Claude Code's environment and is
// dropped when blank, longer than 80 characters, or not printable ASCII.
export const claudeCodeHeaderHelper = `import json, os, pathlib, sys
${readKeyForHelper}
headers = {"Authorization": "Bearer " + key, "X-Pages-Driver": "Claude Code"}
label = os.environ.get("PAGES_AGENT", "").strip()
if label and len(label) <= 80 and label.isascii() and label.isprintable():
    headers["X-Pages-Agent"] = label
print(json.dumps(headers))`;

/** The Authorization scheme of an upload capability (create_page_asset_upload). */
export const ASSET_UPLOAD_SCHEME = "Pages-Upload";

/** The curl command for an upload URL: the guide's line and the tool's
 * `example` field both come from here, so they can't drift apart. Each -H
 * value is a whole `Name: value` header, because curl silently drops an -H
 * argument that has no colon. Every argument is a placeholder, an enum
 * value, base64url or a configured URL, so single quotes are enough. */
export function assetUploadCommand({ file, contentType, token, uploadUrl }) {
  return `curl -sS --data-binary @${file} -H 'Content-Type: ${contentType}' -H 'Authorization: ${ASSET_UPLOAD_SCHEME} ${token}' '${uploadUrl}'`;
}

export function codexConfig(origin) {
  return `[mcp_servers.pages]
url = ${JSON.stringify(origin + "/mcp")}
http_headers_helper = "'<ABSOLUTE_PATH_TO_PYTHON3>' '<ABSOLUTE_PATH_TO_PAGES_MCP_HEADERS_PY>'"
http_headers = { "X-Pages-Driver" = "Codex" }`;
}

// Registers the helper at user scope. Project-scoped entries make Claude Code
// ask for folder trust before it runs a headersHelper.
export function claudeCodeAddCommand(origin) {
  const entry = JSON.stringify({
    type: "http",
    url: origin + "/mcp",
    headersHelper: "<ABSOLUTE_PATH_TO_PYTHON3> <ABSOLUTE_PATH_TO_CLAUDE_CODE_HEADERS_PY>",
  });
  return `claude mcp add-json --scope user pages '${entry}'`;
}

/** The Claude Code command that registers the server for OAuth.
 * Claude Code authenticates in the browser after /mcp. */
export function claudeCodeOAuthCommand(origin) {
  return `claude mcp add --transport http pages ${origin}/mcp`;
}
