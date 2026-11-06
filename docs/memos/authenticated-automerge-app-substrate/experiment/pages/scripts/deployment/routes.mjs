import { deploymentProfile } from "./profiles.mjs";

export const oauthPaths =
  "oauth/(authorize|token|revoke)|[.]well-known/(oauth-protected-resource(/mcp)?|oauth-authorization-server)|";
// Content-hashed viewer chunks (scripts/viewer-chunks.mjs VIEWER_CHUNK).
export const chunkPaths = "chunks/[A-Z2-7]{8}[.]js|";
// Content-hashed shell assets (scripts/viewer-chunks.mjs VIEWER_ASSET): each
// source name with its own extension only.
export const assetPaths =
  "(app|theme|mermaid)-[A-Z2-7]{8}[.]js|app-[A-Z2-7]{8}[.]css|(automerge|subduction)-[A-Z2-7]{8}[.]wasm|";
// Sift's content-hashed WASM (scripts/viewer-chunks.mjs VIEWER_ASSET), loaded
// only when a Page shows a Parquet dataframe. A separate group, so Page9's frozen
// asset route bytes stay exactly as deployed.
export const siftPaths = "sift-[A-Z2-7]{8}[.]wasm|";
// Exact identity endpoint; the Worker enforces GET and authentication.
export const whoamiPaths = "whoami|";
// Viewer Project links (shared/routes.mjs readPageRoute): /project/<id> and
// the older /s/<id>, which the viewer rewrites to /project/<id>.
export const projectPaths =
  "(project|s)/(prj|sp)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|";
// Viewer index routes (shared/routes.mjs readPageRoute): every Project the
// account can open, and every Page. Exact paths with an optional trailing
// slash; /pages keeps its search in the query string, which ingress doesn't
// match.
export const indexPaths = "projects/?|pages/?|";
// A person's own sign-ins and agent connections (worker/account-auth.mjs):
// /api/auth/logout-all, /api/auth/grants and /api/auth/grants/<handle>/revoke,
// where a handle is 43 base64url characters. Inside the api/( group.
export const accountPaths = "auth/(logout-all|grants(/[A-Za-z0-9_-]{43}/revoke)?)|";
export const imagePaths =
  "pages/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/assets(/[0-9a-f]{64})?|";

export function routesFor(target = "pages-next", legacy = false) {
  const profile = deploymentProfile(target);
  const { hostname, listen } = profile.deployment;
  const renderer = profile.tunnelService ? "mermaid[.]js|" : "";
  const theme = profile.theme ? "theme[.]js|" : "";
  const chunks = profile.viewerChunks ? chunkPaths : "";
  const assets = profile.viewerAssets ? assetPaths : "";
  const sift = profile.siftTables ? siftPaths : "";
  const projects = profile.projectLinks ? projectPaths : "";
  const index = profile.indexRoutes ? indexPaths : "";
  // Frozen deployments retain their exact route receipts. Sharing targets expose
  // only the public setup page, its script, and the authenticated access API.
  const sharing = profile.sharing === true;
  const authenticatedAssets = profile.oauth === true;
  const connect = sharing ? "connect|connect[.]js|" : "";
  const access = sharing ? "access|" : "";
  const paths = legacy
    ? "index[.]html|app[.](js|css)|(automerge|subduction)[.]wasm|health|mcp|api/(tools|connect|sync|saved|auth/(login|logout|session))|oidc"
    : "index[.]html|app[.](js|css)|" +
      theme +
      chunks +
      assets +
      sift +
      renderer +
      connect +
      (profile.whoami === true ? whoamiPaths : "") +
      (authenticatedAssets ? oauthPaths : "") +
      "(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|" +
      projects +
      index +
      "api/(" +
      access +
      (authenticatedAssets ? imagePaths : "") +
      (profile.accountRoutes === true ? accountPaths : "") +
      "tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc";
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
