import * as A from "@automerge/automerge/slim";
import { RICH_FORMAT, isRich, validateRich } from "./richtext.mjs";
import { checkSize, hash, validateJson, type Page } from "./document.ts";
import { PageError, object, requireValue, text } from "./errors.ts";

export const SYNC_PROTOCOL = "nteract-pages-automerge-v3";
export const MAX_SYNC_BYTES = 2 * 1024 * 1024;

// The account is admitted at ingress. Client suffixes distinguish replicas,
// not authenticated people. Never derive account identity from an actor ID.
export async function actorPrefix(principal: string): Promise<string> {
  return (await hash(`pages-actor-v1:${principal}`)).slice(0, 32);
}
export function newActor(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

function exactKeys(value: object, keys: string[]) {
  requireValue(
    Object.keys(value).every((key) => keys.includes(key)),
    "invalid_page_schema",
    "Unexpected document field",
  );
}
function noConflicts(value: object, keys: string[]) {
  for (const key of keys)
    requireValue(
      !A.getConflicts(value, key),
      "invalid_page_schema",
      "Conflicting structural values are not supported",
    );
}

/** Validate raw CRDT ingress, including identity and hidden structural conflicts. */
export function validatePage(doc: A.Doc<Page>, pageId: string): void {
  exactKeys(doc, ["schema_version", "page_id", "title", "order", "blocks"]);
  noConflicts(doc, ["schema_version", "page_id", "title", "order", "blocks"]);
  requireValue(
    doc.schema_version === 2 && doc.page_id === pageId,
    "invalid_page_schema",
    "Page identity cannot change",
  );
  text(doc.title, "title", 1024);
  requireValue(Array.isArray(doc.order), "invalid_page_schema", "Missing block order");
  const blocks = object(doc.blocks);
  requireValue(Object.keys(blocks).length <= 1000, "page_limit_exceeded", "Too many blocks");
  requireValue(
    new Set(doc.order).size === doc.order.length,
    "invalid_page_schema",
    "Duplicate block order",
  );
  for (const [id, raw] of Object.entries(blocks)) {
    requireValue(/^[a-f0-9-]{36}$/.test(id), "invalid_page_schema", "Invalid block ID");
    noConflicts(blocks, [id]);
    const block = object(raw);
    exactKeys(block, ["id", "kind", "markdown", "metadata", "format", "richText"]);
    noConflicts(block, ["id", "kind", "markdown", "metadata", "format", "richText"]);
    requireValue(block.id === id, "invalid_page_schema", "Block identity cannot change");
    requireValue(
      block.kind === "markdown" || block.kind === "agent_instructions",
      "invalid_page_schema",
      "Invalid block kind",
    );
    text(block.markdown, "markdown");
    if (block.format !== undefined || block.richText !== undefined) {
      requireValue(
        block.format === RICH_FORMAT &&
          block.kind === "markdown" &&
          typeof block.richText === "string",
        "invalid_page_schema",
        "Invalid rich text representation",
      );
      validateRich(raw);
    }
    validateJson(object(block.metadata));
    requireValue(
      new TextEncoder().encode(JSON.stringify(block.metadata)).length <= 8192,
      "page_limit_exceeded",
      "Block metadata exceeds 8 KiB",
    );
  }
  for (const id of doc.order)
    requireValue(
      typeof id === "string" && Object.hasOwn(blocks, id),
      "invalid_page_schema",
      "Order references a missing block",
    );
  checkSize(doc);
}

export function receiveAdmitted(
  doc: A.Doc<Page>,
  state: A.SyncState,
  message: Uint8Array,
  prefix: string,
): { doc: A.Doc<Page>; state: A.SyncState; changed: boolean } {
  requireValue(
    message.byteLength > 0 && message.byteLength <= MAX_SYNC_BYTES,
    "request_too_large",
    "Sync frame exceeds 2 MiB",
  );
  // Preview on a clone. Neither the durable document nor peer sync state may
  // advance after a rejected frame or an uncertain storage commit.
  let next = A.clone(doc);
  try {
    const result = A.receiveSyncMessage(next, structuredClone(state), message);
    next = result[0];
    requireValue(
      A.getMissingDeps(next, []).length === 0,
      "invalid_sync",
      "Sync changes have missing dependencies",
    );
    const changes = A.getChanges(doc, next);
    for (const change of changes) {
      const actor = A.decodeChange(change).actor;
      requireValue(
        actor.length === 64 && actor.startsWith(prefix) && /^[a-f0-9]+$/.test(actor),
        "forbidden_actor",
        "Change actor does not belong to the admitted account",
      );
    }
    validatePage(next, doc.page_id);
    for (const [id, prior] of Object.entries(doc.blocks)) {
      const current = next.blocks[id];
      if (current && isRich(prior))
        requireValue(
          isRich(current) && current.markdown === prior.markdown,
          "invalid_page_schema",
          "Rich text provenance cannot be edited; reopen with the current editor",
        );
      if (current && !isRich(prior) && isRich(current))
        throw new PageError(
          "invalid_page_schema",
          "Convert existing blocks through enable_rich_text",
        );
    }
    return { doc: next, state: result[1], changed: changes.length > 0 };
  } catch (error) {
    A.free(next);
    throw error instanceof PageError
      ? error
      : new PageError("invalid_sync", "Invalid Automerge sync frame");
  }
}
