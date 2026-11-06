/**
 * Short-lived, Page-scoped upload capabilities (create_page_asset_upload).
 *
 * An agent with a shell or HTTP client asks its MCP or JSON API connection
 * for an upload URL, then POSTs file bytes there with curl. The bytes never
 * pass through the model, and the agent never handles its own API key or
 * OAuth token: the capability stands in for it on one route only.
 *
 * The Page host issues the capability after the same checks as an upload
 * (write scope and current edit access) and signs it with its retry key
 * under a distinct purpose (operation-journal.mjs signCapability). It names
 * the Page, the principal, the credential kind (and an OAuth grant), its
 * issue and expiry times, and optionally the file's content type, size and
 * SHA-256. The upload request carries it as `Authorization: Pages-Upload
 * <token>`. The gateway never passes that header to authenticate(), so it is
 * not sent to the API-key verifier or read as an OAuth token anywhere. The
 * Page host verifies it on each of the upload's two authorization checks,
 * then decides access for the named principal from its current record, so a
 * grant removed after issue refuses the upload. Everything else about the
 * upload (limits, validation, storage, response) is the byte route's own
 * code in image-assets.mjs.
 *
 * A capability holds no server state, so it has no lifecycle beyond its
 * expiry. uploadVerdict is the pure decision on a verified payload.
 */
import { HttpError } from "./auth.mjs";
import { openCapability, signCapability } from "./operation-journal.mjs";
import { IMAGE_MAX_BYTES, IMAGE_MEDIA_TYPES } from "../shared/image-assets.mjs";
import { DATASET_MAX_BYTES, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

export const ASSET_UPLOAD_OPERATION = "create_page_asset_upload";
/** How long an upload URL works. Ten minutes, like a purge preview and an
 * OAuth access token. */
export const ASSET_UPLOAD_TTL_MS = 10 * 60 * 1000;
export const ASSET_UPLOAD_SCHEME = "Pages-Upload";
export const ASSET_UPLOAD_TYPES = Object.freeze([...IMAGE_MEDIA_TYPES, PARQUET_MEDIA_TYPE]);
export const ASSET_UPLOAD_MAX_BYTES = Math.max(IMAGE_MAX_BYTES, DATASET_MAX_BYTES);
/** The credential kind of an identity a capability stands for. */
export const UPLOAD_CREDENTIAL = "upload-capability";
// The MAC purpose and token prefix. A retry token can't verify under them.
const PURPOSE = "pages-asset-upload-v1";
const PREFIX = "pu1";
/** Credentials that can issue a capability. A capability can't issue another. */
const ISSUING_KINDS = new Set(["api-key", "oauth", "oidc"]);
const ARGUMENTS = new Set(["page_id", "content_type", "size", "sha256"]);
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  [PARQUET_MEDIA_TYPE]: "parquet",
};

const invalidArguments = (message) => new HttpError(400, message, "invalid_arguments");

/** The optional content type, size and SHA-256 an upload must match. */
export function uploadBinding(args, pageId) {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    args.page_id !== pageId ||
    Object.keys(args).some((key) => !ARGUMENTS.has(key))
  )
    throw invalidArguments(
      `${ASSET_UPLOAD_OPERATION} takes page_id (or project_id) and optional content_type, size and sha256`,
    );
  const binding = {};
  if (args.content_type !== undefined) {
    const type =
      typeof args.content_type === "string" ? args.content_type.trim().toLowerCase() : null;
    if (!ASSET_UPLOAD_TYPES.includes(type))
      throw invalidArguments(`content_type is one of ${ASSET_UPLOAD_TYPES.join(", ")}`);
    binding.content_type = type;
  }
  if (args.size !== undefined) {
    if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > ASSET_UPLOAD_MAX_BYTES)
      throw invalidArguments(`size is the file's byte count, 1 to ${ASSET_UPLOAD_MAX_BYTES}`);
    binding.size = args.size;
  }
  if (args.sha256 !== undefined) {
    if (typeof args.sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(args.sha256))
      throw invalidArguments("sha256 is the file's SHA-256 digest as 64 hex characters");
    binding.sha256 = args.sha256.toLowerCase();
  }
  return binding;
}

/** A payload's binding fields, or null when one of them is malformed. */
function storedBinding(claims) {
  const binding = {};
  if (claims.content_type !== undefined) {
    if (!ASSET_UPLOAD_TYPES.includes(claims.content_type)) return null;
    binding.content_type = claims.content_type;
  }
  if (claims.size !== undefined) {
    if (!Number.isSafeInteger(claims.size) || claims.size < 1) return null;
    binding.size = claims.size;
  }
  if (claims.sha256 !== undefined) {
    if (typeof claims.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(claims.sha256)) return null;
    binding.sha256 = claims.sha256;
  }
  return binding;
}

/**
 * The decision on a payload this Page signed: `valid`, `expired`, or
 * `invalid` (malformed, or for another Page). Pure: the signature, the
 * OAuth grant and Page access are checked around it.
 */
export function uploadVerdict(claims, { pageId, now }) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return "invalid";
  const { page, principal, kind, grant, iat, exp } = claims;
  if (
    typeof pageId !== "string" ||
    page !== pageId ||
    typeof principal !== "string" ||
    !principal ||
    principal.length > 1024 ||
    !ISSUING_KINDS.has(kind) ||
    (kind === "oauth") !== (typeof grant === "string" && grant.length > 0) ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    exp <= iat ||
    exp - iat > ASSET_UPLOAD_TTL_MS ||
    storedBinding(claims) === null
  )
    return "invalid";
  return now < exp ? "valid" : "expired";
}

/** The refusal for a capability that can't authorize this upload. Anyone
 * without a valid capability gets `upload_capability_invalid`, whether the
 * Page exists, is in Trash or never existed: verification needs the Page's
 * own key, so a forged token and a missing Page look the same. */
export function uploadRefusal(verdict) {
  if (verdict === "expired")
    return new HttpError(
      401,
      `This upload URL has expired. Call ${ASSET_UPLOAD_OPERATION} for a new one.`,
      "upload_capability_expired",
    );
  if (verdict === "misused")
    return new HttpError(
      401,
      "An upload capability only authorizes a POST of file bytes to its upload_url. Use your Pages credential for anything else.",
      "upload_capability_invalid",
    );
  return new HttpError(
    401,
    `This upload URL isn't valid. Call ${ASSET_UPLOAD_OPERATION} for a new one.`,
    "upload_capability_invalid",
  );
}

/** The token of an `Authorization: Pages-Upload <token>` header, or
 * undefined when the request doesn't use that scheme. A malformed value is
 * "" so it is refused, never read as another kind of credential. */
export function uploadCapabilityToken(request) {
  const header = request.headers.get("authorization");
  if (header === null || !/^Pages-Upload(\s|$)/i.test(header)) return undefined;
  const token = header.slice(ASSET_UPLOAD_SCHEME.length).trim();
  return /^\S+$/.test(token) ? token : "";
}

/**
 * Sign an upload capability for `identity` on `pageId`. The caller has
 * checked write scope and current edit access. An OAuth capability names its
 * grant, checked again at upload; a browser session's never outlives the
 * session. Returns the tool result.
 */
export async function issueAssetUpload(
  storage,
  { pageId, identity, args, origin, now = Date.now() },
) {
  const binding = uploadBinding(args, pageId);
  const kind = identity?.credentialKind;
  if (!ISSUING_KINDS.has(kind))
    throw new HttpError(403, "This credential can't issue upload URLs", "access_denied");
  if (kind === "oauth" && (typeof identity.grantId !== "string" || !identity.grantId))
    throw Error("An OAuth identity is missing its grant");
  const expiresAt =
    kind === "oidc"
      ? Math.min(now + ASSET_UPLOAD_TTL_MS, identity.expiresAt)
      : now + ASSET_UPLOAD_TTL_MS;
  if (!(Number.isSafeInteger(expiresAt) && expiresAt > now))
    throw new HttpError(401, "Sign in again to upload", "auth_required");
  const token = await signCapability(storage, {
    purpose: PURPOSE,
    prefix: PREFIX,
    payload: {
      page: pageId,
      principal: identity.principal,
      kind,
      ...(kind === "oauth" && { grant: identity.grantId }),
      iat: now,
      exp: expiresAt,
      ...binding,
    },
  });
  const uploadUrl = `${origin}/api/pages/${pageId}/assets`;
  const contentType = binding.content_type ?? "application/octet-stream";
  const authorization = `${ASSET_UPLOAD_SCHEME} ${token}`;
  const file = `path/to/file${binding.content_type ? `.${EXTENSIONS[binding.content_type]}` : ""}`;
  return {
    page_id: pageId,
    upload_url: uploadUrl,
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": contentType },
    expires_at: new Date(expiresAt).toISOString(),
    max_bytes: binding.size ?? ASSET_UPLOAD_MAX_BYTES,
    accepted_types: ASSET_UPLOAD_TYPES,
    ...(Object.keys(binding).length && { bound: binding }),
    example: `curl -sS --data-binary @${file} -H 'Content-Type: ${contentType}' -H '${authorization}' '${uploadUrl}'`,
    next: "Send the raw file bytes as the body, not multipart or base64. The answer is JSON with asset_id, asset_url, mime_type and size, plus width and height for an image; the same bytes always return the same asset_id. Place an image with edit_page insert_image and a dataset with insert_node. The URL works for several files until expires_at; keep it out of Pages content and comments.",
  };
}

/**
 * The payload of a valid capability for this Page, or the refusal. Checks
 * the signature with this Page's key, the payload, expiry, and for an OAuth
 * capability that its grant is still live (`grantActive`), so revoking a
 * connection also ends the uploads it started. Page access is decided after
 * this, from the host's current record.
 */
export async function verifyAssetUpload(storage, token, { pageId, now = Date.now(), grantActive }) {
  const claims = await openCapability(storage, token, { purpose: PURPOSE, prefix: PREFIX });
  const verdict = uploadVerdict(claims, { pageId, now });
  if (verdict !== "valid") throw uploadRefusal(verdict);
  if (claims.kind === "oauth" && !(await grantActive(claims.grant))) throw uploadRefusal("invalid");
  return claims;
}

/** The identity a verified capability stands for: its principal with write
 * scope until the capability expires, and the binding the upload must match.
 * It decides nothing itself; the Page's record decides access. */
export function uploadIdentity(claims) {
  return Object.freeze({
    principal: claims.principal,
    displayName: claims.principal,
    accountDisplayName: null,
    driver: "API",
    canWrite: true,
    credentialKind: UPLOAD_CREDENTIAL,
    expiresAt: claims.exp,
    upload: Object.freeze(storedBinding(claims)),
  });
}
