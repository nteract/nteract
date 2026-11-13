import { cbor } from "@automerge/automerge-repo";
import { authorOf, boundedWriter } from "../model/author.mjs";

// Who wrote a host edit. A journaled host mutation (worker/mutations.mjs)
// authors its change under an actor that names its writer:
//
//   <host prefix: 8 bytes><writer id: 8 bytes><nonce: 8 bytes>
//
// The prefix is the Page host's persisted namespace, which SyncHost refuses
// from every browser, so only the host authors under it. The writer id names
// one record under `plain/writer/<id>`: the authorOf shape
// (model/author.mjs) of the authenticated account and the agent its client
// asserted. The id is the first 8 bytes of the SHA-256 of that record, so a
// writer is stored once however many edits it makes, and a retry derives the
// same id. The nonce is fresh per mutation: concurrent producers building
// from the same heads never share an (actor, seq).
//
// A host actor of the prefix and 8 bytes alone carries no writer: the host's
// own edits (migrations, genesis, direct handle changes), and every host edit
// stored before writers were recorded. A read reports those as unrecorded.

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

/** A writer record's 16-hex id. */
export async function writerId(writer) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(writer)));
  return hex(new Uint8Array(digest).slice(0, 8));
}

/** A fresh host actor naming writer `id`. */
export function writerActor(prefix, id) {
  if (!ID.test(id)) throw new TypeError("A writer id is 16 hex characters");
  return prefix + id + hex(crypto.getRandomValues(new Uint8Array(8)));
}

/** The writer id `actor` names, or null: an actor outside the host prefix,
 * or a host actor that names no writer. */
export function actorWriterId(prefix, actor) {
  if (!prefix || typeof actor !== "string" || !actor.startsWith(prefix)) return null;
  if (actor.length !== prefix.length + 32) return null;
  const id = actor.slice(prefix.length, prefix.length + 16);
  return ID.test(id) ? id : null;
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
 * Who wrote each of `actors`, as a Map from actor to a writer or null.
 * A host actor resolves through its writer record (`via: "tool"`); any other
 * actor through its actor claim, `claim(actor)` (`via: "sync"`). A claim the
 * host made for itself, a host actor without a writer, and an actor nobody
 * claimed resolve to null: the read says the writer is unrecorded and never
 * guesses.
 */
export async function resolveWriters({ storage, prefix, claim }, actors) {
  const result = new Map();
  const ids = new Map();
  for (const actor of actors) {
    const id = actorWriterId(prefix, actor);
    if (id) {
      ids.set(actor, id);
      continue;
    }
    if (prefix && actor.startsWith(prefix)) {
      result.set(actor, null);
      continue;
    }
    const claimed = claim?.(actor);
    result.set(
      actor,
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
  // One read per distinct writer, not per edit: a delta of thousands of host
  // edits by one agent reads one record.
  const records = new Map();
  for (const id of new Set(ids.values())) {
    const bytes = await storage.get(WRITER_PREFIX + id);
    if (bytes !== undefined) records.set(id, bytes);
  }
  for (const [actor, id] of ids) {
    const bytes = records.get(id);
    result.set(actor, bytes ? { ...cbor.decode(new Uint8Array(bytes)), via: "tool" } : null);
  }
  return result;
}
