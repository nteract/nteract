/**
 * edit_page set_source with inline `text`: the agent sends a JavaScript, CSS,
 * JSON or CSV source's content in the operation instead of uploading it
 * first (shared/sources.mjs INLINE_SOURCE_MEDIA_TYPES).
 *
 * The Page host turns each inline operation into the asset_id operation an
 * upload of the same bytes would let the agent send, before the journal sees
 * the batch. The journal's fingerprint and receipt therefore hold the asset
 * id, never the text, and a retry that resends the same text under the same
 * nonce names the same asset and replays the receipt.
 *
 * The bytes are stored in the write's `prepare` step, which runs only for a
 * new intent, after the batch's source revisions are checked and before the
 * intent is journaled. Storing is content-addressed and idempotent
 * (persistPageAsset), so it needs no state of its own: an attempt that
 * stored the bytes and stopped before the journal stores nothing new when it
 * is retried, and a store that fails refuses the write with nothing
 * journaled and the sources document untouched. Every inline asset in a
 * batch is stored before the batch's one sources change names any of them.
 *
 * The text is only ever the caller's own bytes, hashed and stored on the
 * caller's Page: no inline operation names or reads another asset.
 */
import { HttpError } from "./auth.mjs";
import { assetIdOf, persistPageAsset } from "./image-assets.mjs";
import { inlineTextBytes, validateSourceBatch } from "../model/sources-doc.mjs";

const isInline = (op) =>
  !!op && typeof op === "object" && op.op === "set_source" && Object.hasOwn(op, "text");

/**
 * `args` with each inline set_source as its asset_id operation, and the
 * bytes to store: `{ args, inline }`, where `inline` maps an asset id to
 * `{ bytes, mediaType, sourceId }`. A batch with no inline operation comes
 * back as it was. Throws a sources document refusal (model/sources-doc.mjs)
 * for a malformed batch.
 */
export async function inlineSourceArguments(args) {
  const operations = args?.operations;
  if (!Array.isArray(operations) || !operations.some(isInline)) return { args, inline: new Map() };
  validateSourceBatch(operations);
  const inline = new Map();
  const rewritten = [];
  for (const op of operations) {
    if (!isInline(op)) {
      rewritten.push(op);
      continue;
    }
    const { text: _text, media_type: mediaType, ...rest } = op;
    const bytes = inlineTextBytes(op);
    const assetId = await assetIdOf(bytes);
    const held = inline.get(assetId);
    if (held && held.mediaType !== mediaType)
      throw Object.assign(
        Error("Two set_source texts hold the same bytes as different media types"),
        {
          status: 400,
          code: "invalid_source",
          details: { source_id: op.source_id },
        },
      );
    if (!held) inline.set(assetId, { bytes, mediaType, sourceId: op.source_id });
    rewritten.push({ ...rest, asset_id: assetId });
  }
  return { args: { ...args, operations: rewritten }, inline };
}

/**
 * Store each inline asset on `pageId` as an upload of its bytes with its
 * media type would be stored: the same checks, key, metadata and limits
 * (persistPageAsset). A content refusal names the source it came from as
 * `invalid_source`; a storage failure is thrown as it is.
 */
export async function storeInlineSources(bucket, pageId, inline) {
  if (!inline.size) return;
  if (!bucket) throw new HttpError(503, "Image storage is unavailable");
  for (const [assetId, { bytes, mediaType, sourceId }] of inline) {
    let stored;
    try {
      ({ asset: stored } = await persistPageAsset(bucket, {
        pageId,
        bytes,
        contentTypes: [mediaType],
        expect: { content_type: mediaType },
      }));
    } catch (error) {
      if (error?.status !== 415) throw error;
      throw Object.assign(new HttpError(400, `${sourceId}: ${error.message}`, "invalid_source"), {
        details: { source_id: sourceId },
      });
    }
    if (stored.asset_id !== assetId) throw Error("Stored inline text disagrees with its asset id");
  }
}
