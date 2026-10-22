import { deploymentProfile } from "./profiles.mjs";

export function routesFor(target = "pages-next", legacy = false) {
  const { hostname, listen } = deploymentProfile(target).deployment;
  const paths = legacy
    ? "index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|api/(tools|connect|sync|saved|auth/(login|logout|session))|oidc"
    : "index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|api/(tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc";
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
