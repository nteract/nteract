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
// Public media documentation; keep exact paths rather than opening /llms/* .
export const mediaGuidePaths = "llms/(assets-and-sources|views|anywidget|vega-lite)[.]txt|";
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
export const publishedPreviewPaths = `p/${uuid}/(preview[.]json|preview[.]png)|`;
export const publishedPreviewApiPaths = "link-preview|slack/events|";
// Grid card images (worker/card-images.mjs): GET /api/pages/<id>/card-image
// (the stored hash) and the owner's PUT ?hash=&theme= upload, which ingress
// matches by path alone, then GET|HEAD of one image, named as card-images.mjs
// CARD_IMAGE_FILE names it. Inside the api/( group.
export const cardImagePaths = `pages/${uuid}/card-image(/[0-9a-f]{64}-(light|dark)[.](webp|png|jpg))?|`;
// A Project's assets, which belong to its content document (the gateway's
// /api/(pages|projects)/<id>/assets route): the upload and one asset by its
// sha256. Inside the api/( group.
export const projectAssetPaths = `projects/(prj|sp)_${uuid}/assets(/[0-9a-f]{64})?|`;

// The REST routes (worker/rest-api.mjs), admitted by every target: one tag of
// one Page (PUT|DELETE /api/pages/<id>/tags/<tag>) and the listing (GET
// /api/pages). A tag is up to 64 characters of a-z, 0-9 and . _ : / -, sent as
// one percent-encoded path segment, so `/` is %2F and `:` is %3A. cloudflared
// matches ingress rules against the decoded path, so the Worker's encoded
// segment arrives here as `repo:org/name`: the class admits `/` and `%`, and
// the Worker, which matches one raw segment, refuses a tag path with more
// than one. 192 leaves room for a character that stays encoded (three
// characters). Case and `:` are admitted too: the Worker folds the first and
// decodes the second. One group, so a release before them is this one without
// it. Inside the api/( group.
export const restPaths = `pages/${uuid}/tags/[A-Za-z0-9._:%/-]{1,192}|pages|`;

const always = () => true;
const fixed = (paths) => Object.freeze({ paths });
// An optional route group: its path string, and whether a target's profile
// admits it. A group is strippable unless it is marked `settled`.
//
// Tunnel publication (isolated-publication.mjs) recognizes an installed
// config only by regenerating it: every combination of this target's
// strippable groups, each present or absent. So a new group is strippable by
// default and needs no migration code. Mark a group `settled` once every
// installation still in service has it; a settled group is always present.
//
// `earlier` holds older path strings for the same slot. A group's string can't
// change without one: configs sealed with the old string would stop matching.
const slot = (name, paths, enabled, { settled = false, earlier = [] } = {}) =>
  Object.freeze({ name, paths, enabled, settled, earlier: Object.freeze(earlier) });

// Every route the tunnel admits, in the order the ingress regex lists them.
// Sharing targets expose only the public setup page, its script, and the
// authenticated access API.
export const ROUTE_REGISTRY = Object.freeze([
  fixed("index[.]html|app[.](js|css)|"),
  slot("themePaths", "theme[.]js|", (profile) => Boolean(profile.theme), { settled: true }),
  slot("chunkPaths", chunkPaths, (profile) => Boolean(profile.viewerChunks), { settled: true }),
  slot("assetPaths", assetPaths, (profile) => Boolean(profile.viewerAssets), { settled: true }),
  slot("siftPaths", siftPaths, (profile) => Boolean(profile.siftTables)),
  slot("rendererPaths", "mermaid[.]js|", (profile) => Boolean(profile.tunnelService), {
    settled: true,
  }),
  slot("connectPaths", "connect|connect[.]js|", (profile) => profile.sharing === true, {
    settled: true,
  }),
  slot("whoamiPaths", whoamiPaths, (profile) => profile.whoami === true),
  slot("oauthPaths", oauthPaths, (profile) => profile.oauth === true, { settled: true }),
  fixed(
    "(automerge|subduction)[.]wasm|health|mcp|llms[.]txt|p/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/?|",
  ),
  slot("mediaGuidePaths", mediaGuidePaths, always),
  slot("pageSlugPaths", pageSlugPaths, always),
  slot("projectPaths", projectPaths, (profile) => Boolean(profile.projectLinks), {
    settled: true,
  }),
  slot("indexPaths", indexPaths, (profile) => Boolean(profile.indexRoutes), { settled: true }),
  slot("linkPreviewPaths", linkPreviewPaths, (profile) => profile.linkPreviews === true),
  slot("publishedPreviewPaths", publishedPreviewPaths, (profile) => profile.linkPreviews === true),
  fixed("api/("),
  slot("accessPaths", "access|", (profile) => profile.sharing === true, { settled: true }),
  slot(
    "publishedPreviewApiPaths",
    publishedPreviewApiPaths,
    (profile) => profile.linkPreviews === true,
  ),
  slot("imagePaths", imagePaths, (profile) => profile.oauth === true, { settled: true }),
  slot("accountPaths", accountPaths, (profile) => profile.accountRoutes === true),
  slot("cardImagePaths", cardImagePaths, (profile) => profile.cardImages === true),
  slot("projectAssetPaths", projectAssetPaths, (profile) => profile.projectAssets === true),
  slot("restPaths", restPaths, always),
  fixed("tools|connect|sync|saved|pages/register|auth/(login|logout|session))|oidc"),
]);

/** The strippable groups `target` admits, in registry order. */
export function strippableSlots(target) {
  const profile = deploymentProfile(target);
  return ROUTE_REGISTRY.filter((entry) => entry.name && !entry.settled && entry.enabled(profile));
}

/**
 * The ingress rules for `target`. `omit` names strippable groups to leave out;
 * `use` maps a strippable group to one of its `earlier` path strings. Without
 * either, these are the routes this release publishes.
 */
export function routesFor(target, { omit = [], use = {} } = {}) {
  const profile = deploymentProfile(target);
  const { hostname, listen } = profile.deployment;
  const strippable = new Set(strippableSlots(target).map((entry) => entry.name));
  for (const name of [...omit, ...Object.keys(use)])
    if (!strippable.has(name)) throw new Error("Not a strippable route group here: " + name);
  let paths = "";
  for (const entry of ROUTE_REGISTRY) {
    if (!entry.name) paths += entry.paths;
    else if (!entry.enabled(profile) || omit.includes(entry.name)) continue;
    else if (Object.hasOwn(use, entry.name)) {
      if (!entry.earlier.includes(use[entry.name]))
        throw new Error("Not an earlier path string of " + entry.name);
      paths += use[entry.name];
    } else paths += entry.paths;
  }
  return `  - hostname: ${hostname}
    path: ^/(${paths})?$
    service: http://${listen}
  - hostname: ${hostname}
    service: http_status:404
`;
}
