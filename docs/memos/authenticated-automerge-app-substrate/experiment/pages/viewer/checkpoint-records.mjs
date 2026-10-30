import * as A from "@automerge/automerge";
import { extractRecords, validateRecord } from "@automerge/automerge-repo/sedimentree/automerge";

const identity = (record) => `${record.kind}/${record.kind === "commit" ? record.id : record.head}`;

/** The change hashes one validated record holds. A fragment may hold only
 * part of the history its head and metadata describe, so coverage comes from
 * its bundle, never from its key. */
function changeHashes(record) {
  const valid = validateRecord(record);
  return valid.kind === "commit"
    ? [valid.id]
    : A.readBundle(valid.blob).changes.map((change) => change.hash);
}

/** Record identities and change hashes the replica's stored records hold. */
async function storedHistory(backend, id) {
  const keys = new Set();
  const hashes = new Set();
  const session = backend.open(id);
  try {
    for await (const event of session.events) {
      if (event.type === "records")
        for (const record of event.records) {
          keys.add(identity(record));
          for (const hash of changeHashes(record)) hashes.add(hash);
        }
      else if (event.type === "local-load-complete") break;
      else if (event.type === "failure") throw event.error;
    }
  } finally {
    await session.close();
  }
  return { keys, hashes };
}

/**
 * Records that add a local checkpoint's missing history to this replica.
 *
 * A stored record is kept as is: it may be another peer's signed encoding, and
 * the backend accepts one representation per key. Checkpoint records under
 * keys the replica does not hold carry their own history. Any checkpoint
 * change still uncovered, for example a change missing from a partial stored
 * fragment with the same head, is added as a loose commit.
 */
export async function checkpointRecords(backend, id, checkpoint) {
  const stored = await storedHistory(backend, id);
  const changes = new Map(
    A.getAllChanges(checkpoint).map((bytes) => [A.decodeChange(bytes), bytes]),
  );
  const missing = [...changes.keys()].filter((change) => !stored.hashes.has(change.hash));
  if (!missing.length) return [];
  const records = extractRecords(checkpoint).filter((record) => !stored.keys.has(identity(record)));
  const covered = new Set(records.flatMap(changeHashes));
  for (const change of missing) {
    if (covered.has(change.hash)) continue;
    records.push(
      validateRecord({
        kind: "commit",
        id: change.hash,
        parents: [...new Set(change.deps)].sort(),
        blob: changes.get(change),
      }),
    );
  }
  return records;
}
