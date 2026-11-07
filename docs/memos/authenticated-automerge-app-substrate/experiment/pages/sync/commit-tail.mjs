// The host reserves one bounded multi-key put for the publication boundary.
// This is a key-count limit, not a transaction over the preceding staging puts.
export const MAX_COMMIT_TAIL_KEYS = 128;

/** Validate the whole request before an adapter starts staging any entries. */
export function validateCommitTail(staged, tail) {
  if (!Array.isArray(staged) || !Array.isArray(tail))
    throw new TypeError("Commit staging and tail must be entry arrays");
  if (tail.length < 1 || tail.length > MAX_COMMIT_TAIL_KEYS)
    throw new RangeError(`Commit tail requires 1–${MAX_COMMIT_TAIL_KEYS} keys`);
  const seen = new Set();
  for (const entries of [staged, tail]) {
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !entry[0].length ||
        !(entry[1] instanceof Uint8Array)
      )
        throw new TypeError("Commit entries require a nonempty string key and Uint8Array value");
      if (seen.has(entry[0])) throw new Error(`Duplicate commit key: ${entry[0]}`);
      seen.add(entry[0]);
    }
  }
}
