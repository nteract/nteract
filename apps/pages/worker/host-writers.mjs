import { cbor } from "@automerge/automerge-repo";
import { authorOf, boundedWriter } from "../model/author.mjs";

// Who wrote a host edit. A journaled host mutation a caller asked for
// (worker/mutations.mjs) authors its change under a fresh host actor, the
// Page host's persisted prefix and 8 random bytes, and sets the change's own
// Automerge `author` to its writer id. The id names one record under
// `plain/writer/<id>`: the authorOf shape (model/author.mjs) of the
// authenticated account and the agent labels its client sent, bounded by
// WRITER_LIMITS. The id is the first 8 bytes of the SHA-256 of that record,
// so a writer is stored once however many edits it makes, and a retry
// derives the same id.
//
// Trust rule: an `author` is believed only on a change whose actor is under
// the host prefix. SyncHost refuses that prefix from every browser, so only
// the host authors under it. Any peer can set `author` on its own changes;
// on any other actor the field is ignored and the writer is the actor's
// claim. A host change with no author (the host's own edits, every host edit
// stored before writers were recorded) or an author with no record names no
// writer.

export const WRITER_PREFIX = "plain/writer/";
const ID = /^[0-9a-f]{16}$/;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Key-sorted JSON, so equal records hash alike whatever their key order. */
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

/** The writer record of a host edit by `identity`, with its client's
 * `agent` labels: the authorOf shape comments and sources store, its display
 * name cut to WRITER_LIMITS (boundedWriter) before it is hashed or stored. */
export const hostWriter = (identity, agent) => boundedWriter(authorOf(identity, agent));

/** A writer record's 16-hex id, the `author` its edits carry. */
export async function writerId(writer) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(writer)));
  return hex(new Uint8Array(digest).slice(0, 8));
}

/**
 * The id of `writer` and the storage writes that record it: none when the
 * record is already stored. The caller puts them in the same storage put as
 * the journal entry that holds the edit's change bytes, so no stored history
 * names a writer that has no record. A stored record that differs from
 * `writer` under the same id refuses the write rather than rename anyone.
 */
export async function recordWriter(storage, writer) {
  const id = await writerId(writer);
  const key = WRITER_PREFIX + id;
  const stored = await storage.get(key);
  if (stored === undefined) return { id, writes: { [key]: new Uint8Array(cbor.encode(writer)) } };
  if (canonical(cbor.decode(new Uint8Array(stored))) !== canonical(writer))
    throw Object.assign(new Error("A different writer is recorded under this id"), {
      status: 500,
      code: "writer_conflict",
    });
  return { id, writes: {} };
}

/**
 * Who wrote `changes` (`{ actor, author }`, as decoded), as a function from
 * one such change to a writer or null. A change under the host prefix
 * resolves through the record its `author` names (`via: "tool"`); any other
 * through its actor's claim, `claim(actor)` (`via: "sync"`), whatever author
 * it carries. A claim the host made for itself, an unclaimed actor, a host
 * change without an author and an author without a record resolve to null:
 * the read says the writer is unrecorded and never guesses. Each distinct
 * writer record is read once.
 */
export async function resolveWriters({ storage, prefix, claim }, changes) {
  const hosted = (change) => !!prefix && change.actor.startsWith(prefix);
  const records = new Map();
  for (const change of changes) {
    const id = hosted(change) && ID.test(change.author ?? "") ? change.author : null;
    if (!id || records.has(id)) continue;
    const bytes = await storage.get(WRITER_PREFIX + id);
    records.set(
      id,
      bytes === undefined ? null : { ...cbor.decode(new Uint8Array(bytes)), via: "tool" },
    );
  }
  const claims = new Map();
  return (change) => {
    if (hosted(change)) return (ID.test(change.author ?? "") && records.get(change.author)) || null;
    if (!claims.has(change.actor)) {
      const claimed = claim?.(change.actor);
      claims.set(
        change.actor,
        typeof claimed?.principal === "string"
          ? {
              principal: claimed.principal,
              displayName: claimed.displayName ?? "Collaborator",
              driver: claimed.driver ?? "Browser",
              via: "sync",
            }
          : null,
      );
    }
    return claims.get(change.actor);
  };
}
