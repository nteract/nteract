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
// only when a Page shows a Parquet dataframe. A separate group, so the asset
// route bytes stay unchanged for a profile without Sift tables.
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
// A lowercase v4 UUID, as the groups above spell it out.
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// A Page link with a slug (shared/routes.mjs isPageSlug): /p/<id>/<slug>,
// beside the plain /p/<id> above. The Worker checks the rest of the slug
// grammar. No dot, so the JSON files below never match it.
export const pageSlugPaths = `p/${uuid}/[A-Za-z0-9_-]{1,80}/?|`;
// What a link shows its reader (worker/link-previews.mjs readLinkRoute):
// /p/<page_id>/meta.json and /card.json, and the same two files under
// /project/<prj|sp>_<uuid>. No trailing slash; /s/<id> has no JSON routes.
export const linkPreviewPaths = `(p/${uuid}|project/(prj|sp)_${uuid})/(meta|card)[.]json|`;
// Grid card images (worker/card-images.mjs): GET /api/pages/<id>/card-image
// (the stored hash) and the owner's PUT ?hash=&theme= upload, which ingress
// matches by path alone, then GET|HEAD of one image, named as card-images.mjs
// CARD_IMAGE_FILE names it. Inside the api/( group.
export const cardImagePaths = `pages/${uuid}/card-image(/[0-9a-f]{64}-(light|dark)[.](webp|png|jpg))?|`;
// A Project's assets, which belong to its content document (the gateway's
// /api/(pages|projects)/<id>/assets route): the upload and one asset by its
// sha256. Inside the api/( group.
export const projectAssetPaths = `projects/(prj|sp)_${uuid}/assets(/[0-9a-f]{64})?|`;

export function routesFor(target) {
  const profile = deploymentProfile(target);
  const { hostname, listen } = profile.deployment;
  const renderer = profile.tunnelService ? "mermaid[.]js|" : "";
  const theme = profile.theme ? "theme[.]js|" : "";
  const chunks = profile.viewerChunks ? chunkPaths : "";
  const assets = profile.viewerAssets ? assetPaths : "";
  const sift = profile.siftTables ? siftPaths : "";
  const projects = profile.projectLinks ? projectPaths : "";
  const index = profile.indexRoutes ? indexPaths : "";
  // Sharing targets expose only the public setup page, its script, and the authenticated access API.
  const sharing = profile.sharing === true;
  const authenticatedAssets = profile.oauth === true;
  const connect = sharing ? "connect|connect[.]js|" : "";
  const access = sharing ? "access|" : "";
  const paths =
    "index[.]html|app[.](js|css)|" +
    theme +
    chunks +
    assets +
    sift +
    renderer +
    connect +
    (profile.whoami === true ? whoamiPaths : "") +
    (authenticatedAssets ? oauthPaths : "") +
    "(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|" +
    pageSlugPaths +
    projects +
    index +
    (profile.linkPreviews === true ? linkPreviewPaths : "") +
    "api/(" +
    access +
    (authenticatedAssets ? imagePaths : "") +
    (profile.accountRoutes === true ? accountPaths : "") +
    (profile.cardImages === true ? cardImagePaths : "") +
    (profile.projectAssets === true ? projectAssetPaths : "") +
    "tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc";
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
