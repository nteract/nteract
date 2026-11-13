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
 * issue and expiry times, the issuer's company domain lease when it held one,
 * and optionally the file's content type and size.
 * The upload request carries it as `Authorization: Pages-Upload
 * <token>`. The gateway never passes that header to authenticate(), so it is
 * not sent to the API-key verifier or read as an OAuth token anywhere.
 *
 * The upload asks the Page host twice, before and after the transfer, and
 * the host checks the capability in two stages each time. Before the request
 * may join the host's queue, `uploadScreen`
 * checks the signature, payload and expiry, so a forged, foreign or expired
 * token never waits behind real work or boots the document. In the queue,
 * `verifyAssetUpload` repeats that and checks an OAuth grant is still live,
 * and the host decides access for the named principal from its current
 * record, so a grant removed after issue refuses the upload. Everything else
 * about the upload (limits, validation, storage, response) is the byte
 * route's own code in image-assets.mjs.
 *
 * Browser sessions don't issue capabilities: the browser uploads to the same
 * route with its own cookie. An API key's revocation isn't seen here (the
 * host never holds the key), so its capabilities end at their expiry, at most
 * ten minutes; removing the principal's Page access or revoking an OAuth
 * connection ends them at once. A caller that edits only through a link
 * audience lease gets a capability that expires with that lease.
 *
 * A capability holds no server state, so it has no lifecycle beyond its
 * expiry. uploadVerdict is the pure decision on a verified payload.
 */
import { audienceEditUntil } from "./access.mjs";
import { HttpError, withDomainAccess } from "./auth.mjs";
import { openCapability, signCapability } from "./operation-journal.mjs";
import { ASSET_UPLOAD_SCHEME, assetUploadCommand } from "../agent-client-setup.mjs";
import { IMAGE_MAX_BYTES, IMAGE_MEDIA_TYPES } from "../shared/image-assets.mjs";
import { DATASET_MAX_BYTES, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

export const ASSET_UPLOAD_OPERATION = "create_page_asset_upload";
/** How long an upload URL works. Ten minutes, like a purge preview and an
 * OAuth access token. */
export const ASSET_UPLOAD_TTL_MS = 10 * 60 * 1000;
export { ASSET_UPLOAD_SCHEME };
/** The Page host route that authorizes asset access, and the only one that
 * reads an upload capability. */
export const ASSET_AUTHORIZE_PATH = "/internal/assets/authorize";
export const ASSET_UPLOAD_TYPES = Object.freeze([...IMAGE_MEDIA_TYPES, PARQUET_MEDIA_TYPE]);
export const ASSET_UPLOAD_MAX_BYTES = Math.max(IMAGE_MAX_BYTES, DATASET_MAX_BYTES);
/** The credential kind of an identity a capability stands for. */
export const UPLOAD_CREDENTIAL = "upload-capability";
// The MAC purpose and token prefix. A retry token can't verify under them.
const PURPOSE = "pages-asset-upload-v1";
const PREFIX = "pu1";
/** Credentials that can issue a capability. A browser session uploads with
 * its own cookie, and a capability can't issue another. */
const ISSUING_KINDS = new Set(["api-key", "oauth", "kilo-token"]);
const ARGUMENTS = new Set(["page_id", "content_type", "size"]);
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  [PARQUET_MEDIA_TYPE]: "parquet",
};

const invalidArguments = (message) => new HttpError(400, message, "invalid_arguments");

/** The optional content type and size an upload must match. */
export function uploadBinding(args, pageId) {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    args.page_id !== pageId ||
    Object.keys(args).some((key) => !ARGUMENTS.has(key))
  )
    throw invalidArguments(
      `${ASSET_UPLOAD_OPERATION} takes page_id (or project_id) and optional content_type and size`,
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
  return binding;
}

/**
 * The decision on a payload this Page signed: `valid`, `expired`, or
 * `invalid` (malformed, or for another Page). Pure: the signature, the
 * OAuth grant and Page access are checked around it.
 */
export function uploadVerdict(claims, { pageId, now }) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return "invalid";
  const { page, principal, namespace, kind, grant, iat, exp, domain, domain_exp } = claims;
  if (
    typeof pageId !== "string" ||
    page !== pageId ||
    typeof principal !== "string" ||
    !principal ||
    principal.length > 1024 ||
    (namespace !== undefined && (typeof namespace !== "string" || namespace.length > 512)) ||
    (domain !== undefined &&
      (namespace === undefined ||
        typeof domain !== "string" ||
        domain.length > 253 ||
        !Number.isSafeInteger(domain_exp) ||
        domain_exp > exp)) ||
    (domain === undefined && domain_exp !== undefined) ||
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
      `An upload capability only authorizes a POST of file bytes to the upload_url ${ASSET_UPLOAD_OPERATION} returned. Use your own Pages credential for anything else, such as reading assets.`,
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

/** The upload capability a request to a Page host carries, or undefined.
 * Only the asset authorization route reads one. */
export function hostUploadCapability(request) {
  return new URL(request.url).pathname === ASSET_AUTHORIZE_PATH
    ? uploadCapabilityToken(request)
    : undefined;
}

/** The payload of `token` if this Page's key signed it as an upload
 * capability, else null (operation-journal.mjs openCapability). */
export const openUploadCapability = (storage, token) =>
  openCapability(storage, token, { purpose: PURPOSE, prefix: PREFIX });

/**
 * The Page host's screen before a capability request may join its queue:
 * null to queue it, or the refusal to send at once. Pure; the caller opens
 * the token with this Page's key first. It needs no document, so a forged,
 * foreign or expired token never waits behind real work or boots one. A
 * missing Page has no key and no page ID, so it refuses exactly as a forged
 * token does. The OAuth grant and Page access are decided in the queue.
 */
export function uploadScreen(claims, { pageId, now }) {
  const verdict = uploadVerdict(claims, { pageId, now });
  return verdict === "valid" ? null : uploadRefusal(verdict);
}

/**
 * Sign an upload capability for `identity` on `pageId`. The caller has
 * checked write scope and current edit access. An OAuth capability names its
 * grant, checked again at upload. Returns the tool result.
 *
 * `accessUntil(claims)` answers when the edit access the capability's own
 * identity would hold ends without renewal: the end of the link audience
 * lease (company domain or organization) it edits through, or Infinity when
 * it edits without one. The capability expires then if that is sooner, so
 * `expires_at` is the deadline the upload actually has.
 */
export async function issueAssetUpload(
  storage,
  { pageId, identity, args, origin, now = Date.now(), accessUntil = async () => Infinity },
) {
  const binding = uploadBinding(args, pageId);
  const kind = identity?.credentialKind;
  if (kind === "oidc")
    throw new HttpError(
      403,
      "Browser sessions upload directly: use Insert image, or POST the file to the Page's asset route with your session. Upload URLs are for API-key and OAuth clients.",
      "access_denied",
    );
  if (!ISSUING_KINDS.has(kind))
    throw new HttpError(403, "This credential can't issue upload URLs", "access_denied");
  if (kind === "oauth" && (typeof identity.grantId !== "string" || !identity.grantId))
    throw Error("An OAuth identity is missing its grant");
  // A Kilo agent token's capability ends with the token's lease, so it can't
  // outlast the check Kilo made of the token.
  const lifetime =
    kind === "kilo-token"
      ? Math.min(now + ASSET_UPLOAD_TTL_MS, identity.expiresAt)
      : now + ASSET_UPLOAD_TTL_MS;
  const namespace = typeof identity.namespace === "string" ? identity.namespace : undefined;
  // The issuer's company domain lease, which no store holds: its evidence is
  // the issuer's credential. It ends when the lease does, never later.
  const domain =
    namespace !== undefined &&
    identity.domainAccess?.namespace === namespace &&
    typeof identity.domainAccess.domain === "string" &&
    Number.isSafeInteger(identity.domainAccess.expiresAt)
      ? identity.domainAccess
      : null;
  const claimsUntil = (exp) => ({
    page: pageId,
    principal: identity.principal,
    // The principal's namespace, so the upload's identity can hold the
    // organization leases its evidence supports, as the issuer's did.
    ...(namespace !== undefined && { namespace }),
    ...(domain && { domain: domain.domain, domain_exp: Math.min(domain.expiresAt, exp) }),
    kind,
    ...(kind === "oauth" && { grant: identity.grantId }),
    iat: now,
    exp,
    ...binding,
  });
  const expiresAt = Math.min(lifetime, await accessUntil(claimsUntil(lifetime)));
  if (!(expiresAt > now)) throw new HttpError(403, "Page is read-only", "access_denied");
  const token = await signCapability(storage, {
    purpose: PURPOSE,
    prefix: PREFIX,
    payload: claimsUntil(expiresAt),
  });
  const uploadUrl = `${origin}/api/pages/${pageId}/assets`;
  const contentType = binding.content_type ?? "application/octet-stream";
  const file = `path/to/file${binding.content_type ? `.${EXTENSIONS[binding.content_type]}` : ""}`;
  return {
    page_id: pageId,
    upload_url: uploadUrl,
    method: "POST",
    headers: { Authorization: `${ASSET_UPLOAD_SCHEME} ${token}`, "Content-Type": contentType },
    expires_at: new Date(expiresAt).toISOString(),
    max_bytes: binding.size ?? ASSET_UPLOAD_MAX_BYTES,
    accepted_types: ASSET_UPLOAD_TYPES,
    ...(Object.keys(binding).length && { bound: binding }),
    example: assetUploadCommand({ file, contentType, token, uploadUrl }),
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
  const claims = await openUploadCapability(storage, token);
  const refusal = uploadScreen(claims, { pageId, now });
  if (refusal) throw refusal;
  if (claims.kind === "oauth" && !(await grantActive(claims.grant))) throw uploadRefusal("invalid");
  return claims;
}

/** The identity a verified capability stands for: its principal (and its
 * namespace, when the capability names one) with write scope until the
 * capability expires, and the binding the upload must match. A capability
 * that names a company domain carries it as `domainEvidence`, which
 * domain-access.mjs turns into a lease while the deployment still allows the
 * domain. It decides nothing itself; the Page's record decides access. */
export function uploadIdentity(claims) {
  return Object.freeze({
    principal: claims.principal,
    ...(claims.namespace !== undefined && { namespace: claims.namespace }),
    ...(claims.domain !== undefined && {
      domainEvidence: Object.freeze({ domain: claims.domain, expiresAt: claims.domain_exp }),
    }),
    displayName: claims.principal,
    accountDisplayName: null,
    driver: "API",
    canWrite: true,
    credentialKind: UPLOAD_CREDENTIAL,
    expiresAt: claims.exp,
    upload: Object.freeze(storedBinding(claims)),
  });
}

/** `issueAssetUpload`'s `accessUntil` for a Page host: when the edit access of
 * the identity `claims` would stand for ends on the record `metadata`, with
 * its leases derived as the upload will derive them (`audienceEditUntil`), or
 * 0 when it can't edit. */
export async function uploaderEditUntil(metadata, claims, env, now = Date.now()) {
  const uploader = await withDomainAccess(uploadIdentity(claims), env);
  return audienceEditUntil(metadata, uploader, { now }) ?? 0;
}
