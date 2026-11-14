import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleSlackPreview,
  slackPageId,
  slackPreviewEntity,
  verifySlackSignature,
} from "./slack-previews.mjs";

const origin = "https://pages.invalid";
const id = "12345678-1234-4123-8123-123456789abc";
const secret = "test-signing-secret";
const env = {
  PAGES_SLACK_SIGNING_SECRET: secret,
  PAGES_SLACK_TEAM_ID: "T_TEST",
  PAGES_SLACK_BOT_TOKEN: "test-bot-token",
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  PAGES: {
    getByName: () => ({
      fetch: async () =>
        Response.json({
          title: "Published",
          description: "Approved",
          revision: 2,
          mime_type: "image/png",
          published_at: "2026-11-14T12:00:00Z",
          owner: "must-not-leak",
          asset_id: "must-not-leak",
        }),
    }),
  },
};
async function signed(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${raw}`)),
  );
  const signature = "v0=" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`${origin}/api/slack/events`, {
    method: "POST",
    body: raw,
    headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
  });
}
test("Slack signatures reject tampering and expired deliveries before any API call", async () => {
  assert.equal(await verifySlackSignature("x", "0", "v0=" + "a".repeat(64), secret), false);
  const request = await signed({ type: "url_verification", challenge: "challenge" });
  assert.deepEqual(await (await handleSlackPreview(request, env)).json(), {
    challenge: "challenge",
  });
  const bad = await signed({ type: "url_verification", challenge: "challenge" }, "1000000000");
  await assert.rejects(handleSlackPreview(bad, env), { status: 401 });
  const wrongTeam = await signed({ type: "event_callback", team_id: "T_OTHER" });
  await assert.rejects(handleSlackPreview(wrongTeam, env), { status: 403 });
  assert.equal((await handleSlackPreview(new Request(origin), {})).status, 404);
});
test("Work Objects unfurl only published fields, including images; composer and details use the proper targets", async () => {
  const calls = [];
  const send = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ ok: true });
  };
  await handleSlackPreview(
    await signed({
      type: "event_callback",
      team_id: "T_TEST",
      event: {
        type: "link_shared",
        source: "composer",
        unfurl_id: "composer-id",
        links: [{ url: `${origin}/p/${id}` }, { url: `https://foreign.invalid/p/${id}` }],
      },
    }),
    env,
    { send },
  );
  assert.equal(calls[0].body.unfurl_id, "composer-id");
  assert.equal(calls[0].body.metadata.entities.length, 1);
  assert.match(
    calls[0].body.metadata.entities[0].entity_payload.fields.preview.image_url,
    /preview.png\?v=2$/,
  );
  assert.doesNotMatch(JSON.stringify(calls), /must-not-leak/);
  await handleSlackPreview(
    await signed({
      type: "event_callback",
      team_id: "T_TEST",
      event: {
        type: "entity_details_requested",
        trigger_id: "trigger",
        entity_url: `${origin}/p/${id}`,
      },
    }),
    env,
    { send },
  );
  assert.equal(calls[1].url, "https://slack.com/api/entity.presentDetails");
  assert.equal(calls[1].body.trigger_id, "trigger");
  assert.equal(calls[1].body.metadata.app_unfurl_url, undefined);
});
test("private and removed Pages return generic metadata without inferring access from Slack", () => {
  const entity = slackPreviewEntity(origin, id, null);
  assert.equal(entity.entity_payload.attributes.title.text, "Pages");
  assert.equal(entity.entity_payload.fields.preview, undefined);
  assert.equal(slackPageId(`${origin}.evil/p/${id}`, origin), null);
  assert.equal(slackPageId(`${origin}/p/${id}/preview.json`, origin), null);
  assert.equal(slackPageId(`${origin}/p/${id}#section`, origin), id);
});
test("Slack delivery errors are retriable, never acknowledged as delivered", async () => {
  await assert.rejects(
    handleSlackPreview(
      await signed({
        type: "event_callback",
        team_id: "T_TEST",
        event: {
          type: "link_shared",
          channel: "C_TEST",
          message_ts: "1.2",
          links: [{ url: `${origin}/p/${id}` }],
        },
      }),
      env,
      { send: async () => Response.json({ ok: false, error: "ratelimited" }) },
    ),
    { status: 503 },
  );
});

test("slugged links resolve to the same published Page and asset paths do not", () => {
  assert.equal(slackPageId(`${origin}/p/${id}/My-Page`, origin), id);
  assert.equal(slackPageId(`${origin}/p/${id}/preview.png`, origin), null);
  assert.equal(slackPageId(`${origin}/p/${id}/preview.json`, origin), null);
});
