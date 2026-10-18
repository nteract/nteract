import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { recordBytes } from "@automerge/automerge-repo/sedimentree";

// The native adapter stores each record as hex inside a JSON frame. Keeping
// signed record bytes below 900 KiB leaves room under SQLite DO's 2 MB value
// limit for that doubling, the frame, its key, and structured-clone overhead.
export const BACKEND_LIMITS = Object.freeze({
  maxRecordBytes: 900 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
});
export const MAX_STORED_BYTES = 1_900_000;
const encodedSize = (value) => new TextEncoder().encode(value).byteLength;
const tooLarge = (message) => {
  throw Object.assign(new Error(message), { status: 413 });
};

export function assertStoredSize(key, byteLength) {
  if (encodedSize(key) + byteLength > MAX_STORED_BYTES)
    tooLarge("This prototype limits each stored value and key to 1,900,000 bytes");
}

// Match SubductionBackend's admission check before creating a replayable API
// intent. Otherwise an oversized change would fail on every recovery attempt.
export function assertDocumentLimits(doc) {
  const records = extractRecords(doc);
  let total = 0;
  for (const record of records) {
    const size = recordBytes(record);
    if (size + 512 > BACKEND_LIMITS.maxRecordBytes)
      tooLarge("This prototype limits each native record to 900 KiB");
    total += size;
  }
  if (total > BACKEND_LIMITS.maxSnapshotBytes)
    tooLarge("This prototype limits document history to 16 MiB");
}

export function assertIntentSize(key, binaries, metadata) {
  // Host intents use binary typed arrays, not the native record's hex frame.
  // Reserve ample space for structured-clone tags and object/array bookkeeping.
  const bytes = binaries.reduce((size, value) => size + value.byteLength + 64, 4096);
  assertStoredSize(key, bytes + encodedSize(JSON.stringify(metadata)));
}
