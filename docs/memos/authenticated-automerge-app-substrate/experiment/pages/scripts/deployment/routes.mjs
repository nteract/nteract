import { deploymentProfile } from "./profiles.mjs";

export const oauthPaths =
  "oauth/(authorize|token|revoke)|[.]well-known/(oauth-protected-resource(/mcp)?|oauth-authorization-server)|";
export const imagePaths =
  "pages/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/assets(/[0-9a-f]{64})?|";

export function routesFor(target = "pages-next", legacy = false) {
  const { hostname, listen } = deploymentProfile(target).deployment;
  const renderer = deploymentProfile(target).tunnelService ? "mermaid[.]js|" : "";
  // Frozen deployments retain their exact route receipts. Sharing targets expose
  // only the public setup page, its script, and the authenticated access API.
  const sharing = ["page5", "page6", "page7", "page8"].includes(target);
  const authenticatedAssets = target === "page7" || target === "page8";
  const connect = sharing ? "connect|connect[.]js|" : "";
  const access = sharing ? "access|" : "";
  const paths = legacy
    ? "index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|api/(tools|connect|sync|saved|auth/(login|logout|session))|oidc"
    : "index[.]html|app[.](js|css)|" +
      renderer +
      connect +
      (authenticatedAssets ? oauthPaths : "") +
      "(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|api/(" +
      access +
      (authenticatedAssets ? imagePaths : "") +
      "tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc";
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
