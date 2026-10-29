/**
 * Keyed document frames (`0x0b KeyedDocSync`).
 *
 * Payload layout (after the type byte): `u32 BE header_len | JSON header |
 * Automerge sync bytes`, with header `{kind, id, epoch}`. Mirrors
 * `KeyedDocFrameHeader::try_parse` in `crates/notebook-wire` so the sync engine
 * can route frames without a WASM call; the per-kind replica in WASM parses
 * the frame again before applying it.
 */

/** Upper bound on the JSON header (`MAX_KEYED_DOC_FRAME_HEADER_LEN`). */
export const MAX_KEYED_DOC_FRAME_HEADER_LEN = 4 * 1024;
/** Maximum kind length (`MAX_KEYED_DOC_KIND_LEN`). */
export const MAX_KEYED_DOC_KIND_LEN = 64;
/** Maximum id length in UTF-8 bytes (`MAX_KEYED_DOC_ID_LEN`). */
export const MAX_KEYED_DOC_ID_LEN = 512;

const KIND_PATTERN = /^[a-z0-9_]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface KeyedDocFrameHeader {
  kind: string;
  id: string;
  epoch: number;
}

/** Whether a header passes the limits the daemon enforces. */
export function isValidKeyedDocFrameHeader(header: KeyedDocFrameHeader): boolean {
  const idBytes = encoder.encode(header.id).length;
  return (
    header.kind.length > 0 &&
    header.kind.length <= MAX_KEYED_DOC_KIND_LEN &&
    KIND_PATTERN.test(header.kind) &&
    idBytes > 0 &&
    idBytes <= MAX_KEYED_DOC_ID_LEN &&
    Number.isSafeInteger(header.epoch) &&
    header.epoch >= 0
  );
}

/**
 * Parse the header of a `0x0b` payload (no type byte). Returns `null` for a
 * truncated, oversized or invalid header.
 */
export function parseKeyedDocFrameHeader(payload: Uint8Array): KeyedDocFrameHeader | null {
  if (payload.length < 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen > MAX_KEYED_DOC_FRAME_HEADER_LEN || payload.length < 4 + headerLen) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { kind, id, epoch } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof id !== "string" || typeof epoch !== "number") {
    return null;
  }
  const header = { kind, id, epoch };
  return isValidKeyedDocFrameHeader(header) ? header : null;
}
