import { readPageRoute } from "../shared/routes.mjs";
// Optional, single-workspace Slack app. This adapter only consumes the public
// publication envelope. Slack identity is never a Pages credential. Until an
// account-linking flow exists, the flexpane shows that same public snapshot;
// opening the Page uses Pages' normal access checks.
import { HttpError } from "./auth.mjs";
import { readPublishedPreview, previewImageUrl } from "./published-preview.mjs";
import { validPageId } from "./registration.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";

export function slackPreviewEntity(origin, pageId, preview, sharedUrl = `${origin}/p/${pageId}`) {
  return {
    app_unfurl_url: sharedUrl,
    url: `${origin}/p/${pageId}`,
    external_ref: { id: pageId, type: "pages.page" },
    entity_type: "slack#/entities/content_item",
    entity_payload: {
      attributes: {
        title: { text: preview?.title ?? PRODUCT_NAME },
        display_type: "Page",
        ...(preview && {
          metadata_last_modified: Math.floor(Date.parse(preview.published_at) / 1000),
          full_size_preview: {
            is_supported: true,
            preview_url: previewImageUrl(origin, pageId, preview.revision),
            mime_type: preview.mime_type,
          },
        }),
      },
      fields: {
        description: {
          value: preview?.description ?? "Open this Page. Sign in to check your access.",
        },
        ...(preview && {
          preview: {
            type: "slack#/types/image",
            alt_text: preview.title,
            image_url: previewImageUrl(origin, pageId, preview.revision),
          },
        }),
      },
      display_order: preview ? ["preview", "description"] : ["description"],
    },
  };
}

export function slackPageId(value, origin) {
  try {
    const url = new URL(value);
    const route = readPageRoute(url.href);
    return url.origin === origin &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/p/") &&
      route.kind === "page" &&
      validPageId(route.pageId)
      ? route.pageId
      : null;
  } catch {
    return null;
  }
}

export async function verifySlackSignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (
    !/^\d{10}$/.test(timestamp ?? "") ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature ?? "")
  )
    return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(3).match(/../g), (hex) => parseInt(hex, 16));
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`v0:${timestamp}:${raw}`));
}

async function bodyText(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body required");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024) {
      await reader.cancel();
      throw new HttpError(413, "Request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** No fire-and-forget acknowledgement: Slack retries a failed/timed-out
 * request. Both methods replace an existing preview, rather than post a new
 * message, so duplicate deliveries don't create messages. */
export async function handleSlackPreview(request, env, { send = fetch } = {}) {
  if (!env.PAGES_SLACK_SIGNING_SECRET || !env.PAGES_SLACK_BOT_TOKEN || !env.PAGES_SLACK_TEAM_ID)
    return new Response(null, { status: 404 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const raw = await bodyText(request);
  if (
    !(await verifySlackSignature(
      raw,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      env.PAGES_SLACK_SIGNING_SECRET,
    ))
  )
    throw new HttpError(401, "Invalid Slack signature");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid Slack event");
  }
  if (body.type === "url_verification" && typeof body.challenge === "string")
    return Response.json({ challenge: body.challenge });
  if (body.team_id !== env.PAGES_SLACK_TEAM_ID)
    throw new HttpError(403, "Slack workspace not configured");
  if (body.type !== "event_callback") return Response.json({ ok: true });
  const event = body.event;
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN).origin;
  const present = async (method, args) => {
    const response = await send(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.PAGES_SLACK_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || !(await response.json()).ok)
      throw new HttpError(503, "Slack preview delivery failed");
  };
  if (event?.type === "link_shared") {
    const entities = (
      await Promise.all(
        (Array.isArray(event.links) ? event.links : []).slice(0, 5).map(async (link) => {
          const id = slackPageId(link.url, origin);
          return id
            ? slackPreviewEntity(origin, id, await readPublishedPreview(env, id, 750), link.url)
            : null;
        }),
      )
    ).filter(Boolean);
    if (entities.length) {
      const target =
        event.unfurl_id && ["composer", "conversations_history"].includes(event.source)
          ? { unfurl_id: event.unfurl_id, source: event.source }
          : { channel: event.channel, ts: event.message_ts };
      await present("chat.unfurl", { ...target, metadata: { entities } });
    }
  } else if (event?.type === "entity_details_requested") {
    const id = slackPageId(event.entity_url, origin);
    if (id && typeof event.trigger_id === "string") {
      const entity = slackPreviewEntity(origin, id, await readPublishedPreview(env, id, 750));
      const { app_unfurl_url: _url, ...metadata } = entity;
      await present("entity.presentDetails", { trigger_id: event.trigger_id, metadata });
    }
  }
  return Response.json({ ok: true });
}
