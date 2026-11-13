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
import { openCapability, signCapability } from "./operation-journal.mjs";
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

/** Split a command line as a POSIX shell does: whitespace separates words,
 * single quotes keep everything literally, double quotes keep all but
 * backslash escapes of \ " $ and `, and a backslash outside quotes escapes
 * the next character. Enough for the commands Pages prints. */
function shellWords(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      assert.notEqual(end, -1, "unterminated single quote");
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; line[i] !== '"'; i++) {
        assert.ok(i < line.length, "unterminated double quote");
        if (line[i] === "\\" && '\\"$`'.includes(line[i + 1])) i++;
        word += line[i];
      }
    } else if (c === "\\") word = (word ?? "") + line[++i];
    else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/** The request curl sends for `command`, reading --data-binary @file from
 * `files`. Like curl, an -H value without a colon is dropped silently, and
 * --data-binary without a Content-Type header sends a form type. */
function curlRequest(command, files) {
  const [program, ...args] = shellWords(command);
  assert.equal(program, "curl");
  const headers = new Headers();
  let body, url;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["-s", "-S", "-sS"].includes(arg)) continue;
    if (arg === "-H" || arg === "--header") {
      const value = args[++i];
      const colon = value.indexOf(":");
      if (colon === -1) continue;
      headers.set(value.slice(0, colon).trim(), value.slice(colon + 1).trim());
    } else if (arg === "--data-binary") {
      const value = args[++i];
      assert.ok(value.startsWith("@"), "the example reads a file");
      body = files[value.slice(1)];
      assert.ok(body, `no fixture file for ${value}`);
    } else if (arg.startsWith("-")) assert.fail(`unexpected curl option ${arg}`);
    else {
      assert.equal(url, undefined, "one URL");
      url = arg;
    }
  }
  if (body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/x-www-form-urlencoded");
  return new Request(url, { method: body === undefined ? "GET" : "POST", headers, body });
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
    // A browser session never issues one, so its payload is not a capability.
    [{ ...valid, kind: "oidc" }, now, "invalid"],
    [{ ...valid, content_type: "image/png", size: 10 }, now, "valid"],
    // A claim this build does not bind, such as a digest, is not checked.
    [{ ...valid, sha256: "a".repeat(64) }, now, "valid"],
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
    uploadBinding({ page_id: pageId, content_type: " Image/PNG ", size: 12 }, pageId),
    { content_type: "image/png", size: 12 },
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
    // The asset id is the digest of the bytes; a caller does not supply one.
    { page_id: pageId, sha256: "a".repeat(64) },
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

test("a capability verifies only for its own purpose and its own Page's key", async () => {
  const storage = new Storage();
  const pageId = crypto.randomUUID();
  const principal = "user:anaconda:person";
  const identity = { principal, credentialKind: "api-key" };
  const grant = await issueAssetUpload(storage, {
    pageId,
    identity,
    args: { page_id: pageId },
    origin,
  });
  const capability = tokenOf(grant);
  const [, capabilityPayload, capabilitySignature] = capability.split(".");
  const verify = (token) =>
    verifyAssetUpload(storage, token, { pageId, grantActive: () => assert.fail("not OAuth") });
  assert.equal((await verify(capability)).principal, principal);
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
  await signCapability(elsewhere, { purpose: "pages-something-else", prefix: "pu1", payload: {} });
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

test("an OAuth capability names its grant; a browser session is told to upload directly", async () => {
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
  await assert.rejects(
    issueAssetUpload(storage, {
      pageId,
      identity: { principal: "p", credentialKind: "oidc", expiresAt: now + 60_000 },
      args: { page_id: pageId },
      origin,
      now,
    }),
    { status: 403, code: "access_denied", message: /^Browser sessions upload directly/ },
  );
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

test("a Kilo agent token's capability ends no later than the token's lease", async () => {
  const storage = new Storage();
  const pageId = crypto.randomUUID();
  const now = 1_800_000_000_000;
  for (const [leaseMs, lifeMs] of [
    [60_000, 60_000],
    [15 * 60_000, ASSET_UPLOAD_TTL_MS],
  ]) {
    const issued = await issueAssetUpload(storage, {
      pageId,
      identity: { principal: "p", credentialKind: "kilo-token", expiresAt: now + leaseMs },
      args: { page_id: pageId },
      origin,
      now,
    });
    assert.equal(issued.expires_at, new Date(now + lifeMs).toISOString());
    await assert.rejects(
      verifyAssetUpload(storage, tokenOf(issued), {
        pageId,
        now: now + lifeMs,
        grantActive: () => assert.fail("a Kilo capability names no grant"),
      }),
      { code: "upload_capability_expired" },
    );
  }
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
    `curl -sS --data-binary @path/to/file -H 'Content-Type: application/octet-stream' -H 'Authorization: ${grant.headers.Authorization}' '${grant.upload_url}'`,
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
    insert: { op: "insert_image", asset_id: await sha256(png) },
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

test("a bound content type and size refuse any other file before storage", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId, content_type: "image/png", size: png.length });
  assert.deepEqual(grant.bound, { content_type: "image/png", size: png.length });
  assert.equal(grant.headers["Content-Type"], "image/png");
  assert.equal(grant.max_bytes, png.length);
  assert.match(grant.example, /--data-binary @path\/to\/file\.png -H 'Content-Type: image\/png'/);
  const mismatched = await upload(w, grant, {
    body: webp,
    headers: { "Content-Type": "image/webp" },
  });
  assert.equal(mismatched.status, 400, JSON.stringify(mismatched.body));
  assert.equal(mismatched.body.code, "upload_mismatch");
  for (const args of [{ size: png.length + 1 }, { content_type: PARQUET_MEDIA_TYPE }]) {
    const other = await issued(w, { page_id: pageId, ...args });
    const refused = await upload(w, other, { headers: { "Content-Type": "image/png" } });
    assert.equal(refused.status, 400, JSON.stringify(args));
    assert.equal(refused.body.code, "upload_mismatch", JSON.stringify(args));
  }
  assert.equal(puts(bucket), 0);
  assert.equal(bucket.objects.size, 0);
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.asset_id, await sha256(png));
  // A dataset upload binds the same way.
  const dataset = await issued(w, { page_id: pageId, content_type: PARQUET_MEDIA_TYPE });
  assert.match(dataset.example, /@path\/to\/file\.parquet/);
  // A file that is neither kind, sent to a Parquet upload, is told the
  // upload takes Parquet; an image there is upload_mismatch, above.
  const storedPuts = puts(bucket);
  const notParquet = await upload(w, dataset, {
    body: new TextEncoder().encode("date,count\n2026-11-12,3\n"),
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.equal(notParquet.status, 415, JSON.stringify(notParquet.body));
  assert.equal(
    notParquet.body.error,
    "This upload URL takes a Parquet file, and this file isn't one. Send a valid, unencrypted Parquet file.",
  );
  assert.equal(puts(bucket), storedPuts);
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

test("a revision or a nonce is not an upload capability", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const read = await w.call("owner", "read_page", { page_id: pageId, comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const grant = await issued(w, { page_id: pageId });
  for (const token of [read.body.revision, read.body.comment_revision, crypto.randomUUID()]) {
    const refused = await upload(w, withToken(grant, token));
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "upload_capability_invalid");
  }
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
      nonce: w.key(),
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
  const trashed = await w.call("owner", "delete_page", {
    page_id: pageId,
    nonce: crypto.randomUUID(),
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
    if (request.method !== "HEAD") {
      const body = await response.json();
      assert.equal(body.code, "upload_capability_invalid", label);
      // The advice fits both a misplaced upload and a read.
      assert.match(body.error, /upload_url create_page_asset_upload returned/, label);
    }
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

/** The fixture's Page hosts stub native sync; give this one mutable handles
 * as project-content.test.mjs does, so edit_page can write. */
function editable(w, pageId) {
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
}

test("an upload's insert operation places each file as the block its type calls for", async (t) => {
  const { w, pageId } = await setup(t);
  editable(w, pageId);
  const grant = await issued(w, { page_id: pageId });
  const image = (await upload(w, grant)).body;
  const table = (await upload(w, grant, { body: parquet })).body;
  assert.deepEqual(image.insert, { op: "insert_image", asset_id: image.asset_id });
  assert.deepEqual(table.insert, {
    op: "insert_node",
    node: { type: "dataframe", attrs: { asset_id: table.asset_id } },
  });
  const edit = async (operations) => {
    const read = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
    return w.call("owner", "edit_page", {
      page_id: pageId,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations,
    });
  };
  // Alt text is the caller's to write: sent bare, an image is refused.
  const bare = await edit([image.insert]);
  assert.equal(bare.status, 400, JSON.stringify(bare.body));
  assert.match(bare.body.error, /alt text/);
  const placed = await edit([{ ...image.insert, alt: "Mockup" }, table.insert]);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const [picture, dataframe] = placed.body.result.edits;
  assert.equal(picture.asset_id, image.asset_id);
  assert.equal(picture.alt, "Mockup");
  assert.equal(dataframe.type, "dataframe");
  assert.equal(dataframe.attrs.src, table.asset_url);
});

test("the llms.txt image workflow: upload light and dark, interleave with text, verify", async (t) => {
  const { w, pageId } = await setup(t);
  editable(w, pageId);
  const grant = await issued(w, { page_id: pageId });
  const light = (await upload(w, grant)).body.asset_id;
  const dark = (await upload(w, grant, { body: webp })).body.asset_id;
  const read = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
  const [first] = read.blocks;
  // The guide's batch: rewrite the first block, then append in order.
  const edit = await w.call("owner", "edit_page", {
    page_id: pageId,
    revision: read.revision,
    nonce: crypto.randomUUID(),
    operations: [
      { op: "replace_block_markdown", node_id: first.node_id, markdown: "Intro paragraph." },
      { op: "insert_image", asset_id: light, dark_asset_id: dark, alt: "Home screen" },
      { op: "insert_markdown", markdown: "Between the images." },
      { op: "insert_image", asset_id: dark, alt: "Settings screen" },
      { op: "insert_markdown", markdown: "Closing paragraph." },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const after = (await w.call("owner", "read_page", { page_id: pageId, comments: "none" })).body;
  assert.ok(after.schema_features.includes("image-theme-variants"));
  // summary.images rides on each outline entry, in block order. A block's
  // first entry names it; the entries after it belong to the same block.
  const imagesIn = (body, block) => {
    let current = null;
    return body.outline.entries
      .filter((entry) => (current = entry.block ?? current) === block.node_id)
      .flatMap((entry) => entry.summary?.images ?? []);
  };
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
  const anchor = after.blocks[0].node_id;
  const middle = await w.call("owner", "edit_page", {
    page_id: pageId,
    revision: after.revision,
    nonce: crypto.randomUUID(),
    operations: [
      { op: "insert_markdown", markdown: "Second inserted.", after_node_id: anchor },
      { op: "insert_image", asset_id: light, alt: "First inserted", after_node_id: anchor },
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

test("the returned curl example uploads exactly as curl sends it, unbound and bound", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const files = { "path/to/file": png, "path/to/file.webp": webp };
  const unbound = await issued(w, { page_id: pageId });
  const first = await worker.fetch(curlRequest(unbound.example, files), w.env);
  const firstBody = await first.json();
  assert.equal(first.status, 201, JSON.stringify(firstBody));
  assert.equal(firstBody.asset_id, await sha256(png));
  assert.equal(firstBody.mime_type, "image/png");
  const bound = await issued(w, { page_id: pageId, content_type: "image/webp" });
  const request = curlRequest(bound.example, files);
  assert.equal(request.headers.get("content-type"), "image/webp");
  const second = await worker.fetch(request, w.env);
  const secondBody = await second.json();
  assert.equal(second.status, 201, JSON.stringify(secondBody));
  assert.equal(secondBody.asset_id, await sha256(webp));
  // The parser drops a colonless header as curl does, so the first release's
  // example sent no credential at all. The asset route now says what to do.
  const lost = curlRequest(bound.example.replace("-H 'Authorization: ", "-H '"), files);
  assert.equal(lost.headers.get("authorization"), null);
  const refused = await worker.fetch(lost, w.env);
  const refusal = await refused.json();
  assert.equal(refused.status, 401);
  assert.equal(refusal.code, "auth_required");
  assert.match(refusal.error, /^Agents: call create_page_asset_upload for an upload URL/);
  assert.equal(puts(bucket), 2);
});

test("only a credential-less upload is pointed at create_page_asset_upload", async (t) => {
  const { w, pageId } = await setup(t);
  const send = async (method, path, init = {}) => {
    const response = await worker.fetch(
      new Request(`${origin}${path}`, { method, ...init }),
      w.env,
    );
    return { status: response.status, body: await response.json() };
  };
  const upload = await send("POST", `/api/pages/${pageId}/assets`, {
    headers: { "content-type": "image/png" },
    body: png,
  });
  assert.equal(upload.status, 401);
  assert.equal(upload.body.code, "auth_required");
  assert.match(upload.body.error, /^Agents: call create_page_asset_upload for an upload URL/);
  assert.match(upload.body.error, /Authorization: Bearer <Anaconda API key>/);
  for (const [method, path, init] of [
    ["POST", "/api/tools", { body: JSON.stringify({ operation: "list_pages", arguments: {} }) }],
    ["GET", `/api/pages/${pageId}/assets/${await sha256(png)}`, {}],
    [
      "POST",
      `/api/pages/${pageId}/assets`,
      { headers: { authorization: "Basic eA==" }, body: png },
    ],
    // A browser whose session cookie lapsed still sends Origin; the person
    // keeps the sign-in message, not advice meant for agents.
    [
      "POST",
      `/api/pages/${pageId}/assets`,
      { headers: { origin, "content-type": "image/png" }, body: png },
    ],
  ]) {
    const refused = await send(method, path, init);
    assert.equal(refused.status, 401, path);
    assert.doesNotMatch(refused.body.error, /create_page_asset_upload/, path);
  }
});

test("a forged, foreign or expired capability never reaches the Page queue or document", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const other = (await w.createPage({ title: "Other" })).body.page_id;
  const grant = await issued(w, { page_id: pageId });
  const foreign = await issued(w, { page_id: other });
  const page = w.page(pageId);
  const run = t.mock.method(page, "run");
  const documentReady = t.mock.method(page, "documentReady");
  const [prefix, payload] = tokenOf(grant).split(".");
  const now = Date.now();
  const refusals = [];
  for (const [label, target, at] of [
    ["forged", withToken(grant, `${prefix}.${payload}.${"A".repeat(43)}`)],
    ["another Page's", withToken(grant, tokenOf(foreign))],
    ["expired", grant, now + ASSET_UPLOAD_TTL_MS + 1],
  ]) {
    const clock = at && t.mock.method(Date, "now", () => at);
    const result = await upload(w, target);
    clock?.mock.restore();
    assert.equal(result.status, 401, label);
    assert.equal(run.mock.callCount(), 0, label);
    assert.equal(documentReady.mock.callCount(), 0, label);
    if (label === "expired") assert.equal(result.body.code, "upload_capability_expired");
    else refusals.push(JSON.stringify(result.body));
  }
  // A Page that doesn't exist answers with the same body, also unqueued.
  const missing = crypto.randomUUID();
  const absentUrl = `${origin}/api/pages/${missing}/assets`;
  refusals.push(JSON.stringify((await upload(w, { ...grant, upload_url: absentUrl })).body));
  const absentRun = t.mock.method(w.page(missing), "run");
  const again = await upload(w, { ...grant, upload_url: absentUrl });
  assert.equal(again.status, 401);
  refusals.push(JSON.stringify(again.body));
  assert.equal(absentRun.mock.callCount(), 0);
  assert.equal(new Set(refusals).size, 1, refusals.join("\n"));
  assert.equal(bucket.calls.length, 0);
  // A valid capability queues: both of the upload's checks run in the host.
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(run.mock.callCount(), 2);
  assert.equal(documentReady.mock.callCount(), 2);
});

test("revoking an API key doesn't end its upload URLs early; expires_at does", async (t) => {
  const { w, pageId } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  // From here the provider refuses every key, as after a revocation. The
  // capability never asks it: the Page host doesn't hold the key.
  const provider = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "API key revoked" }, { status: 401 }),
  );
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(provider.mock.callCount(), 0);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + ASSET_UPLOAD_TTL_MS + 1);
  const expired = await upload(w, grant, { body: webp });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "upload_capability_expired");
});

test("an upload capability is refused on sync, connect, card images and registration", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  const run = t.mock.method(w.page(pageId), "run");
  const fetches = globalThis.fetch.mock.callCount();
  for (const [method, path, init] of [
    ["GET", `/api/sync?page=${pageId}`, { headers: { upgrade: "websocket" } }],
    ["GET", `/api/connect?page=${pageId}`, {}],
    ["PUT", `/api/pages/${pageId}/card-image?hash=${"a".repeat(64)}&theme=light`, { body: webp }],
    ["POST", "/api/pages/register", { body: JSON.stringify({ page_id: crypto.randomUUID() }) }],
  ]) {
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        ...init,
        headers: { ...init.headers, authorization: grant.headers.Authorization },
      }),
      w.env,
    );
    assert.equal(response.status, 401, path);
  }
  assert.equal(run.mock.callCount(), 0);
  assert.equal(globalThis.fetch.mock.callCount(), fetches, "no provider lookup");
  assert.equal(bucket.calls.length, 0);
});

test("an editor through Project membership issues and uploads with a capability", async (t) => {
  const { w, bucket } = await setup(t);
  const project = await w.createProject("Mockups");
  const child = (await w.createPage({ title: "Screens", project_id: project.project_id })).body;
  assert.equal((await issue(w, "member", { page_id: child.page_id })).status, 403);
  const granted = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "editor",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const grant = await issued(w, { page_id: child.page_id }, "member");
  const stored = await upload(w, grant);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.ok(bucket.objects.has(imageAssetKey(child.page_id, stored.body.asset_id)));
  // Removing the membership ends the capability.
  const revoked = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: null,
    expected_revision: 1,
    nonce: w.key(),
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const refused = await upload(w, grant, { body: webp });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("a Page whose recovery is blocked refuses issue and upload", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId });
  // As operation-journal-integration.test.mjs does: the accepted content
  // stays readable, and no write is admitted.
  w.page(pageId).metadata.recoveryBlocked = { code: "history_capacity" };
  const issue409 = await issue(w, "owner", { page_id: pageId });
  assert.equal(issue409.status, 409, JSON.stringify(issue409.body));
  assert.equal(issue409.body.code, "page_recovery_blocked");
  const refused = await upload(w, grant);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_recovery_blocked");
  assert.equal(bucket.calls.length, 0);
});

test("a size-bound URL refuses another Content-Length before reading, and reads no further", async (t) => {
  const { w, pageId, bucket } = await setup(t);
  const grant = await issued(w, { page_id: pageId, size: png.length });
  let pulled = 0;
  // highWaterMark 0: a chunk is pulled only when the route reads.
  const stream = () =>
    new ReadableStream(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(png);
          if (pulled > 4) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  const declared = await upload(w, grant, {
    body: stream(),
    headers: { "content-length": String(png.length + 1) },
  });
  assert.equal(declared.status, 400, JSON.stringify(declared.body));
  assert.equal(declared.body.code, "upload_mismatch");
  assert.equal(pulled, 0, "nothing read");
  // Without Content-Length, the read stops at the bound.
  pulled = 0;
  const streamed = await upload(w, grant, { body: stream() });
  assert.equal(streamed.status, 400, JSON.stringify(streamed.body));
  assert.equal(streamed.body.code, "upload_mismatch");
  assert.ok(pulled <= 2, `read ${pulled} chunks of a ${png.length}-byte bound`);
  assert.equal(puts(bucket), 0);
  const stored = await upload(w, grant, { headers: { "content-length": String(png.length) } });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
});
