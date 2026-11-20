/**
 * edit_page set_source with inline `text`: the agent sends a JavaScript, CSS,
 * JSON or CSV source's content in the operation instead of uploading it
 * first (shared/sources.mjs INLINE_SOURCE_MEDIA_TYPES).
 *
 * The Page host turns each inline operation into the asset_id operation an
 * upload of the same bytes would let the agent send, before the journal sees
 * the batch, and records each inline operation's index and media type in the
 * batch's INLINE_FIELD. The journal's fingerprint covers both, and its
 * receipt holds the asset ids, never the text. A retry that resends the same
 * text with the same media type under the same nonce replays the receipt;
 * other text, another media type, or the same bytes named by asset_id is a
 * different request and a nonce_conflict.
 *
 * The bytes are stored in the write's `prepare` step, which runs only for a
 * new intent, after every check that can refuse without them and before the
 * stored assets are looked up and the intent is journaled. Storing is
 * content-addressed and idempotent (persistPageAsset), so it needs no state
 * of its own: an attempt that stored the bytes and stopped before the
 * journal stores nothing new when it is retried, and a store that fails
 * refuses the write with nothing journaled and the sources document
 * untouched. Every inline asset in a batch is stored before the batch's one
 * sources change names any of them.
 *
 * The text is only ever the caller's own bytes, hashed and stored on the
 * caller's Page: no inline operation names or reads another asset.
 */
import { HttpError } from "./auth.mjs";
import { assetIdOf, imageAssetKey, persistPageAsset } from "./image-assets.mjs";
import { inlineTextBytes, validateSourceBatch } from "../model/sources-doc.mjs";

/** The edit_page argument the host adds to a batch it rewrote: `[index,
 * media_type]` for each inline operation. It exists for the journal's
 * fingerprint, which covers the whole arguments object; nothing else reads
 * it. The public tool boundary refuses it as an unknown argument
 * (tool-arguments.mjs), and it is replaced whenever a batch holds inline
 * text, so a caller can't forge one for an inline batch. */
export const INLINE_FIELD = "inline_text";

const isInline = (op) =>
  !!op && typeof op === "object" && op.op === "set_source" && Object.hasOwn(op, "text");

/**
 * `args` with each inline set_source as its asset_id operation and
 * INLINE_FIELD set, and the bytes to store: `{ args, inline }`, where
 * `inline` maps an asset id to `{ bytes, mediaType, sourceId }`. A batch with
 * no inline operation comes back as it was. Throws a sources document
 * refusal (model/sources-doc.mjs) for a malformed batch.
 */
export async function inlineSourceArguments(args) {
  const operations = args?.operations;
  if (!Array.isArray(operations) || !operations.some(isInline)) return { args, inline: new Map() };
  validateSourceBatch(operations);
  const inline = new Map();
  const rewritten = [];
  const recorded = [];
  for (const [index, op] of operations.entries()) {
    if (!isInline(op)) {
      rewritten.push(op);
      continue;
    }
    const { text: _text, media_type: mediaType, ...rest } = op;
    // The one encoding of this text: hashed here, stored by prepare.
    const bytes = inlineTextBytes(op);
    const assetId = await assetIdOf(bytes);
    const held = inline.get(assetId);
    if (held && held.mediaType !== mediaType)
      throw Object.assign(
        Error(
          `${op.source_id}: another set_source in this batch holds the same text as ${held.mediaType}`,
        ),
        { status: 400, code: "invalid_source" },
      );
    if (!held) inline.set(assetId, { bytes, mediaType, sourceId: op.source_id });
    rewritten.push({ ...rest, asset_id: assetId });
    recorded.push([index, mediaType]);
  }
  return { args: { ...args, operations: rewritten, [INLINE_FIELD]: recorded }, inline };
}

/** The refusal for bytes this Page already stores as another media type. */
const storedAsAnother = (sourceId, type) =>
  new HttpError(
    400,
    `${sourceId}: this Page stores the same bytes as ${type}; send them with that media_type`,
    "invalid_source",
  );

/**
 * Store each inline asset on `pageId` as an upload of its bytes with its
 * media type would be stored: the same checks, key, metadata and limits
 * (persistPageAsset). A content refusal is `invalid_source`, its message
 * opening with the source_id it came from; so are bytes the Page stores as
 * another media type, whether they were there before or a concurrent write
 * stored them first. Any other storage failure is thrown as it is.
 */
export async function storeInlineSources(bucket, pageId, inline) {
  if (!inline.size) return;
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  const storedType = async (assetId) =>
    (await bucket.head(imageAssetKey(pageId, assetId)))?.httpMetadata?.contentType;
  for (const [assetId, { bytes, mediaType, sourceId }] of inline) {
    // An asset id holds one media type. Bytes this Page already stores as
    // another type are refused here, where persistPageAsset could only fail
    // to confirm the object.
    const held = await storedType(assetId);
    if (held !== undefined && held !== mediaType) throw storedAsAnother(sourceId, held);
    let stored;
    try {
      ({ asset: stored } = await persistPageAsset(bucket, {
        pageId,
        bytes,
        contentTypes: [mediaType],
        expect: { content_type: mediaType },
      }));
    } catch (error) {
      if (error?.status === 415)
        throw new HttpError(400, `${sourceId}: ${error.message}`, "invalid_source");
      // A write that stored these bytes as another type between the check
      // above and the conditional put fails persistPageAsset's confirmation.
      if (error?.status === undefined) {
        const raced = await storedType(assetId).catch(() => undefined);
        if (raced !== undefined && raced !== mediaType) throw storedAsAnother(sourceId, raced);
      }
      throw error;
    }
    if (stored.asset_id !== assetId) throw Error("Stored inline text disagrees with its asset id");
  }
}
