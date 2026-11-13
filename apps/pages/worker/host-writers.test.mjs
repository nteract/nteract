import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { cbor } from "@automerge/automerge-repo";
import { WRITER_LIMITS } from "../model/author.mjs";
import { MemoryByteStore } from "../sync/doc-store.mjs";
import { SyncHost } from "../sync/host.mjs";
import {
  WRITER_PREFIX,
  actorWriterId,
  hostWriter,
  recordWriter,
  resolveWriters,
  writerActor,
  writerId,
} from "./host-writers.mjs";

const prefix = "0123456789abcdef";
const identity = {
  principal: "user:anaconda-fixture:writer",
  displayName: "Writer",
  driver: "Kilo",
  credentialKind: "api-key",
};

class Storage {
  values = new Map();
  gets = 0;
  async get(key) {
    this.gets++;
    return structuredClone(this.values.get(key));
  }
  async put(entries) {
    for (const [key, value] of Object.entries(entries))
      this.values.set(key, structuredClone(value));
  }
}

test("a writer record is the authorOf shape, and its id follows its content, not its key order", async () => {
  assert.deepEqual(hostWriter(identity, { name: "Rel", model: "m-1" }), {
    principal: identity.principal,
    displayName: "Writer",
    driver: "Kilo",
    agent: { name: "Rel", model: "m-1" },
  });
  assert.deepEqual(hostWriter(identity), {
    principal: identity.principal,
    displayName: "Writer",
    driver: "Kilo",
  });
  const id = await writerId(hostWriter(identity, { name: "Rel", model: "m-1" }));
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(await writerId(hostWriter(identity, { model: "m-1", name: "Rel" })), id);
  const others = await Promise.all([
    writerId(hostWriter(identity, { name: "Rel" })),
    writerId(hostWriter(identity)),
    writerId(hostWriter({ ...identity, driver: "API" }, { name: "Rel", model: "m-1" })),
    writerId(hostWriter({ ...identity, principal: "user:x" }, { name: "Rel", model: "m-1" })),
  ]);
  assert.equal(new Set([id, ...others]).size, 5);
});

test("an oversized display name is cut to WRITER_LIMITS before it is hashed or stored", async () => {
  // 199 units then a surrogate pair: the cut never keeps half of it.
  const long = { ...identity, displayName: "n".repeat(199) + "😀" + "x".repeat(5000) };
  const writer = hostWriter(long, { name: "Rel" });
  assert.equal(writer.displayName, "n".repeat(199));
  const storage = new Storage();
  const first = await recordWriter(storage, writer);
  await storage.put(first.writes);
  const stored = cbor.decode(new Uint8Array(storage.values.get(WRITER_PREFIX + first.id)));
  assert.ok(stored.displayName.length <= WRITER_LIMITS.displayName);
  // The same caller, however long its name, maps to one id.
  const again = await recordWriter(storage, hostWriter(long, { name: "Rel" }));
  assert.deepEqual(again, { id: first.id, writes: {} });
  assert.equal(
    await writerId(
      hostWriter({ ...long, displayName: long.displayName + "more" }, { name: "Rel" }),
    ),
    first.id,
  );
});

test("a host actor names its writer between the prefix and a fresh nonce", async () => {
  const id = await writerId(hostWriter(identity));
  const actors = new Set(Array.from({ length: 10_000 }, () => writerActor(prefix, id)));
  assert.equal(actors.size, 10_000, "no two mutations share an actor");
  for (const actor of actors) {
    assert.match(actor, /^[0-9a-f]{48}$/);
    assert.equal(actorWriterId(prefix, actor), id);
  }
  // A host actor of the prefix and a nonce alone (the host's own edits, and
  // every host edit stored before writers) names no writer.
  assert.equal(actorWriterId(prefix, prefix + "fedcba9876543210"), null);
  // Another host's prefix, a browser's actor, or no prefix at all.
  assert.equal(actorWriterId("ffffffffffffffff", [...actors][0]), null);
  assert.equal(actorWriterId(prefix, "aa".repeat(16)), null);
  assert.equal(actorWriterId(undefined, [...actors][0]), null);
  assert.throws(() => writerActor(prefix, "not-an-id"), TypeError);
});

test("a writer is recorded once; a different record under its id is refused", async () => {
  const storage = new Storage();
  const writer = hostWriter(identity, { name: "Rel" });
  const first = await recordWriter(storage, writer);
  assert.deepEqual(Object.keys(first.writes), [WRITER_PREFIX + first.id]);
  await storage.put(first.writes);
  assert.deepEqual(await recordWriter(storage, writer), { id: first.id, writes: {} });
  // Not a collision anyone can produce: a stored record that disagrees with
  // its id is refused rather than renamed.
  await storage.put({
    [WRITER_PREFIX + first.id]: new Uint8Array(cbor.encode(hostWriter(identity))),
  });
  await assert.rejects(recordWriter(storage, writer), { code: "writer_conflict" });
});

test("resolveWriters answers claims, writer records and unrecorded actors, one read per writer", async () => {
  const storage = new Storage();
  const writer = hostWriter(identity, { name: "Rel", model: "m-1" });
  const { id, writes } = await recordWriter(storage, writer);
  await storage.put(writes);
  const hostEdits = Array.from({ length: 1000 }, () => writerActor(prefix, id));
  const claims = new Map([
    [
      "aa".repeat(16),
      { principal: "user:browser", displayName: "Browser person", driver: "Browser" },
    ],
    ["bb".repeat(16), { host: true, firstSeen: 1 }],
  ]);
  const missing = writerActor(prefix, "0000000000000000");
  storage.gets = 0;
  const resolved = await resolveWriters({ storage, prefix, claim: (actor) => claims.get(actor) }, [
    ...hostEdits,
    "aa".repeat(16),
    "bb".repeat(16),
    "cc".repeat(16),
    prefix + "1".repeat(16),
    missing,
  ]);
  assert.equal(storage.gets, 2, "one read per distinct writer id");
  for (const actor of hostEdits) assert.deepEqual(resolved.get(actor), { ...writer, via: "tool" });
  assert.deepEqual(resolved.get("aa".repeat(16)), {
    principal: "user:browser",
    displayName: "Browser person",
    driver: "Browser",
    via: "sync",
  });
  // The host's own claim, an unclaimed actor, a host actor without a writer
  // and a writer id with no record: never guessed.
  for (const actor of ["bb".repeat(16), "cc".repeat(16), prefix + "1".repeat(16), missing])
    assert.equal(resolved.get(actor), null, actor);
});

// Measurements behind the design decision. Each prints its numbers with
// t.diagnostic and asserts the property the decision relies on.

test("raw Automerge carries a change's message and time through save, load, clone, merge and sync bytes", (t) => {
  const message = JSON.stringify(hostWriter(identity, { name: "Rel", model: "m-1" }));
  const base = A.from({ title: "" }, { actor: "01".repeat(16) });
  const edited = A.change(
    A.clone(base, { actor: "02".repeat(24) }),
    { message, time: 1234 },
    (d) => {
      d.title = "Edited";
    },
  );
  const meta = (doc) => {
    const change = A.decodeChange(A.getLastLocalChange(doc) ?? A.getAllChanges(doc).at(-1));
    return { message: change.message, time: change.time, actor: change.actor };
  };
  const expected = { message, time: 1234, actor: "02".repeat(24) };
  assert.deepEqual(meta(edited), expected);
  const loaded = A.load(A.save(edited));
  const last = (doc) => {
    const change = A.getAllChanges(doc)
      .map(A.decodeChange)
      .find((c) => c.actor === "02".repeat(24));
    return { message: change.message, time: change.time, actor: change.actor };
  };
  assert.deepEqual(last(loaded), expected, "save and load");
  assert.deepEqual(last(A.clone(edited)), expected, "clone");
  assert.deepEqual(last(A.merge(A.clone(base), edited)), expected, "merge");
  const [applied] = A.applyChanges(A.clone(base), A.getChanges(base, edited));
  assert.deepEqual(last(applied), expected, "change bytes, as sync sends them");
  assert.deepEqual(A.getHistory(loaded).at(-1).change.message, message, "getHistory");
  // Any peer authors any message, under any actor it picks: a browser can
  // write the same bytes the host would. Only the actor tells them apart,
  // and only the host knows which actors are its own.
  const forged = A.change(
    A.clone(base, { actor: "03".repeat(16) }),
    { message, time: 1234 },
    (d) => {
      d.title = "Forged";
    },
  );
  const forgedChange = A.getAllChanges(A.load(A.save(forged)))
    .map(A.decodeChange)
    .find((c) => c.actor === "03".repeat(16));
  assert.equal(forgedChange.message, message);
  assert.equal(forgedChange.time, 1234);
  // Every author stamps `time` from its own clock unless told otherwise.
  assert.equal(typeof A.decodeChange(A.getAllChanges(base)[0]).time, "number");
  // A change without a message reads null.
  assert.equal(A.decodeChange(A.getAllChanges(base)[0]).message, null);
  t.diagnostic(JSON.stringify({ messageBytes: new TextEncoder().encode(message).byteLength }));
  for (const doc of [base, edited, loaded, applied, forged]) A.free(doc);
});

test("what each design adds to history: a writer message per change, or 8 more actor bytes", (t) => {
  const edits = 1000;
  // Three agents take turns, as on a Page several people's agents edit.
  const messages = ["Release agent", "Reviewer", "Planner"].map((name, n) =>
    JSON.stringify(
      hostWriter({ ...identity, principal: `user:p${n}` }, { name, model: "model-1" }),
    ),
  );
  const history = ({ actorBytes, withMessage }) => {
    let doc = A.from({ title: "" }, { actor: "01".repeat(16) });
    for (let n = 0; n < edits; n++) {
      const actor = Array.from(crypto.getRandomValues(new Uint8Array(actorBytes)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const next = A.change(
        A.clone(doc, { actor }),
        withMessage
          ? { message: messages[n % messages.length], time: 1_700_000_000 + n }
          : { time: 1_700_000_000 + n },
        (d) => {
          d.title = `Edit ${n}`;
        },
      );
      doc = A.merge(doc, next);
      A.free(next);
    }
    const saved = A.save(doc).byteLength;
    const changes = A.getAllChanges(doc).reduce((sum, bytes) => sum + bytes.byteLength, 0);
    A.free(doc);
    return { saved, changes };
  };
  const before = history({ actorBytes: 16, withMessage: false });
  const actorNamesWriter = history({ actorBytes: 24, withMessage: false });
  const messageNamesWriter = history({ actorBytes: 16, withMessage: true });
  const perEdit = (m) => ({
    saved: (m.saved - before.saved) / edits,
    changes: (m.changes - before.changes) / edits,
  });
  t.diagnostic(
    JSON.stringify({
      edits,
      before,
      actorNamesWriter,
      messageNamesWriter,
      perEdit: {
        actorNamesWriter: perEdit(actorNamesWriter),
        messageNamesWriter: perEdit(messageNamesWriter),
      },
    }),
  );
  // A writer id in the actor costs its 8 bytes per edit, in a saved document
  // and in each change. A message costs its whole JSON in every change (what
  // sync sends, the journal holds and a chunk stores until compaction); a
  // saved document compresses repeated messages.
  assert.ok(perEdit(actorNamesWriter).saved <= 12, JSON.stringify(perEdit(actorNamesWriter)));
  assert.ok(perEdit(actorNamesWriter).changes <= 20, JSON.stringify(perEdit(actorNamesWriter)));
  assert.ok(
    perEdit(messageNamesWriter).changes >= 100,
    JSON.stringify(perEdit(messageNamesWriter)),
  );
});

test("raw Automerge's own per-change author: hex only, any peer sets it, survives history, costs little", (t) => {
  const hex = (n) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  const base = A.from({ title: "" }, { actor: "01".repeat(16) });
  const authorsOf = (doc) =>
    A.getChangesMetaSince(doc, A.getHeads(base)).map((change) => change.author);
  const author = "ab".repeat(8);
  const edited = A.change(A.clone(base, { actor: "02".repeat(16), author }), (d) => {
    d.title = "Edited";
  });
  assert.deepEqual(authorsOf(edited), [author]);
  assert.deepEqual(authorsOf(A.load(A.save(edited))), [author], "save and load");
  assert.deepEqual(authorsOf(A.merge(A.clone(base), edited)), [author], "merge");
  const [applied] = A.applyChanges(A.clone(base), A.getChanges(base, edited));
  assert.deepEqual(authorsOf(applied), [author], "change bytes, as sync sends them");
  assert.equal(A.decodeChange(A.getLastLocalChange(edited)).author, author);
  // An author is bytes, not a label: a principal can't be one.
  assert.throws(() => A.clone(base, { author: "user:anaconda:someone" }), /Invalid author/);
  // Any peer names any author, and one actor can carry several.
  const other = A.change(
    A.clone(edited, { actor: "02".repeat(16), author: "cd".repeat(8) }),
    (d) => {
      d.title = "Again";
    },
  );
  assert.deepEqual(authorsOf(other), [author, "cd".repeat(8)]);
  // Cost: 1000 edits by 3 interleaved authors.
  const authors = [hex(8), hex(8), hex(8)];
  const run = (withAuthor) => {
    let doc = A.from({ title: "" }, { actor: "01".repeat(16) });
    for (let n = 0; n < 1000; n++) {
      const next = A.change(
        A.clone(doc, { actor: hex(16), ...(withAuthor && { author: authors[n % 3] }) }),
        { time: 1_700_000_000 + n },
        (d) => {
          d.title = `Edit ${n}`;
        },
      );
      doc = A.merge(doc, next);
      A.free(next);
    }
    const result = {
      saved: A.save(doc).byteLength,
      changes: A.getAllChanges(doc).reduce((sum, bytes) => sum + bytes.byteLength, 0),
    };
    A.free(doc);
    return result;
  };
  const without = run(false);
  const withAuthor = run(true);
  t.diagnostic(JSON.stringify({ edits: 1000, without, withAuthor }));
  assert.ok((withAuthor.changes - without.changes) / 1000 <= 12);
  assert.ok((withAuthor.saved - without.saved) / 1000 <= 2);
  for (const doc of [base, edited, applied, other]) A.free(doc);
});

test("a claim per host actor would grow Page startup and every connect with each agent edit", async (t) => {
  // SyncHost.load reads every claim under actor/, one read per key, and the
  // connect answer carries every claim (PlainSync.actorSnapshot). Store a
  // claim per agent edit and count both.
  for (const edits of [100, 1000, 5000]) {
    const bytes = new MemoryByteStore();
    const claim = hostWriter(identity, { name: "Release agent", model: "model-1" });
    const entries = Array.from({ length: edits }, () => [
      `actor/${prefix}${"0".repeat(16)}${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`,
      cbor.encode({ ...claim, firstSeen: Date.now() }),
    ]);
    await bytes.saveMany(entries);
    const stored = entries.reduce((sum, [key, value]) => sum + key.length + value.byteLength, 0);
    bytes.stats.loads = 0;
    const host = await new SyncHost({ bytes }).load();
    const snapshot = JSON.stringify(Object.fromEntries(host.actors()));
    t.diagnostic(
      JSON.stringify({
        edits,
        keys: edits,
        storedBytes: stored,
        startupReads: bytes.stats.loads,
        connectBytes: snapshot.length,
      }),
    );
    assert.equal(bytes.stats.loads, edits, "one storage read per claim at every Page start");
  }
});
