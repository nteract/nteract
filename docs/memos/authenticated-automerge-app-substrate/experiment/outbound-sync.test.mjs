import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { applyRecords, extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { closePeers, connectPeers, createPeer, eventually, treeId } from "./backend.mjs";

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const history = (doc) => ({
  hashes: A.getAllChanges(doc)
    .map((change) => A.decodeChange(change).hash)
    .sort(),
  heads: A.getHeads(doc).sort(),
  content: A.toJS(doc),
});

async function assertStoredHistory(reader, id, expected) {
  // A connected session would subscribe and fetch. Read only copied bytes on
  // an offline peer, including fragments, without warming the reader's session.
  const storage = new MemoryByteStore();
  for (const key of await reader.storage.list(""))
    await storage.save(key, await reader.storage.load(key));
  const offline = createPeer({ storage });
  const session = offline.backend.open(id);
  const events = session.events[Symbol.asyncIterator]();
  let doc = A.init();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("stored history local load timed out")), 1000);
  });
  try {
    for (;;) {
      const { value: event, done } = await Promise.race([events.next(), deadline]);
      if (done) assert.fail("missing local-load-complete");
      if (event.type === "failure") throw event.error;
      if (event.type === "records") doc = applyRecords(doc, event.records);
      if (event.type === "local-load-complete") {
        assert.deepEqual(A.getMissingDeps(doc), [], "stored history has no pending dependencies");
        assert.deepEqual(history(doc), expected);
        return;
      }
    }
  } finally {
    clearTimeout(timer);
    A.free(doc);
    try {
      // Release a pending next() even if session or backend shutdown stalls.
      const cleanup = Promise.all([
        events.return(),
        session.close(),
        closePeers([offline]).then((failures) => assert.deepEqual(failures, [])),
      ]);
      await Promise.race([
        cleanup,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("stored history teardown timed out")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

test("scheduleLocalSync decides when a local store's sync round starts", async () => {
  const waiting = new Map();
  const writer = createPeer({
    scheduleLocalSync: (id, start) => waiting.set(id, start),
  });
  const reader = createPeer();
  const wires = [];
  try {
    wires.push(await connectPeers(writer, reader));
    // The reader never opens the document, so it holds no subscription that
    // native would push to: only the writer's own round delivers.
    // Fixed change identities exercise a fragment as well as loose commits.
    const actor = "0000000000000000000000000000005f";
    const initial = A.change(A.init({ actor }), { time: 0 }, (doc) => {
      doc.text = "first";
    });
    const source = await writer.repo.import(A.save(initial));
    A.free(initial);
    const id = treeId(source.documentId);
    const first = history(source.doc());
    // Opening the writer's session runs its own round at once.
    await writer.repo.flush();
    await eventually(() => assertStoredHistory(reader, id, first));
    waiting.clear();

    for (const text of ["second", "third", "fourth"])
      await source.update((doc) =>
        A.change(A.clone(doc, { actor }), { time: 0 }, (draft) => {
          draft.text = text;
        }),
      );
    await writer.repo.flush();
    assert.ok(extractRecords(source.doc()).some((record) => record.kind === "fragment"));
    const expected = history(source.doc());
    assert.equal(expected.hashes.length, 4);
    // Every store has persisted and asked for a round; none has started.
    assert.deepEqual([...waiting.keys()], [id]);
    await settle();
    await assertStoredHistory(reader, id, first);

    // One start sends the whole run.
    waiting.get(id)();
    await eventually(() => assertStoredHistory(reader, id, expected));
    assert.deepEqual(Object.keys(reader.repo.handles), []);
    const copy = await reader.repo.find(source.documentId);
    await eventually(() => assert.equal(copy.doc().text, "fourth"));
  } finally {
    assert.deepEqual(await closePeers([writer, reader], wires), []);
  }
});

test("start is a no-op once the backend has closed", async () => {
  const waiting = [];
  const writer = createPeer({ scheduleLocalSync: (_id, start) => waiting.push(start) });
  const source = await writer.repo.create({ text: "local only" });
  await writer.repo.flush();
  assert.ok(waiting.length > 0);
  assert.deepEqual(await closePeers([writer]), []);
  for (const start of waiting) assert.doesNotThrow(start);
  assert.equal(source.doc().text, "local only");
});

test("a hook that throws starts the round at once", async () => {
  const writer = createPeer({
    scheduleLocalSync: () => {
      throw Error("hook failed");
    },
  });
  const reader = createPeer();
  const wires = [];
  try {
    wires.push(await connectPeers(writer, reader));
    const source = await writer.repo.create({ text: "first" });
    const copy = await reader.repo.find(source.documentId);
    await eventually(() => assert.equal(copy.doc().text, "first"));
    await source.change((doc) => {
      doc.text = "pushed";
    });
    await eventually(() => assert.equal(copy.doc().text, "pushed"));
  } finally {
    assert.deepEqual(await closePeers([writer, reader], wires), []);
  }
});
