import * as A from "@automerge/automerge";
import { documentIdToBinary } from "@automerge/automerge-repo";
import { BLOCK_KEYS, validBlockFields } from "../model/block-shape.mjs";
import { assertDocumentLimits } from "../model/limits.mjs";
import { validateRich } from "../model/richtext-spans.mjs";
import { requireSupportedSchema } from "../model/schema-features.mjs";
import { commentsMigrated } from "../model/comments.mjs";
import { STORED_FORM_UNSUPPORTED, storedFormUnsupported } from "../model/stored-form.mjs";
import { HttpError } from "./auth.mjs";

export const validPageId = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
// A stored block holds exactly BLOCK_KEYS; its id is its key in `blocks`.
const map = (value) => value && typeof value === "object" && !Array.isArray(value);

/** Validate the immutable bootstrap, never a replacement for an existing Page.
 * Authorization and ownership are host metadata outside this document. A fresh
 * bootstrap has no comments; later edits arrive through native sync, and comments
 * through the Page's comments document.
 */
export function readRegistration(args) {
  requireRegistrationAccount(args);
  if (!map(args) || !validPageId(args.page_id)) throw new HttpError(400, "Invalid page_id");
  // Native 32-byte and legacy 16-byte base58check IDs fit in 50 characters. Bound decoding
  // before the base58 quadratic loop, and normalize malformed input to 400.
  if (typeof args.document_id !== "string" || !args.document_id || args.document_id.length > 50)
    throw new HttpError(400, "Invalid document_id");
  let nativeId;
  try {
    nativeId = documentIdToBinary(args.document_id);
  } catch {}
  if (!nativeId || ![16, 32].includes(nativeId.byteLength))
    throw new HttpError(400, "Invalid document_id");
  if (typeof args.title !== "string" || args.title.length > 500)
    throw new HttpError(400, "Invalid title");
  // The draft's local storage, as viewers name it. Every Page syncs with
  // plain Automerge sync whatever it says.
  if (![undefined, "native", "automerge"].includes(args.record_storage))
    throw new HttpError(400, "Invalid record_storage");
  const source = args.initial_snapshot_base64;
  if (
    typeof source !== "string" ||
    !source ||
    source.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)
  )
    throw new HttpError(400, "Invalid initial_snapshot_base64");
  if (source.length > 1024 * 1024) throw new HttpError(413, "Initial snapshot is too large");
  let doc;
  try {
    const encoded = atob(source);
    if (btoa(encoded) !== source) throw Error("Noncanonical base64");
    const bytes = Uint8Array.from(encoded, (value) => value.charCodeAt(0));
    doc = A.load(bytes);
    if (
      doc.page_id !== args.page_id ||
      doc.title !== args.title ||
      !map(doc.blocks) ||
      doc.comments !== undefined
    )
      throw Error("Invalid Page bootstrap");
    // A draft from a newer build can use features this host can't express.
    // Check the stamp before validating content against this build's schema,
    // so a future mark is refused as a feature, not as a malformed snapshot.
    requireSupportedSchema(doc);
    // A draft's comments live in their own document, which its stamp says.
    // A draft from a build before that is in a form this build doesn't read.
    if (!commentsMigrated(doc)) throw storedFormUnsupported("this draft Page");
    for (const [id, block] of Object.entries(doc.blocks)) {
      if (
        !validPageId(id) ||
        !map(block) ||
        Object.keys(block).length !== BLOCK_KEYS.length ||
        !BLOCK_KEYS.every((key) => Object.hasOwn(block, key)) ||
        !validBlockFields(block)
      )
        throw Error("Invalid Page block");
      validateRich(block);
    }
    if (!Object.keys(doc.blocks).length) throw Error("Page bootstrap needs a block");
    assertDocumentLimits(doc);
    return { doc, bytes };
  } catch (error) {
    if (doc) A.free(doc);
    if (error.status === 413) throw error;
    if (error.code === "unsupported_schema_feature")
      throw Object.assign(new HttpError(409, error.message, error.code), {
        details: error.details,
      });
    if (error.code === STORED_FORM_UNSUPPORTED) throw new HttpError(409, error.message, error.code);
    throw new HttpError(400, "Invalid initial Page snapshot");
  }
}

// This assertion binds an offline draft to its original authenticated account.
// It cannot grant access: host ownership still comes only from the credential.
export function requireRegistrationAccount(args, identity) {
  if (
    typeof args?.expected_principal !== "string" ||
    !args.expected_principal ||
    args.expected_principal.length > 1024
  )
    throw new HttpError(400, "expected_principal is required");
  if (identity && args.expected_principal !== identity.principal)
    throw new HttpError(403, "Sign in with this Page's original account to register it");
}
