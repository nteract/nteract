import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { changesContent } from "../worker/content-activity.mjs";
import { concat, DocStore, MemoryByteStore } from "./doc-store.mjs";
import { browser, host, newId, raw, until, urlOf } from "./test-helpers.mjs";

const actor = "ab".repeat(8) + "cd".repeat(8);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t) {
  const bytes = new MemoryByteStore();
  const h = await host({ bytes });
  h.hostActorPrefix = "ab".repeat(8);
  const id = newId();
  const base = A.from({ title: "Before", blocks: { b: { richText: "Text" } }, future: [] });
  await h.seed(id, "page", base);
  t.after(() => A.free(base));
  return { h, bytes, id, base };
}

function holdWrites(t, bytes) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async (entries) => {
    entered.resolve();
    await gate.promise;
    return save(entries);
  };
  const release = () => {
    bytes.saveMany = save;
    gate.resolve();
  };
  t.after(release);
  return { entered: entered.promise, release };
}

async function stored(bytes, id) {
  const data = await new DocStore(bytes).read(id);
  return A.load(concat([data.snapshot, ...data.chunks].filter(Boolean)));
}

function recorded(base, fn, options = { actor }) {
  const candidate = A.change(A.clone(base, options), fn);
  const changes = A.getChanges(base, candidate);
  A.free(candidate);
  return changes;
}

function syncMessage(changes) {
  const doc = A.init();
  try {
    const message = A.decodeSyncMessage(A.generateSyncMessage(doc, A.initSyncState())[1]);
    message.changes = changes;
    return A.encodeSyncMessage(message);
  } finally {
    A.free(doc);
  }
}

test("mutate persists before adoption and events, returning exact committed changes", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const before = await h.document(id);
  const gate = holdWrites(t, bytes);
  const events = [];
  h.on("change", (event) => events.push(event));
  const write = h.mutate(
    id,
    (d) => {
      d.title = "After";
    },
    { actor },
  );
  await gate.entered;
  assert.equal(h.doc(id), before);
  assert.equal(events.length, 0);
  const old = await stored(bytes, id);
  assert.equal(old.title, "Before");
  A.free(old);
  gate.release();
  const result = await write;
  assert.equal(h.doc(id).title, "After");
  assert.deepEqual(result.heads, A.getHeads(h.doc(id)));
  assert.deepEqual(result.changes, A.getChanges(before, h.doc(id)));
  const saved = await stored(bytes, id);
  assert.deepEqual(A.getHeads(saved), result.heads);
  A.free(saved);
  assert.equal(events.length, 1);
  assert.equal(A.decodeChange(result.changes[0]).actor, actor);
  assert.equal(h.actor(actor), undefined);
  assert.deepEqual(await bytes.list("actor/"), []);
});

test("failed host append leaves connection states untouched; browser operations still sync normally", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const peer = await browser(h, { principal: "account:a" });
  t.after(() => peer.repo.shutdown());
  const handle = await peer.repo.find(urlOf(id));
  await peer.backend.open(id).synchronize();
  await h.durable(id);
  const before = await h.document(id);
  const heads = A.getHeads(before);
  const states = [...h.register(id).conns].map(([conn, state]) => [conn, structuredClone(state)]);
  const changes = recorded(before, (d) => {
    d.title = "Retry";
  });
  let events = 0;
  h.on("change", () => events++);
  bytes.failNext();
  await assert.rejects(h.applyChanges(id, changes));
  for (const [conn, state] of states) assert.deepEqual(h.register(id).conns.get(conn), state);
  assert.equal(events, 0);
  assert.deepEqual(A.getHeads(before), heads);
  assert.deepEqual(A.getHeads(await h.document(id)), heads);
  handle.change((d) => {
    d.blocks.b.richText = "Browser survived";
  });
  await until(() => h.doc(id)?.blocks.b.richText === "Browser survived");
  await h.applyChanges(id, changes);
  await h.durable(id);
  await until(() => handle.doc().title === "Retry");
  assert.equal(handle.doc().blocks.b.richText, "Browser survived");
});

test("failed mutate does not publish its candidate or claim", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const heads = A.getHeads(await h.document(id));
  bytes.failNext();
  await assert.rejects(
    h.mutate(
      id,
      (d) => {
        d.title = "Lost";
      },
      { actor },
    ),
  );
  assert.deepEqual(A.getHeads(await h.document(id)), heads);
  assert.deepEqual(await bytes.list("actor/"), []);
  await h.durable(id);
  assert.equal(h.doc(id).title, "Lost");
});

test("applyChanges replays reversed recorded bytes exactly, refuses missing dependencies, and deduplicates", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  let candidate = A.change(A.clone(base, { actor }), (d) => {
    d.blocks.added = { richText: "First" };
  });
  candidate = A.change(candidate, (d) => {
    d.blocks.added.richText += " second";
  });
  const changes = A.getChanges(base, candidate);
  const heads = A.getHeads(candidate);
  A.free(candidate);
  await assert.rejects(h.applyChanges(id, [changes[1]]), { code: "missing_dependencies" });
  await h.durable(id);
  const result = await h.applyChanges(id, [...changes].reverse());
  assert.deepEqual(result.heads, heads);
  const byHash = (list) => new Map(list.map((bytes) => [A.decodeChange(bytes).hash, bytes]));
  assert.deepEqual(byHash(result.changes), byHash(changes));
  const saved = await stored(bytes, id);
  assert.deepEqual(byHash(A.getChanges(base, saved)), byHash(changes));
  A.free(saved);
  let events = 0;
  h.on("change", () => events++).on("heads-changed", () => events++);
  const seq = h.store.manifest(id).seq;
  assert.deepEqual(await h.applyChanges(id, changes), { heads, changes: [] });
  assert.deepEqual(await h.mutate(id, () => {}, { actor }), { heads, changes: [] });
  assert.equal(h.store.manifest(id).seq, seq);
  assert.equal(events, 0);
});

for (const origin of ["host", "browser"])
  test(`${origin} commits emit patches and readable heads once, including history-only changes`, async (t) => {
    const { h, id } = await fixture(t);
    const peer = raw(h, { principal: "account:a", role: "editor", senderId: "a" });
    t.after(() => peer.link.client.close());
    const events = [];
    const headEvents = [];
    const listener = (event) => events.push({ ...event, readHeads: A.getHeads(h.doc(id)) });
    h.on("change", listener);
    h.on("heads-changed", (event) =>
      headEvents.push({ ...event, readHeads: A.getHeads(h.doc(id)) }),
    );
    for (const [i, field] of ["title", "blocks", "future", null].entries()) {
      const base = await h.document(id);
      const clone = A.clone(base, { actor: origin === "host" ? actor : "ee".repeat(16) });
      const candidate =
        field === null
          ? A.emptyChange(clone)
          : A.change(clone, (d) => {
              if (field === "title") d.title = "Changed";
              if (field === "blocks") d.blocks.b.richText += " more";
              if (field === "future") d.future.push(1);
            });
      const heads = A.getHeads(candidate);
      const changes = A.getChanges(base, candidate);
      A.free(candidate);
      if (origin === "host") await h.applyChanges(id, changes);
      else {
        peer.link.client.send({ t: "sync", doc: id, m: syncMessage(changes), r: i });
        await until(() => peer.frames.some((f) => f.r === i));
      }
      assert.equal(events.length, i + 1);
      assert.equal(headEvents.length, i + 1);
      assert.deepEqual(events[i].heads, heads);
      assert.deepEqual(events[i].readHeads, heads);
      assert.equal("doc" in events[i], false);
      assert.deepEqual(headEvents[i], { id, heads, readHeads: heads });
      assert.equal(changesContent(events[i].patches), field === "title" || field === "blocks");
      if (field) assert.ok(events[i].patches.some((p) => p.path[0] === field));
      else assert.deepEqual(events[i].patches, []);
    }
    h.off("change", listener);
    await h.mutate(id, (d) => {
      d.title = "Detached";
    });
    assert.equal(events.length, 4);
  });

test("durable fences queued writes but not later writes, retrying a preceding failed append", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const gate = holdWrites(t, bytes);
  const first = h.mutate(id, (d) => {
    d.title = "First";
  });
  await gate.entered;
  let complete = false;
  const barrier = h.durable(id).then(() => {
    complete = true;
  });
  const second = h.mutate(id, (d) => {
    d.title = "Second";
  });
  await tick();
  assert.equal(complete, false);
  gate.release();
  const later = holdWrites(t, bytes);
  await first;
  await barrier;
  await later.entered;
  assert.equal(h.doc(id).title, "First");
  later.release();
  await second;

  const changes = recorded(h.doc(id), (d) => {
    d.title = "Recovered";
  });
  bytes.failNext();
  const failed = assert.rejects(h.applyChanges(id, changes));
  const repairedBarrier = h.durable(id);
  const retry = h.applyChanges(id, changes);
  await Promise.all([failed, repairedBarrier, retry]);
  await h.durable(id);
});

test("a rejected browser append does not poison host durability even when the browser never resends", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const changes = recorded(
    base,
    (d) => {
      d.title = "Browser retry";
    },
    { actor: "ee".repeat(16) },
  );
  const peer = raw(h, { principal: "account:a", role: "editor", senderId: "a" });
  t.after(() => peer.link.client.close());
  const gate = holdWrites(t, bytes);
  peer.link.client.send({ t: "sync", doc: id, m: syncMessage(changes), r: 1 });
  await gate.entered;
  const barrier = h.durable(id);
  bytes.failNext();
  gate.release();
  await barrier;
  await until(() => peer.frames.some((f) => f.t === "refused"));
  assert.equal(h.doc(id).title, "Before");
  await h.mutate(id, (d) => {
    d.future.push("host");
  });
  await h.durable(id);
  assert.equal(h.doc(id).title, "Before");
  assert.deepEqual(h.doc(id).future, ["host"]);
});

test("ambiguous append reload repairs durable without rewriting recorded bytes or losing claims", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const peer = await browser(h, { principal: "account:a" });
  t.after(() => peer.repo.shutdown());
  const handle = await peer.repo.find(urlOf(id));
  await peer.backend.open(id).synchronize();
  await h.durable(id);
  const events = [];
  const headEvents = [];
  h.on("change", (event) => events.push(event));
  h.on("heads-changed", (event) => headEvents.push(event));
  const legacyActor = "ef".repeat(16);
  const changes = recorded(
    base,
    (d) => {
      d.title = "Committed";
    },
    { actor: legacyActor },
  );
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async (entries) => {
    await save(entries);
    throw Error("lost response");
  };
  await assert.rejects(h.applyChanges(id, changes), /lost response/);
  assert.equal(events.length, 0);
  bytes.saveMany = save;
  await h.durable(id);
  assert.equal(h.doc(id).title, "Committed");
  assert.equal(h.actor(legacyActor).host, true);
  const seq = h.store.manifest(id).seq;
  assert.deepEqual((await h.applyChanges(id, changes)).changes, []);
  assert.equal(h.store.manifest(id).seq, seq);
  await until(() => handle.doc().title === "Committed");
  await peer.backend.open(id).synchronize();
  await h.durable(id);
  assert.equal(events.length, 1);
  assert.equal(headEvents.length, 1);
  assert.deepEqual(events[0].heads, A.getHeads(handle.doc()));
  assert.deepEqual(headEvents[0], { id, heads: events[0].heads });
  assert.ok(changesContent(events[0].patches));
});

test("host mutation fans out to connected browsers", async (t) => {
  const { h, id } = await fixture(t);
  const peers = await Promise.all([
    browser(h, { principal: "account:a" }),
    browser(h, { principal: "account:b" }),
  ]);
  for (const peer of peers) t.after(() => peer.repo.shutdown());
  const handles = await Promise.all(peers.map((peer) => peer.repo.find(urlOf(id))));
  const { heads } = await h.mutate(
    id,
    (d) => {
      d.title = "Fan out";
    },
    { actor },
  );
  await until(() => handles.every((handle) => handle.doc().title === "Fan out"));
  for (const handle of handles) assert.deepEqual(A.getHeads(handle.doc()), heads);
});

test("ephemeral events carry admitted envelopes and host-stamped sender, not forged identity", async (t) => {
  const { h, id } = await fixture(t);
  const peer = raw(h, { principal: "account:a", role: "editor", senderId: "actual" });
  t.after(() => peer.link.client.close());
  const seen = [];
  const listener = (event) => seen.push(event);
  h.on("ephemeral", listener);
  const message = {
    messageId: "selection",
    origin: { kind: "repo", id: "forged" },
    payload: new Uint8Array([1]),
  };
  peer.link.client.send({ t: "eph", doc: id, e: message, sender: { id: "forged" } });
  await until(() => seen.length);
  assert.deepEqual(seen, [{ id, senderId: "actual", message }]);
  h.policy.ephemeral = () => false;
  peer.link.client.send({ t: "eph", doc: id, e: message });
  await tick();
  assert.equal(seen.length, 1);
  h.policy.ephemeral = () => true;
  h.off("ephemeral", listener);
  peer.link.client.send({ t: "eph", doc: id, e: message });
  await tick();
  assert.equal(seen.length, 1);
});

for (const origin of ["host", "browser"])
  test(`borrowed snapshots survive ${origin} replacement across awaits`, async (t) => {
    const { h, id } = await fixture(t);
    const before = await h.document(id);
    const heads = A.getHeads(before);
    const expected = structuredClone(before);
    if (origin === "host")
      await h.mutate(id, (d) => {
        d.title = "Replacement";
      });
    else {
      const peer = await browser(h, { principal: "account:a" });
      t.after(() => peer.repo.shutdown());
      const handle = await peer.repo.find(urlOf(id));
      handle.change((d) => {
        d.title = "Replacement";
      });
      await until(() => h.doc(id)?.title === "Replacement");
    }
    await tick();
    assert.deepEqual(A.getHeads(before), heads);
    assert.deepEqual(A.view(before, heads), expected);
    const clone = A.clone(before);
    assert.deepEqual(clone, expected);
    A.free(clone);
  });

test("observer exceptions do not reject commits or prevent later listeners", async (t) => {
  const { h, id } = await fixture(t);
  let count = 0;
  h.on("change", () => {
    throw Error("observer");
  });
  h.on("change", () => {
    count++;
  });
  await h.mutate(id, (d) => {
    d.title = "Committed";
  });
  await h.durable(id);
  assert.equal(count, 1);
});

test("a persistent storage failure retains pending bytes and prevents the next mutator from running", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const first = recorded(base, (d) => {
    d.title = "First";
  });
  const second = recorded(
    base,
    (d) => {
      d.future.push(1);
    },
    { actor: "ac".repeat(16) },
  );
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async () => {
    throw Error("offline");
  };
  t.after(() => {
    bytes.saveMany = save;
  });
  await assert.rejects(h.applyChanges(id, first));
  let ran = false;
  await assert.rejects(
    h.mutate(id, () => {
      ran = true;
    }),
  );
  assert.equal(ran, false);
  await assert.rejects(h.durable(id));
  bytes.saveMany = save;
  await h.applyChanges(id, second);
  await h.durable(id);
  assert.equal(h.doc(id).title, "First");
  assert.deepEqual(h.doc(id).future, [1]);
});

for (const recovery of ["mutate", "durable"])
  test(`failed mutate exposes exact bytes and ${recovery} repairs them through public APIs`, async (t) => {
    const { h, bytes, id, base } = await fixture(t);
    let attempted;
    bytes.failNext();
    await assert.rejects(
      h.mutate(
        id,
        (d) => {
          d.title = "Original attempt";
        },
        { actor },
      ),
      (error) => {
        attempted = error.changes.map((bytes) => bytes.slice());
        assert.equal(error.queued, true);
        // The error's buffers belong to the caller, not the recovery queue.
        error.changes[0].fill(0);
        return true;
      },
    );
    const hashes = attempted.map((bytes) => A.decodeChange(bytes).hash);
    if (recovery === "durable") await h.durable(id);
    const second = await h.mutate(id, (d) => {
      d.future.push(1);
    });
    await h.durable(id);
    const saved = await stored(bytes, id);
    assert.equal(saved.title, "Original attempt");
    assert.deepEqual(saved.future, [1]);
    assert.ok(A.hasHeads(saved, [...hashes, ...second.heads]));
    const actual = A.getChanges(base, saved);
    assert.equal(actual.length, 2);
    for (const change of attempted)
      assert.deepEqual(
        actual.find((bytes) => A.decodeChange(bytes).hash === A.decodeChange(change).hash),
        change,
      );
    A.free(saved);
  });

test("seed repairs pending trusted heads and publishes the snapshot once", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const reader = await browser(h, { principal: "account:reader" });
  t.after(() => reader.repo.shutdown());
  const handle = await reader.repo.find(urlOf(id));
  await reader.backend.open(id).synchronize();
  await h.durable(id);
  const candidate = A.change(A.clone(base), (d) => {
    d.title = "Seed repair";
  });
  t.after(() => A.free(candidate));
  const changes = A.getChanges(base, candidate);
  bytes.failNext();
  await assert.rejects(h.applyChanges(id, changes));
  const events = [];
  h.on("change", (event) => events.push(event));
  await h.seed(id, "page", candidate);
  await h.durable(id);
  await h.seed(id, "page", candidate);
  await h.durable(id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].heads, A.getHeads(candidate));
  assert.ok(changesContent(events[0].patches));
  await until(() => handle.doc().title === "Seed repair");
  const saved = await stored(bytes, id);
  assert.ok(A.hasHeads(saved, A.getHeads(candidate)));
  A.free(saved);
});

test("ambiguous browser admission publishes on reload and duplicate delivery emits nothing", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const reader = await browser(h, { principal: "account:reader" });
  t.after(() => reader.repo.shutdown());
  const handle = await reader.repo.find(urlOf(id));
  await reader.backend.open(id).synchronize();
  await h.durable(id);
  const writer = raw(h, { principal: "account:writer", role: "editor", senderId: "writer" });
  t.after(() => writer.link.client.close());
  const changes = recorded(
    base,
    (d) => {
      d.title = "Ambiguous browser";
    },
    { actor: "ee".repeat(16) },
  );
  const events = [];
  const heads = [];
  h.on("change", (event) => events.push(event));
  h.on("heads-changed", (event) => heads.push(event));
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async (entries) => {
    await save(entries);
    throw Error("lost response");
  };
  t.after(() => {
    bytes.saveMany = save;
  });
  writer.link.client.send({ t: "sync", doc: id, m: syncMessage(changes), r: 1 });
  await until(() => writer.frames.some((frame) => frame.t === "refused"));
  assert.equal(events.length, 0);
  bytes.saveMany = save;
  await h.document(id);
  await until(() => handle.doc().title === "Ambiguous browser");
  writer.link.client.send({ t: "sync", doc: id, m: syncMessage(changes), r: 2 });
  await until(() => writer.frames.some((frame) => frame.r === 2));
  await h.durable(id);
  assert.equal(events.length, 1);
  assert.equal(heads.length, 1);
  assert.deepEqual(events[0].heads, A.getHeads(handle.doc()));
  assert.ok(changesContent(events[0].patches));
});

test("change listeners do not borrow roots; only explicit document reads defer freeing", async (t) => {
  const { h, id } = await fixture(t);
  const events = [];
  h.on("change", (event) => events.push(event));
  const freed = h.stats.freed;
  const snapshots = [];
  const count = 20;
  for (let i = 0; i < count; i++) {
    if (i === 3 || i === 12) snapshots.push(h.doc(id));
    await h.mutate(id, (d) => {
      d.title = `Mutation ${i}`;
    });
  }
  assert.equal(events.length, count);
  assert.ok(events.every((event) => !Object.hasOwn(event, "doc")));
  assert.equal(h.stats.freed - freed, count - snapshots.length);
  for (const snapshot of snapshots) {
    const heads = A.getHeads(snapshot);
    assert.deepEqual(A.view(snapshot, heads), snapshot);
    const clone = A.clone(snapshot);
    assert.deepEqual(A.getHeads(clone), heads);
    A.free(clone);
  }
});

test("mutators run against the queue's current root; a thrown callback frees its clone without poisoning durability", async (t) => {
  const { h, id } = await fixture(t);
  const freed = h.stats.freed;
  await assert.rejects(
    h.mutate(id, () => {
      throw Error("callback");
    }),
    /callback/,
  );
  assert.equal(h.stats.freed, freed + 1);
  await h.durable(id);
  const writes = [" one", " two"].map((text) =>
    h.mutate(id, (d) => {
      d.title += text;
    }),
  );
  await Promise.all(writes);
  assert.equal(h.doc(id).title, "Before one two");
});

test("pending trusted writes never retry ahead of viewer or writer browser frames", async (t) => {
  const { h, bytes, id, base } = await fixture(t);
  const bridge = raw(h, { trusted: true });
  t.after(() => bridge.link.client.close());
  const pending = recorded(base, (d) => {
    d.title = "Pending";
  });
  const save = bytes.saveMany.bind(bytes);
  let attempts = 0;
  bytes.saveMany = async () => {
    attempts++;
    throw Error("offline");
  };
  t.after(() => {
    bytes.saveMany = save;
  });
  bridge.link.client.send({ t: "sync", doc: id, m: syncMessage(pending), r: 1 });
  await until(() => bridge.frames.some((f) => f.t === "refused"));
  const viewer = raw(h, { principal: "account:viewer", role: "viewer", senderId: "viewer" });
  t.after(() => viewer.link.client.close());
  viewer.link.client.send({ t: "sync", doc: id, m: syncMessage([]), r: 1 });
  await until(() => viewer.frames.some((f) => f.r === 1));
  assert.equal(viewer.frames.find((f) => f.r === 1).t, "sync");
  assert.equal(attempts, 1, "viewer did not retry pending writes");
  bytes.saveMany = save;
  const writer = raw(h, { principal: "account:writer", role: "editor", senderId: "writer" });
  t.after(() => writer.link.client.close());
  const changes = recorded(
    base,
    (d) => {
      d.future.push("browser");
    },
    { actor: "ee".repeat(16) },
  );
  writer.link.client.send({ t: "sync", doc: id, m: syncMessage(changes), r: 1 });
  await until(() => writer.frames.some((f) => f.r === 1));
  assert.equal(writer.frames.find((f) => f.r === 1).t, "sync");
  assert.equal(h.doc(id).title, "Before", "writer did not retry pending writes either");
  await h.durable(id);
  assert.equal(h.doc(id).title, "Pending");
  assert.deepEqual(h.doc(id).future, ["browser"]);
});

test("first load after restart establishes published heads without recording content activity", async (t) => {
  const { bytes, id } = await fixture(t);
  const restarted = await host({ bytes });
  restarted.hostActorPrefix = "ab".repeat(8);
  restarted.register(id);
  const changes = [];
  const heads = [];
  restarted.on("change", (event) => changes.push(event));
  restarted.on("heads-changed", (event) => heads.push(event));
  await restarted.document(id);
  await restarted.durable(id);
  assert.deepEqual(changes, []);
  assert.deepEqual(heads, []);
  await restarted.mutate(id, (d) => {
    d.title = "Actual edit";
  });
  assert.equal(changes.length, 1);
  assert.equal(heads.length, 1);
  assert.ok(changes[0].patches.every((patch) => patch.path[0] === "title"));
});

test("mutate requires its host namespace and generates unique actors without claims", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const prefix = h.hostActorPrefix;
  h.hostActorPrefix = undefined;
  assert.throws(() => h.mutate(id, () => {}), /requires hostActorPrefix/);
  h.hostActorPrefix = prefix;
  assert.throws(() => h.mutate(id, () => {}, { actor: "ee".repeat(16) }), /must belong/);
  const actors = [];
  for (let i = 0; i < 5; i++) {
    const result = await h.mutate(id, (d) => {
      d.future.push(i);
    });
    actors.push(A.decodeChange(result.changes[0]).actor);
  }
  assert.equal(new Set(actors).size, 5);
  assert.ok(
    actors.every((value) => value.startsWith(prefix) && value.length === prefix.length + 16),
  );
  assert.deepEqual(await bytes.list("actor/"), []);
});

for (const api of ["mutate", "applyChanges"])
  test(`${api} passes the trusted gate before persistence and refuses without adoption`, async (t) => {
    const { h, bytes, id, base } = await fixture(t);
    const seq = h.store.manifest(id).seq;
    let calls = 0;
    h.policy.admitTrusted = (doc, live, fresh, preview) => {
      calls++;
      assert.equal(doc.id, id);
      assert.equal(live.title, "Before");
      assert.equal(preview.title, "Blocked");
      assert.equal(fresh.length, 1);
      throw Error("history_capacity");
    };
    const edit = (d) => {
      d.title = "Blocked";
    };
    await assert.rejects(
      api === "mutate" ? h.mutate(id, edit) : h.applyChanges(id, recorded(base, edit)),
      (error) => {
        assert.equal(error.message, "history_capacity");
        assert.equal(error.queued, undefined);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(h.store.manifest(id).seq, seq);
    assert.equal(h.doc(id).title, "Before");
    assert.deepEqual(await bytes.list("actor/"), []);
    await h.durable(id);
  });

test("queued rejection directs callers to durable rather than re-running a non-idempotent callback", async (t) => {
  const { h, bytes, id } = await fixture(t);
  let calls = 0;
  bytes.failNext();
  await assert.rejects(
    h.mutate(id, (d) => {
      calls++;
      d.future.push(1);
    }),
    (error) => {
      assert.equal(error.queued, true);
      assert.equal(error.changes.length, 1);
      return true;
    },
  );
  await h.durable(id);
  await h.durable(id);
  assert.equal(calls, 1);
  assert.deepEqual(h.doc(id).future, [1]);
});

for (const api of ["mutate", "applyChanges"])
  test(`${api} distinguishes a failed prerequisite retry from its own queued changes`, async (t) => {
    const { h, bytes, id, base } = await fixture(t);
    const save = bytes.saveMany.bind(bytes);
    bytes.saveMany = async () => {
      throw Error("offline");
    };
    t.after(() => {
      bytes.saveMany = save;
    });
    let firstChanges;
    let firstCalls = 0;
    await assert.rejects(
      h.mutate(id, (d) => {
        firstCalls++;
        d.future.push("A");
      }),
      (error) => {
        assert.equal(error.queued, true);
        firstChanges = error.changes;
        return true;
      },
    );
    const secondChanges = recorded(base, (d) => {
      d.blocks.b.richText += " B";
    });
    let secondCalls = 0;
    const second = () =>
      api === "mutate"
        ? h.mutate(id, (d) => {
            secondCalls++;
            d.blocks.b.richText += " B";
          })
        : h.applyChanges(id, secondChanges);
    await assert.rejects(second(), (error) => {
      assert.equal(error.code, "pending_retry_failed");
      assert.equal(error.queued, false);
      assert.equal(Object.hasOwn(error, "changes"), false);
      assert.equal(error.cause.message, "offline");
      assert.equal(error.cause.queued, true);
      assert.deepEqual(error.cause.changes, firstChanges);
      return true;
    });
    assert.equal(secondCalls, 0);
    const unchanged = await h.document(id);
    assert.equal(unchanged.blocks.b.richText, "Text");
    assert.deepEqual(unchanged.future, []);
    bytes.saveMany = save;
    const result = await second();
    await h.durable(id);
    const saved = await stored(bytes, id);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, api === "mutate" ? 1 : 0);
    assert.deepEqual(saved.future, ["A"]);
    assert.equal(saved.blocks.b.richText, "Text B");
    const expected = [...firstChanges, ...result.changes];
    assert.equal(A.getChanges(base, saved).length, 2);
    assert.ok(
      A.hasHeads(
        saved,
        expected.map((change) => A.decodeChange(change).hash),
      ),
    );
    if (api === "applyChanges") assert.deepEqual(result.changes, secondChanges);
    A.free(saved);
  });

test("string storage rejection is wrapped, invalidates live state, and retains replayable bytes", async (t) => {
  const { h, bytes, id } = await fixture(t);
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async () => {
    throw "offline";
  };
  t.after(() => {
    bytes.saveMany = save;
  });
  let changes;
  await assert.rejects(
    h.mutate(id, (d) => {
      d.title = "Recovered";
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "offline");
      assert.equal(error.cause, "offline");
      assert.equal(error.queued, true);
      changes = error.changes;
      return true;
    },
  );
  assert.equal(h.doc(id), null, "failed append invalidates cached live history");
  bytes.saveMany = save;
  await h.durable(id);
  assert.equal(h.doc(id).title, "Recovered");
  assert.ok(
    A.hasHeads(
      h.doc(id),
      changes.map((change) => A.decodeChange(change).hash),
    ),
  );
});
