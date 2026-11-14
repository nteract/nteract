// An owner's explicitly published envelope. Never derive this from live content.
// One atomic host record contains the snapshot and its last mutation receipt.
// Images are immutable, Page-local uploads; only the selected one is disclosed.
import { HttpError, authenticate, readJson, requireWrite } from "./auth.mjs";
import { pageState } from "./access.mjs";
import { validPageId } from "./registration.mjs";
import { imageAssetKey, readImageBody, inspectImage } from "./image-assets.mjs";
import { validAssetId } from "../shared/image-assets.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";
import { withTimeout } from "./catalog-index.mjs";

export const PREVIEW_KEY = "host/published-preview";
export const PREVIEW_READ = "/internal/published-preview";
export const PREVIEW_MANAGE = "/internal/published-preview/manage";
const initial = () => ({ name: "unpublished", revision: 0, snapshot: null });
const unavailable = () => new HttpError(404, "Preview unavailable", "preview_unavailable");
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (body) => Response.json(body, { headers });

export function publishedSnapshot(record, publication) {
  const snapshot = publication?.snapshot;
  return record &&
    pageState(record) === "active" &&
    publication?.name === "published" &&
    snapshot?.owner === record.owner &&
    snapshot.lifecycle_revision === (record.lifecycleRevision ?? 0)
    ? snapshot
    : null;
}

/** Pure publication transition. Stale writers never restore a withdrawn image.
 * Persistence is one atomic put, followed by the host durability barrier. A
 * lost reply retries that exact record; older nonces fail the revision fence. */
export function publicationTransition(state, command, snapshot) {
  if (!["publish", "unpublish"].includes(command.action))
    throw new HttpError(400, "Use publish or unpublish");
  if (typeof command.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(command.nonce))
    throw new HttpError(400, "A mutation nonce is required");
  const fingerprint = JSON.stringify([
    command.action,
    command.expected_revision,
    command.title,
    command.description,
    command.asset_id,
    command.cover?.asset_id,
    command.cover?.name,
  ]);
  if (state.receipt?.nonce === command.nonce) {
    if (state.receipt.fingerprint !== fingerprint)
      throw new HttpError(409, "This nonce was used for another preview");
    return state;
  }
  if (
    !Number.isSafeInteger(command.expected_revision) ||
    command.expected_revision !== state.revision
  )
    throw new HttpError(409, "Preview changed. Reload before publishing.", "preview_conflict");
  return {
    name: command.action === "publish" ? "published" : "unpublished",
    revision: state.revision + 1,
    snapshot: command.action === "publish" ? snapshot : null,
    receipt: { nonce: command.nonce, fingerprint },
  };
}

export function previewFields(command) {
  const { title, description, asset_id } = command;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 160 ||
    typeof description !== "string" ||
    description.length > 400 ||
    !validAssetId(asset_id)
  )
    throw new HttpError(
      400,
      "Use a title up to 160 characters, a description up to 400, and a Page image",
    );
  const cover = command.cover;
  if (
    cover != null &&
    (!validAssetId(cover.asset_id) || typeof cover.name !== "string" || cover.name.length > 1024)
  )
    throw new HttpError(400, "Use a Page image and filename for the cover");
  return {
    title: title.trim(),
    description: description.trim(),
    asset_id,
    cover: cover == null ? null : { asset_id: cover.asset_id, name: cover.name },
  };
}

/** Called only inside the Page's serial queue. No anonymous caller reaches
 * identify(), invitation claiming, live document reads or the private card. */
export async function publicationHost(host, request) {
  const record = await host.ctx.storage.get("host/document");
  if (
    !record ||
    pageState(record) !== "active" ||
    host.pendingLifecycle ||
    (await host.ctx.storage.get("host/creation"))
  )
    throw unavailable();
  const state = (await host.ctx.storage.get(PREVIEW_KEY)) ?? initial();
  // A previous mutation may have lost its durability-barrier response.
  // Reads never advertise that cached record until the barrier succeeds.
  await host.ctx.storage.sync();
  if (new URL(request.url).pathname === PREVIEW_READ) {
    const snapshot = publishedSnapshot(record, state);
    if (!snapshot) throw unavailable();
    return reply({
      revision: state.revision,
      title: snapshot.title,
      description: snapshot.description,
      asset_id: snapshot.asset_id,
      mime_type: snapshot.mime_type,
      published_at: snapshot.published_at,
    });
  }
  const identity = await authenticate(request, host.env);
  if (identity.principal !== record.owner)
    throw new HttpError(403, "Only the Page owner can publish a preview");
  const command = await readJson(request);
  if (!command || typeof command !== "object" || Array.isArray(command))
    throw new HttpError(400, "Preview command required");
  const view = (value) => ({
    revision: value.revision,
    snapshot: publishedSnapshot(record, value)
      ? {
          title: value.snapshot.title,
          description: value.snapshot.description,
          asset_id: value.snapshot.asset_id,
          cover: value.snapshot.cover ?? null,
          published_at: value.snapshot.published_at,
        }
      : null,
  });
  if (command.action === "read") return reply(view(state));
  requireWrite(identity);
  // Validate the fence/nonce before reading any image bytes.
  let next = publicationTransition(state, command, null);
  if (next !== state && command.action === "publish") {
    const fields = previewFields(command);
    const object = await host.env.PAGES_ASSETS?.get(imageAssetKey(record.pageId, fields.asset_id));
    if (!object) throw new HttpError(400, "Choose an uploaded image from this Page");
    const bytes = await readImageBody(new Response(object.body));
    const image = inspectImage(bytes);
    // Source covers stay private. Only the composed asset is served publicly.
    if (fields.cover) {
      const cover = await host.env.PAGES_ASSETS?.get(
        imageAssetKey(record.pageId, fields.cover.asset_id),
      );
      if (!cover) throw new HttpError(400, "Choose an uploaded cover from this Page");
      inspectImage(await readImageBody(new Response(cover.body)));
    }
    next = publicationTransition(state, command, {
      ...fields,
      mime_type: image.mime_type,
      owner: record.owner,
      lifecycle_revision: record.lifecycleRevision ?? 0,
      published_at: new Date().toISOString(),
    });
  }
  await host.ctx.storage.put(PREVIEW_KEY, next);
  await host.ctx.storage.sync();
  return reply(view(next));
}

export async function readPublishedPreview(env, pageId, timeoutMs = 2000) {
  if (!validPageId(pageId)) return null;
  const response = await withTimeout(
    env.PAGES.getByName(pageId).fetch(
      new Request(`https://pages.internal${PREVIEW_READ}`, { method: "POST" }),
    ),
    timeoutMs,
    "Preview check timed out",
  );
  if (response.status >= 500) throw new HttpError(503, "Preview temporarily unavailable");
  return response.ok ? response.json() : null;
}

export const previewImageUrl = (origin, pageId, revision) =>
  `${origin}/p/${pageId}/preview.png?v=${revision}`;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

export function previewTags(origin, pageId, preview) {
  const title = preview?.title ?? PRODUCT_NAME;
  const description = preview?.description ?? "Open this Page. Sign in to check your access.";
  const tags = {
    "og:type": "article",
    "og:site_name": PRODUCT_NAME,
    "og:title": title,
    "og:description": description,
    "og:url": `${origin}/p/${pageId}`,
    "twitter:card": preview ? "summary_large_image" : "summary",
    ...(preview && {
      "og:image": previewImageUrl(origin, pageId, preview.revision),
      "og:image:alt": title,
      "twitter:image": previewImageUrl(origin, pageId, preview.revision),
    }),
  };
  return Object.entries(tags)
    .map(
      ([name, value]) =>
        `<meta ${name.startsWith("twitter:") ? "name" : "property"}="${name}" content="${escape(value)}">`,
    )
    .join("\n");
}

/** Public routes expose only the approved snapshot, even to a signed-in owner.
 * A generic shell for missing/private Pages does not confirm their existence. */
export async function publicPreviewResponse(request, env, pageId, file, fallback) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  const preview = await readPublishedPreview(env, pageId).catch(() => null);
  if (!preview && !file && fallback) return fallback();
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
  if (file) {
    if (
      !preview ||
      (file === "preview.png" &&
        new URL(request.url).searchParams.get("v") !== String(preview.revision))
    )
      return new Response(null, { status: 404, headers });
    if (file === "preview.json")
      return new Response(
        request.method === "HEAD"
          ? null
          : JSON.stringify({
              title: preview.title,
              description: preview.description,
              image_url: previewImageUrl(origin, pageId, preview.revision),
              published_at: preview.published_at,
            }),
        { headers: { ...headers, "content-type": "application/json" } },
      );
    const object = await env.PAGES_ASSETS?.get(imageAssetKey(pageId, preview.asset_id));
    if (!object) return new Response(null, { status: 404, headers });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: { ...headers, "content-type": preview.mime_type },
    });
  }
  // Fetch the canonical shell asset. celld redirects /index.html to /;
  // passing that redirect through would send every Page link to the library.
  const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  if (!shell.ok) return shell;
  const html = (await shell.text()).replace(
    "</head>",
    `${previewTags(origin, pageId, preview)}\n</head>`,
  );
  const outputHeaders = new Headers(shell.headers);
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"])
    outputHeaders.delete(name);
  for (const [name, value] of Object.entries(headers)) outputHeaders.set(name, value);
  return new Response(request.method === "HEAD" ? null : html, { headers: outputHeaders });
}
