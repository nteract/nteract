import assert from "node:assert/strict";
import { test } from "node:test";
import { secretHash } from "@cloud/oidc-session-store.ts";
import worker from "./index.mjs";
import { Storage, world } from "./projects-fixture.mjs";
import {
  ASSET_UPLOAD_MAX_BYTES,
  ASSET_UPLOAD_TTL_MS,
  ASSET_UPLOAD_TYPES,
  UPLOAD_CREDENTIAL,
  issueAssetUpload,
  uploadBinding,
  uploadCapabilityToken,
  uploadIdentity,
  uploadVerdict,
  verifyAssetUpload,
} from "./asset-uploads.mjs";
import {
  inspectOperation,
  issueRetryToken,
  openCapability,
  signCapability,
} from "./operation-journal.mjs";
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  revokeOAuthToken,
} from "./oauth-store.mjs";
import { imageAssetKey, requireStoredImageAsset } from "./image-assets.mjs";
import { IMAGE_MAX_BYTES } from "../shared/image-assets.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";

const origin = "https://pages.invalid";
// Actual 3x2 rasters (Pillow) and a pyarrow table, shared with the byte-route tests.
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
    "base64",
  ),
);
const webp = new Uint8Array(
  Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
    "base64",
  ),
);
const parquet = new Uint8Array(
  Buffer.from(
    "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==",
    "base64",
  ),
);
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

class Bucket {
  objects = new Map();
  calls = [];
  async head(key) {
    this.calls.push(["head", key]);
    return this.objects.get(key) ?? null;
  }
  async put(key, bytes, options) {
    this.calls.push(["put", key]);
    if (this.objects.has(key)) return null;
    const object = {
      key,
      bytes: bytes.slice(),
      size: bytes.length,
      httpEtag: '"etag"',
      ...options,
    };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    this.calls.push(["get", key]);
    const object = this.objects.get(key);
    return object ? { ...object, body: new Blob([object.bytes]).stream() } : null;
  }
}

/** Real Catalog and Page hosts (projects-fixture.mjs) with private asset
 * storage and one Page the owner created. */
async function setup(t) {
  const w = await world(t);
  w.env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN = origin;
  w.env.PAGES_ASSETS = new Bucket();
  const created = await w.createPage({ title: "Mockups" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // Every host request the gateway makes for an upload, as sent.
  const authorizations = [];
  const pages = w.env.PAGES;
  w.env.PAGES = {
    getByName(id) {
      const host = pages.getByName(id);
      return {
        fetch(request, init) {
          if (new URL(request.url).pathname === "/internal/assets/authorize")
            authorizations.push(request.clone());
          return host.fetch(request, init);
        },
      };
    },
  };
  return { w, pageId: created.body.page_id, authorizations, bucket: w.env.PAGES_ASSETS };
}

async function issue(w, who, args) {
  const result = await w.call(who, "create_page_asset_upload", args);
  return result;
}

async function issued(w, args, who = "owner") {
  const result = await issue(w, who, args);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

/** The request the returned example makes: curl --data-binary with the
 * returned headers. `body: null` sends none. */
function uploadRequest(grant, { body = png, headers = {}, url = grant.upload_url, method } = {}) {
  return new Request(url, {
    method: method ?? (body === null ? "GET" : "POST"),
    headers: { ...grant.headers, ...headers },
    ...(body !== null && { body, duplex: "half" }),
  });
}

async function upload(w, grant, options) {
  const response = await worker.fetch(uploadRequest(grant, options), w.env);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const withToken = (grant, token) => ({
  ...grant,
  headers: { ...grant.headers, Authorization: `Pages-Upload ${token}` },
});
const tokenOf = (grant) => grant.headers.Authorization.slice("Pages-Upload ".length);
const puts = (bucket) => bucket.calls.filter(([method]) => method === "put").length;

// Pure decision ------------------------------------------------------------

test("uploadVerdict accepts a well-formed payload for this Page until its expiry", () => {
  const pageId = crypto.randomUUID();
  const now = 1_800_000_000_000;
  const valid = {
    purpose: "pages-asset-upload-v1",
    page: pageId,
    principal: "user:anaconda:person",
    kind: "api-key",
    iat: now,
    exp: now + ASSET_UPLOAD_TTL_MS,
  };
  const cases = [
    [valid, now, "valid"],
    [valid, now + ASSET_UPLOAD_TTL_MS - 1, "valid"],
    [valid, now + ASSET_UPLOAD_TTL_MS, "expired"],
    [valid, now + ASSET_UPLOAD_TTL_MS * 10, "expired"],
    [{ ...valid, kind: "oauth", grant: "g".repeat(43) }, now, "valid"],
    [{ ...valid, kind: "oidc" }, now, "valid"],
    [{ ...valid, content_type: "image/png", size: 10, sha256: "a".repeat(64) }, now, "valid"],
    [{ ...valid, page: crypto.randomUUID() }, now, "invalid"],
    [{ ...valid, page: undefined }, now, "invalid"],
    [{ ...valid, principal: "" }, now, "invalid"],
    [{ ...valid, principal: "x".repeat(1025) }, now, "invalid"],
    [{ ...valid, kind: UPLOAD_CREDENTIAL }, now, "invalid"],
    [{ ...valid, kind: "oauth" }, now, "invalid"],
    [{ ...valid, grant: "g".repeat(43) }, now, "invalid"],
    [{ ...valid, iat: "now" }, now, "invalid"],
    [{ ...valid, exp: valid.iat }, now, "invalid"],
    [{ ...valid, exp: now + ASSET_UPLOAD_TTL_MS + 1 }, now, "invalid"],
    [{ ...valid, content_type: "image/svg+xml" }, now, "invalid"],
    [{ ...valid, size: 0 }, now, "invalid"],
    [{ ...valid, sha256: "A".repeat(64) }, now, "invalid"],
    [null, now, "invalid"],
    [[valid], now, "invalid"],
  ];
  for (const [claims, at, expected] of cases)
    assert.equal(uploadVerdict(claims, { pageId, now: at }), expected, JSON.stringify(claims));
  assert.equal(uploadVerdict(valid, { pageId: undefined, now }), "invalid");
});

test("uploadBinding accepts only the documented arguments and normalizes them", () => {
  const pageId = crypto.randomUUID();
  assert.deepEqual(uploadBinding({ page_id: pageId }, pageId), {});
  assert.deepEqual(
    uploadBinding(
      { page_id: pageId, content_type: " Image/PNG ", size: 12, sha256: "AB".repeat(32) },
      pageId,
    ),
    { content_type: "image/png", size: 12, sha256: "ab".repeat(32) },
  );
  for (const args of [
    null,
    [],
    {},
    { page_id: crypto.randomUUID() },
    { page_id: pageId, file: "x" },
    { page_id: pageId, content_type: "image/gif" },
    { page_id: pageId, content_type: 1 },
    { page_id: pageId, size: 0 },
    { page_id: pageId, size: ASSET_UPLOAD_MAX_BYTES + 1 },
    { page_id: pageId, size: 1.5 },
    { page_id: pageId, sha256: "a".repeat(63) },
    { page_id: pageId, sha256: "g".repeat(64) },
  ])
    assert.throws(() => uploadBinding(args, pageId), { status: 400, code: "invalid_arguments" });
});

test("only the Pages-Upload scheme yields a capability token", () => {
  const request = (authorization) =>
    new Request(origin, { headers: authorization ? { authorization } : {} });
  assert.equal(uploadCapabilityToken(request()), undefined);
  assert.equal(uploadCapabilityToken(request("Bearer pu1.a.b")), undefined);
  assert.equal(uploadCapabilityToken(request("Pages-Uploader pu1.a.b")), undefined);
  assert.equal(uploadCapabilityToken(request("Pages-Upload pu1.a.b")), "pu1.a.b");
  assert.equal(uploadCapabilityToken(request("pages-upload pu1.a.b")), "pu1.a.b");
  assert.equal(uploadCapabilityToken(request("Pages-Upload")), "");
  assert.equal(uploadCapabilityToken(request("Pages-Upload a b")), "");
});

test("capabilities and retry tokens share a key but never verify as each other", async () => {
  const storage = new Storage();
  const pageId = crypto.randomUUID();
  const principal = "user:anaconda:person";
  const retry = await issueRetryToken(storage, { scope: `page:${pageId}`, principal });
  const identity = { principal, credentialKind: "api-key" };
  const grant = await issueAssetUpload(storage, {
    pageId,
    identity,
    args: { page_id: pageId },
    origin,
  });
  const capability = tokenOf(grant);
  const verify = (token) =>
    verifyAssetUpload(storage, token, { pageId, grantActive: () => assert.fail("not OAuth") });
  assert.equal((await verify(capability)).principal, principal);
  // A retry token is not a capability: wrong shape, and its MAC input lacks the purpose.
  assert.equal(
    await openCapability(storage, retry.retry_token, {
      purpose: "pages-asset-upload-v1",
      prefix: "pu1",
    }),
    null,
  );
  const [payload, signature] = retry.retry_token.split(".");
  assert.equal(
    await openCapability(storage, `pu1.${payload}.${signature}`, {
      purpose: "pages-asset-upload-v1",
      prefix: "pu1",
    }),
    null,
    "a retry token's signature does not cover a capability's MAC input",
  );
  await assert.rejects(verify(retry.retry_token), {
    status: 401,
    code: "upload_capability_invalid",
  });
  // A capability is not a retry token, even rebuilt as two parts.
  const [, capabilityPayload, capabilitySignature] = capability.split(".");
  for (const token of [capability, `${capabilityPayload}.${capabilitySignature}`])
    await assert.rejects(
      inspectOperation(storage, {
        key: `host/operation/v1_${"a".repeat(64)}_request-one`,
        digest: "digest",
        retryToken: token,
        scope: `page:${pageId}`,
        principal,
      }),
      { status: 400, code: "invalid_retry_token" },
    );
  // Another purpose with the same key is another capability.
  const other = await signCapability(storage, {
    purpose: "pages-something-else",
    prefix: "pu1",
    payload: { page: pageId },
  });
  assert.equal(
    await openCapability(storage, other, { purpose: "pages-asset-upload-v1", prefix: "pu1" }),
    null,
  );
  // Another Page's key, a changed byte, or no key at all.
  const elsewhere = new Storage();
  await issueRetryToken(elsewhere, { scope: `page:${pageId}`, principal });
  await assert.rejects(
    verifyAssetUpload(elsewhere, capability, { pageId, grantActive: () => true }),
    { code: "upload_capability_invalid" },
  );
  await assert.rejects(
    verifyAssetUpload(new Storage(), capability, { pageId, grantActive: () => true }),
    { code: "upload_capability_invalid" },
  );
  const changed = `pu1.${Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(capabilityPayload, "base64url")),
      principal: "user:anaconda:other",
    }),
  ).toString("base64url")}.${capabilitySignature}`;
  await assert.rejects(verify(changed), { code: "upload_capability_invalid" });
  for (const token of ["", "pu1", "pu1..", `${capability}x`, capability.replace("pu1.", "pu2.")])
    await assert.rejects(verify(token), { code: "upload_capability_invalid" });
});

test("an OAuth capability names its grant; a browser session's never outlives the session", async () => {
  const storage = new Storage();
  const pageId = crypto.randomUUID();
  const now = 1_800_000_000_000;
  await assert.rejects(
    issueAssetUpload(storage, {
      pageId,
      identity: { principal: "p", credentialKind: "oauth" },
      args: { page_id: pageId },
      origin,
      now,
    }),
    /missing its grant/,
  );
  await assert.rejects(
    issueAssetUpload(storage, {
      pageId,
      identity: { principal: "p", credentialKind: UPLOAD_CREDENTIAL },
      args: { page_id: pageId },
      origin,
      now,
    }),
    { status: 403 },
  );
  const session = await issueAssetUpload(storage, {
    pageId,
    identity: { principal: "p", credentialKind: "oidc", expiresAt: now + 60_000 },
    args: { page_id: pageId },
    origin,
    now,
  });
  assert.equal(session.expires_at, new Date(now + 60_000).toISOString());
  const oauth = await issueAssetUpload(storage, {
    pageId,
    identity: { principal: "p", credentialKind: "oauth", grantId: "g".repeat(43) },
    args: { page_id: pageId },
    origin,
    now,
  });
  assert.equal(oauth.expires_at, new Date(now + ASSET_UPLOAD_TTL_MS).toISOString());
  const seen = [];
  const claims = await verifyAssetUpload(storage, tokenOf(oauth), {
    pageId,
    now,
    grantActive: (grant) => seen.push(grant) && true,
  });
  assert.deepEqual(seen, ["g".repeat(43)]);
  assert.deepEqual(uploadIdentity(claims), {
    principal: "p",
    displayName: "p",
    accountDisplayName: null,
    driver: "API",
    canWrite: true,
    credentialKind: UPLOAD_CREDENTIAL,
    expiresAt: now + ASSET_UPLOAD_TTL_MS,
    upload: {},
  });
  await assert.rejects(
    verifyAssetUpload(storage, tokenOf(oauth), { pageId, now, grantActive: () => false }),
    { code: "upload_capability_invalid" },
  );
});

// Through the gateway and real Page hosts ------------------------------------

test("an API-key agent gets an upload URL and uploads with curl, never sending its key", async (t) => {
  const { w, pageId, authorizations, bucket } = await setup(t);
  const before = Date.now();
  const grant = await issued(w, { page_id: pageId });
  assert.equal(grant.page_id, pageId);
  assert.equal(grant.upload_url, `${origin}/api/pages/${pageId}/assets`);
  assert.equal(grant.method, "POST");
  assert.match(grant.headers.Authorization, /^Pages-Upload pu1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(grant.headers["Content-Type"], "application/octet-stream");
  const expires = Date.parse(grant.expires_at);
  assert.ok(expires >= before + ASSET_UPLOAD_TTL_MS && expires <= Date.now() + ASSET_UPLOAD_TTL_MS);
  assert.equal(grant.max_bytes, ASSET_UPLOAD_MAX_BYTES);
  assert.deepEqual(grant.accepted_types, ASSET_UPLOAD_TYPES);
  assert.equal(grant.bound, undefined);
  assert.equal(
    grant.example,
    `curl -sS --data-binary @path/to/file -H 'Content-Type: application/octet-stream' -H '${grant.headers.Authorization}' '${grant.upload_url}'`,
  );
  const fetches = globalThis.fetch.mock.callCount();

  const first = await upload(w, grant);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(first.body, {
    asset_id: await sha256(png),
    url: `/api/pages/${pageId}/assets/${await sha256(png)}`,
    asset_url: `/api/pages/${pageId}/assets/${await sha256(png)}`,
    mime_type: "image/png",
    width: 3,
    height: 2,
    size: png.length,
  });
  // Same bytes, same asset; one URL serves several files until it expires.
  const repeat = await upload(w, grant);
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.body, first.body);
  const dark = await upload(w, grant, { body: webp });
  assert.equal(dark.status, 201, JSON.stringify(dark.body));
  assert.equal(dark.body.mime_type, "image/webp");
  assert.equal(puts(bucket), 2);
  assert.deepEqual(
    await requireStoredImageAsset(bucket, { pageId, assetId: first.body.asset_id }),
    {
      asset_id: first.body.asset_id,
      asset_url: first.body.asset_url,
      mime_type: "image/png",
      width: 3,
      height: 2,
      size: png.length,
    },
  );
  // No provider lookup happened for an upload, and the Page host saw only
  // the capability: no API key, cookie or label of the caller's.
  assert.equal(globalThis.fetch.mock.callCount(), fetches);
  assert.equal(authorizations.length, 6, "two checks per upload");
  for (const request of authorizations) {
    assert.equal(request.headers.get("authorization"), grant.headers.Authorization);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("x-pages-driver"), null);
  }
  // The asset serves to the owner's own credential.
  const served = await worker.fetch(
    new Request(`${origin}${first.body.asset_url}`, {
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
    }),
    w.env,
  );
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);
});

test("a bound content type, size and SHA-256 refuse any other file before storage", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const digest = await sha256(png);
  const grant = await issued(w, {
    page_id: pageId,
    content_type: "image/png",
    size: png.length,
    sha256: digest.toUpperCase(),
  });
  assert.deepEqual(grant.bound, { content_type: "image/png", size: png.length, sha256: digest });
  assert.equal(grant.headers["Content-Type"], "image/png");
  assert.equal(grant.max_bytes, png.length);
  assert.match(grant.example, /--data-binary @path\/to\/file\.png -H 'Content-Type: image\/png'/);
  const mismatched = await upload(w, grant, {
    body: webp,
    headers: { "Content-Type": "image/webp" },
  });
  assert.equal(mismatched.status, 400, JSON.stringify(mismatched.body));
  assert.equal(mismatched.body.code, "upload_mismatch");
  for (const args of [
    { size: png.length + 1 },
    { sha256: await sha256(webp) },
    { content_type: PARQUET_MEDIA_TYPE },
  ]) {
    const other = await issued(w, { page_id: pageId, ...args });
    const refused = await upload(w, other, { headers: { "Content-Type": "image/png" } });
    assert.equal(refused.status, 400, JSON.stringify(args));
    assert.equal(refused.body.code, "upload_mismatch", JSON.stringify(args));
  }
  assert.equal(puts(bucket), 0);
  assert.equal(bucket.objects.size, 0);
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.asset_id, digest);
  // A dataset upload binds the same way.
  const dataset = await issued(w, { page_id: pageId, content_type: PARQUET_MEDIA_TYPE });
  assert.match(dataset.example, /@path\/to\/file\.parquet/);
  const table = await upload(w, dataset, { body: parquet });
  assert.equal(table.status, 201, JSON.stringify(table.body));
  assert.equal(table.body.mime_type, PARQUET_MEDIA_TYPE);
});

test("an expired upload URL is refused before any transfer or storage", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + ASSET_UPLOAD_TTL_MS + 1);
  const expired = await upload(w, grant);
  clock.mock.restore();
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "upload_capability_expired");
  assert.match(expired.body.error, /create_page_asset_upload/);
  assert.equal(bucket.calls.length, 0);
});

test("a capability works only on its own Page, and refusals don't tell Pages apart", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const other = (await w.createPage({ title: "Other" })).body.page_id;
  const grant = await issued(w, { page_id: pageId });
  const token = tokenOf(grant);
  const [prefix, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  const refusals = [];
  const refuse = async (target, label) => {
    const result = await upload(w, target);
    assert.equal(result.status, 401, label);
    assert.equal(result.body.code, "upload_capability_invalid", label);
    refusals.push(JSON.stringify(result.body));
  };
  await refuse({ ...grant, upload_url: `${origin}/api/pages/${other}/assets` }, "another Page");
  await refuse(
    { ...grant, upload_url: `${origin}/api/pages/${crypto.randomUUID()}/assets` },
    "a Page that doesn't exist",
  );
  const flipped = (text) => text.slice(0, -2) + (text.at(-2) === "A" ? "B" : "A") + text.at(-1);
  await refuse(withToken(grant, `${prefix}.${flipped(payload)}.${signature}`), "changed payload");
  await refuse(withToken(grant, `${prefix}.${payload}.${flipped(signature)}`), "changed signature");
  const renamed = Buffer.from(JSON.stringify({ ...claims, page: other })).toString("base64url");
  await refuse(
    {
      ...withToken(grant, `${prefix}.${renamed}.${signature}`),
      upload_url: `${origin}/api/pages/${other}/assets`,
    },
    "payload renamed to the other Page",
  );
  // Even a capability the other Page's key never signed, naming it, fails there.
  const forged = await signCapability(w.page(pageId).ctx.storage, {
    purpose: "pages-asset-upload-v1",
    prefix: "pu1",
    payload: { ...claims, page: other },
  });
  await refuse(
    { ...withToken(grant, forged), upload_url: `${origin}/api/pages/${other}/assets` },
    "signed with another Page's key",
  );
  await refuse(withToken(grant, token.slice(0, -4)), "truncated");
  await refuse(
    { ...grant, headers: { ...grant.headers, Authorization: "Pages-Upload" } },
    "no token",
  );
  // One body for every refusal: nothing distinguishes a missing Page.
  assert.equal(new Set(refusals).size, 1);
  assert.equal(bucket.calls.length, 0);
});

test("a retry token is not an upload capability", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const read = await w.call("owner", "read_page", { page_id: pageId, comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const grant = await issued(w, { page_id: pageId });
  for (const token of [
    read.body.retry_token,
    (await w.call("owner", "list_pages")).body.retry_token,
  ]) {
    const refused = await upload(w, withToken(grant, token));
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "upload_capability_invalid");
  }
  // And the capability is not this Page's retry token.
  await assert.rejects(
    inspectOperation(w.page(pageId).ctx.storage, {
      key: `host/operation/${read.body.retry_key_prefix}reuse-capability`,
      digest: "digest",
      retryToken: tokenOf(grant),
      scope: `page:${pageId}`,
      principal: w.owner,
    }),
    { code: "invalid_retry_token" },
  );
  assert.equal(bucket.calls.length, 0);
});

test("access removed after issue refuses the upload, before or during the transfer", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  let revision = 0;
  const setRole = async (role) => {
    const result = await w.call("owner", "manage_page_access", {
      page_id: pageId,
      action: "set_role",
      principal: w.member,
      role,
      expected_revision: revision,
      idempotency_key: w.key(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    revision = result.body.access?.revision ?? result.body.revision ?? revision + 1;
  };
  // A viewer, a read-only key and a stranger can't get an upload URL.
  await setRole("viewer");
  assert.equal((await issue(w, "member", { page_id: pageId })).status, 403);
  assert.equal((await issue(w, "reader", { page_id: pageId })).status, 403);
  assert.equal((await issue(w, "stranger", { page_id: pageId })).status, 403);
  await setRole("editor");
  const grant = await issued(w, { page_id: pageId }, "member");
  assert.equal((await upload(w, grant)).status, 201);
  await setRole("viewer");
  const downgraded = await upload(w, grant, { body: webp });
  assert.equal(downgraded.status, 403, JSON.stringify(downgraded.body));
  assert.equal(downgraded.body.code, "access_denied");
  await setRole(null);
  const removed = await upload(w, grant, { body: webp });
  assert.equal(removed.status, 403, JSON.stringify(removed.body));
  assert.equal(removed.body.code, "access_denied");
  assert.equal(puts(bucket), 1);

  // Removal while the bytes are in flight: the second check refuses the result.
  await setRole("editor");
  const during = await issued(w, { page_id: pageId }, "member");
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (entered = resolve));
  const put = bucket.put.bind(bucket);
  bucket.put = async (...args) => {
    entered();
    await gate;
    return put(...args);
  };
  const pending = upload(w, during, { body: webp });
  await started;
  await setRole(null);
  release();
  const result = await pending;
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, "access_denied");
});

test("a Page in Trash refuses the upload, as the byte route does", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  const listed = (await w.call("owner", "list_pages")).body;
  const trashed = await w.call("owner", "delete_page", {
    page_id: pageId,
    retry_token: listed.retry_token,
    idempotency_key: listed.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const refused = await upload(w, grant);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_trashed");
  assert.equal((await issue(w, "owner", { page_id: pageId })).body.code, "page_trashed");
  // The bearer byte route answers the same.
  const direct = await worker.fetch(
    new Request(grant.upload_url, {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}`, "content-type": "image/png" },
      body: png,
    }),
    w.env,
  );
  assert.equal(direct.status, 409);
  assert.equal(bucket.calls.length, 0);
});

test("upload limits and validation are the byte route's", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  for (const [options, status, code] of [
    [{ body: new Uint8Array(IMAGE_MAX_BYTES + 1) }, 413, "request_too_large"],
    [{ headers: { "content-length": String(IMAGE_MAX_BYTES + 1) } }, 413, "request_too_large"],
    [{ body: new TextEncoder().encode("<svg>not a raster</svg>") }, 415, "unsupported_media_type"],
    [{ headers: { "Content-Type": "image/jpeg" } }, 415, "unsupported_media_type"],
  ]) {
    const refused = await upload(w, grant, options);
    assert.equal(refused.status, status, JSON.stringify(options));
    assert.equal(refused.body.code, code);
    assert.equal(refused.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(puts(bucket), 0);
});

test("an upload capability authorizes nothing but its upload", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201);
  const fetches = globalThis.fetch.mock.callCount();
  const project = await w.createProject();
  for (const [label, request] of [
    [
      "GET an asset",
      uploadRequest(grant, { url: `${origin}${stored.body.asset_url}`, body: null }),
    ],
    [
      "HEAD an asset",
      uploadRequest(grant, {
        url: `${origin}${stored.body.asset_url}`,
        body: null,
        method: "HEAD",
      }),
    ],
    [
      "a Project's asset route",
      uploadRequest(grant, { url: `${origin}/api/projects/${project.project_id}/assets` }),
    ],
  ]) {
    const response = await worker.fetch(request, w.env);
    assert.equal(response.status, 401, label);
    if (request.method !== "HEAD")
      assert.equal((await response.json()).code, "upload_capability_invalid", label);
  }
  for (const path of ["/api/tools", "/mcp", `/api/access?page=${pageId}`, "/whoami"]) {
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method: path === "/whoami" || path.startsWith("/api/access") ? "GET" : "POST",
        headers: {
          authorization: grant.headers.Authorization,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        ...(path === "/api/tools" && {
          body: JSON.stringify({ operation: "read_page", arguments: { page_id: pageId } }),
        }),
        ...(path === "/mcp" && {
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      }),
      w.env,
    );
    assert.equal(response.status, 401, path);
  }
  // Sent as a bearer credential by mistake, it is refused locally too.
  for (const [url, body] of [
    [grant.upload_url, png],
    [`${origin}/api/tools`, JSON.stringify({ operation: "list_pages", arguments: {} })],
  ]) {
    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenOf(grant)}`, "content-type": "image/png" },
        body,
      }),
      w.env,
    );
    assert.equal(response.status, 401, url);
    assert.equal((await response.json()).code, "upload_capability_invalid", url);
  }
  // None of those reached the API-key verifier with the capability.
  assert.equal(globalThis.fetch.mock.callCount(), fetches);
  assert.equal(puts(bucket), 1);
});

test("a Project's content takes project_id, over the JSON API and MCP", async (t) => {
  const { w } = await setup(t);
  const project = await w.createProject();
  const grant = await issued(w, { project_id: project.project_id });
  assert.equal(grant.page_id, project.document_id);
  assert.equal(grant.project_id, project.project_id);
  assert.equal(grant.upload_url, `${origin}/api/pages/${project.document_id}/assets`);
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.ok(
    w.env.PAGES_ASSETS.objects.has(imageAssetKey(project.document_id, stored.body.asset_id)),
  );
  const mcp = await w.mcp("owner", "create_page_asset_upload", { project_id: project.project_id });
  assert.equal(mcp.isError, false, JSON.stringify(mcp.body));
  assert.equal(mcp.body.upload_url, grant.upload_url);
  assert.equal(mcp.body.project_id, project.project_id);
  // A read-only key is refused before the Project is looked up.
  assert.equal((await issue(w, "reader", { project_id: project.project_id })).status, 403);
});

test("the llms.txt image workflow: upload light and dark, interleave with text, verify", async (t) => {
  const { w, pageId } = await setup(t);
  // The fixture's Page hosts stub native sync; give this one mutable handles
  // as project-content.test.mjs does, so edit_page can write.
  const page = w.page(pageId);
  let doc = page.handle.doc();
  let comments = newCommentsDoc();
  page.handle = { doc: () => doc, update: async (fn) => void (doc = fn(doc)), broadcast() {} };
  page.commentsHandle = {
    doc: () => comments,
    update: async (fn) => void (comments = fn(comments)),
    broadcast() {},
  };
  page.backend = undefined;
  page.admission = undefined;
  page.flush = () => page.ctx.storage.sync();
  const grant = await issued(w, { page_id: pageId });
  const light = (await upload(w, grant)).body.asset_id;
  const dark = (await upload(w, grant, { body: webp })).body.asset_id;
  const read = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
  const [first] = read.blocks;
  // The guide's batch: rewrite the first block, then append in order.
  const edit = await w.call("owner", "edit_page", {
    page_id: pageId,
    base_heads: read.heads,
    retry_token: read.retry_token,
    idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
    operations: [
      { op: "replace_block_markdown", block_id: first.id, markdown: "Intro paragraph." },
      { op: "insert_image", asset_id: light, dark_asset_id: dark, alt: "Home screen" },
      { op: "insert_markdown", markdown: "Between the images." },
      { op: "insert_image", asset_id: dark, alt: "Settings screen" },
      { op: "insert_markdown", markdown: "Closing paragraph." },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const after = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
  assert.ok(after.schema_features.includes("image-theme-variants"));
  // summary.images rides on each outline entry, in block order.
  const imagesIn = (body, block) =>
    body.outline.entries
      .filter((entry) => entry.block_id === block.id)
      .flatMap((entry) => entry.summary?.images ?? []);
  const order = after.blocks.map((block) => {
    const images = imagesIn(after, block);
    return images.length
      ? images.map(({ asset_id, dark_asset_id, alt }) => ({ asset_id, dark_asset_id, alt }))
      : block.markdown.trim();
  });
  assert.deepEqual(order, [
    "Intro paragraph.",
    [{ asset_id: light, dark_asset_id: dark, alt: "Home screen" }],
    "Between the images.",
    [{ asset_id: dark, dark_asset_id: undefined, alt: "Settings screen" }],
    "Closing paragraph.",
  ]);
  // Mid-Page, every operation names the same preceding block, so list them
  // in reverse: each lands directly after it, ahead of the one before.
  const anchor = after.blocks[0].id;
  const middle = await w.call("owner", "edit_page", {
    page_id: pageId,
    base_heads: after.heads,
    retry_token: after.retry_token,
    idempotency_key: after.retry_key_prefix + crypto.randomUUID(),
    operations: [
      { op: "insert_markdown", markdown: "Second inserted.", after_block_id: anchor },
      { op: "insert_image", asset_id: light, alt: "First inserted", after_block_id: anchor },
    ],
  });
  assert.equal(middle.status, 200, JSON.stringify(middle.body));
  const final = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
  assert.deepEqual(
    final.blocks
      .slice(0, 4)
      .map((block) => (imagesIn(final, block).length ? "image" : block.markdown.trim())),
    ["Intro paragraph.", "image", "Second inserted.", "image"],
  );
});

test("an OAuth MCP client uploads with a capability; revoking the grant ends it", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const clientId = "https://chatgpt.com/oauth/client.json";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "v".repeat(43);
  const { code } = await issueAuthorizationCode(w.env, {
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    scope: "pages:read pages:write offline_access",
    codeChallenge: await secretHash(verifier),
    identity: { principal: w.owner, namespace: "user:anaconda-fixture", displayName: "Fixture" },
  });
  const tokens = await exchangeAuthorizationCode(w.env, {
    code,
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    codeVerifier: verifier,
  });
  const fetches = globalThis.fetch.mock.callCount();
  const response = await worker.fetch(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_page_asset_upload", arguments: { page_id: pageId } },
      }),
    }),
    w.env,
  );
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.equal(result.isError, undefined, result.content[0].text);
  const grant = result.structuredContent;
  assert.equal(grant.url, `${origin}/p/${pageId}`);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(tokens.access_token));
  // The OAuth token itself still can't use the HTTP asset route.
  const direct = await worker.fetch(
    new Request(grant.upload_url, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "image/png" },
      body: png,
    }),
    w.env,
  );
  assert.equal(direct.status, 403);
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  // Pages OAuth never calls the API-key provider.
  assert.equal(globalThis.fetch.mock.callCount(), fetches);
  await revokeOAuthToken(w.env, { token: tokens.access_token, clientId });
  const revoked = await upload(w, grant, { body: webp });
  assert.equal(revoked.status, 401, JSON.stringify(revoked.body));
  assert.equal(revoked.body.code, "upload_capability_invalid");
  assert.equal(puts(bucket), 1);
});
