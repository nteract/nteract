// Public recipes only. Neither the guide nor /connect handles a credential.
export const keyFile = "~/.config/pages/anaconda-api-key";

export const saveKeyCommand = `python3 -c '
import getpass, os, pathlib, sys
if not sys.stdin.isatty():
    sys.exit("Run this in your own terminal to enter the key privately.")
key = getpass.getpass("Anaconda API key (hidden): ").strip()
if not key or any(c.isspace() for c in key):
    sys.exit("No key saved: paste the API key only, without spaces.")
os.umask(0o077)
path = pathlib.Path.home() / ".config/pages/anaconda-api-key"
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
with path.open("w") as output:
    os.fchmod(output.fileno(), 0o600)
    output.write(key)
print("Key saved privately. Tell your agent it is ready.")
'`;

export function setupPrompt(origin) {
  return `Configure Pages for ${origin}/ using the agent guide at ${origin}/llms.txt. Follow the connection method for this client. Ask me early to complete browser authorization or save an API key privately through ${origin}/connect, as needed. Prepare the non-secret settings while I do that. Do not ask me to paste credentials into chat or enable an empty-key connection. Preserve my other client settings. Once authenticated, call list_pages to verify the connection.`;
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
          },
        },
      },
    },
    null,
    2,
  );
}

export const codexHeaderHelper = `import json, pathlib, sys
try:
    key = (pathlib.Path.home() / ".config/pages/anaconda-api-key").read_text().strip()
except OSError:
    sys.exit("Cannot read the Pages API key. Complete /connect and check file permissions.")
if not key or any(c.isspace() for c in key):
    sys.exit("Pages needs an API key. Complete /connect first.")
print(json.dumps({"Authorization": "Bearer " + key}))`;

export function codexConfig(origin) {
  return `[mcp_servers.pages]
url = ${JSON.stringify(origin + "/mcp")}
http_headers_helper = "'<ABSOLUTE_PATH_TO_PYTHON3>' '<ABSOLUTE_PATH_TO_PAGES_MCP_HEADERS_PY>'"
http_headers = { "X-Pages-Driver" = "Codex" }`;
}
