import test from "node:test";
import assert from "node:assert/strict";
import { closePeers, connectPeers, createPeer, eventually, treeId } from "./backend.mjs";

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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
    const source = await writer.repo.create({ text: "first" });
    const id = treeId(source.documentId);
    const commits = async () =>
      (await reader.storage.list("")).filter(
        (key) => key.includes(id) && key.includes("/commits/"),
      );
    // Opening the writer's session runs its own round at once.
    await writer.repo.flush();
    await eventually(async () => assert.equal((await commits()).length, 1));
    waiting.clear();

    for (const text of ["second", "third", "fourth"])
      await source.change((doc) => {
        doc.text = text;
      });
    await writer.repo.flush();
    // Every store has persisted and asked for a round; none has started.
    assert.deepEqual([...waiting.keys()], [id]);
    await settle();
    assert.equal((await commits()).length, 1, "no local store reached the reader before start");

    // One start sends the whole run.
    waiting.get(id)();
    await eventually(async () => assert.equal((await commits()).length, 4));
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
