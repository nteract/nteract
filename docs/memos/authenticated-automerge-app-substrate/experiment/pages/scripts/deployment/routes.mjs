import { deploymentProfile } from "./profiles.mjs";

export const oauthPaths =
  "oauth/(authorize|token|revoke)|[.]well-known/(oauth-protected-resource(/mcp)?|oauth-authorization-server)|";

export function routesFor(target = "pages-next", legacy = false) {
  const { hostname, listen } = deploymentProfile(target).deployment;
  const renderer = deploymentProfile(target).tunnelService ? "mermaid[.]js|" : "";
  // Frozen deployments retain their exact route receipts. Sharing targets expose
  // only the public setup page, its script, and the authenticated access API.
  const sharing = target === "page5" || target === "page6" || target === "page7";
  const connect = sharing ? "connect|connect[.]js|" : "";
  const access = sharing ? "access|" : "";
  const paths = legacy
    ? "index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|api/(tools|connect|sync|saved|auth/(login|logout|session))|oidc"
    : "index[.]html|app[.](js|css)|" +
      renderer +
      connect +
      (target === "page7" ? oauthPaths : "") +
      "(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|api/(" +
      access +
      "tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc";
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
