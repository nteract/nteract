import assert from "node:assert/strict";
import { it } from "node:test";
import * as A from "@automerge/automerge";
import { Repo, documentIdToBinary, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PlainByteStore, treeOf } from "../worker/plain-sync.mjs";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { handleContract } from "./handle-contract.mjs";
import { PlainHostStorage, plainHostFixture } from "./plain-host-fixture.mjs";
import { framePipe } from "./wire.mjs";
import { handleLifecycle } from "./host-handle.mjs";

handleContract("HostRepo adapter", async (t) => {
  const documentId = interpretAsDocumentId(new Uint8Array(16).fill(1));
  let storage = new PlainHostStorage();
  const documents = new Map([[documentId, "page"]]);
  const seed = A.from({
    title: "Contract Page",
    blocks: { b: { richText: "Text" } },
    future: { keep: [1, 2] },
  });
  let plain = await plainHostFixture({
    documentId,
    storage,
    bytes: A.save(seed),
    heads: A.getHeads(seed),
  });
  A.free(seed);
  const hosts = [plain];
  const peers = [];
  t.after(async () => {
    for (const repo of peers) await repo.shutdown();
    for (const host of hosts) await host.close();
  });
  const handle = await plain.repo.find(documentId);
  await plain.flush([documentId]);
  return {
    repo: plain.repo,
    handle,
    documentId,
    flush: (ids) => plain.flush(ids),
    prepare: async (id, kind) => {
      documents.set(id, kind);
      plain.serve(id, kind);
    },
    forget: (ids) => plain.forget(ids),
    closed: async () => {
      await Promise.all(
        plain.host
          .connections()
          .map((conn) => new Promise((resolve) => conn.transport.onClose(resolve))),
      );
      return plain.host.connections().every((conn) => conn.closed);
    },
    stored: async (id) => {
      const stored = await new DocStore(new PlainByteStore(storage)).read(treeOf(id));
      if (!stored) return null;
      return A.load(
        new Uint8Array(Buffer.concat([stored.snapshot, ...stored.chunks].filter(Boolean))),
      );
    },
    reopen: async () => {
      await plain.close();
      // Copy only persisted values, not cached manifests, handles or live docs.
      const saved = await storage.list();
      storage = new PlainHostStorage();
      await storage.put(Object.fromEntries(saved));
      plain = await plainHostFixture({ documentId, storage });
      for (const [id, kind] of documents) plain.serve(id, kind);
      hosts.push(plain);
      return plain.repo;
    },
    rejectAdmission: () => {
      const host = plain.host;
      const applyChanges = host.applyChanges.bind(host);
      let entered;
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      host.applyChanges = async () => {
        entered();
        throw Error("contract admission rejected");
      };
      return {
        entered: waiting,
        release: () => {
          host.applyChanges = applyChanges;
        },
      };
    },
    rejectWrites: () => {
      const put = storage.put.bind(storage);
      let entered;
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      storage.put = async () => {
        entered();
        throw Error("contract storage rejected");
      };
      return {
        entered: waiting,
        release: () => {
          storage.put = put;
        },
      };
    },
    holdAdmission: () => {
      const host = plain.host;
      const applyChanges = host.applyChanges.bind(host);
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      host.applyChanges = async (...args) => {
        entered();
        await gate;
        return applyChanges(...args);
      };
      return {
        entered: waiting,
        release: () => {
          host.applyChanges = applyChanges;
          release();
        },
      };
    },
    holdWrites: () => {
      const put = storage.put.bind(storage);
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      storage.put = async (...args) => {
        entered();
        await gate;
        return put(...args);
      };
      return {
        entered: waiting,
        release: () => {
          storage.put = put;
          release();
        },
      };
    },
    peer: async (id = documentId) => {
      const backend = await AutomergeSyncBackend.load({
        store: new DocStore(new MemoryByteStore()),
      });
      const repo = new Repo({ backend });
      peers.push(repo);
      const link = framePipe();
      const senderId = "b-44444444-4444-4444-8444-444444444444";
      plain.host.accept(link.host, {
        // These cases test handle delivery, not comment-authority validation.
        // A trusted independent peer can author minimal comments test data.
        trusted: documents.get(id) === "comments",
        principal: "user:contract",
        senderId,
        identity: { principal: "user:contract" },
        features: [],
        access: { role: "owner", canWrite: true, canComment: true, generation: 0, trashed: false },
      });
      backend.addConnection(link.client, { hostId: "pages-host" });
      const peerHandle = await repo.find(id);
      const settle = async () => {
        await repo.flush([id]);
        await bounded(plain.flush([id]), "host flush before peer round");
        assert.equal((await backend.synchronizeTree(documentIdToBinary(id))).outcome, "complete");
        await bounded(plain.flush([id]), "host flush after peer round");
        // synchronizeTree completes the backend round. Repo event consumption
        // is separate: drain it before callers assert delivery or detachment.
        const hosted = await plain.repo.find(id);
        await untilHeads(hosted, A.getHeads(peerHandle.doc()));
        await untilHeads(peerHandle, A.getHeads(hosted.doc()));
      };
      await settle();
      return { handle: peerHandle, senderId, settle };
    },
  };
});

async function untilHeads(handle, heads) {
  if (A.hasHeads(handle.doc(), heads)) return;
  await new Promise((resolve, reject) => {
    const changed = () => {
      if (!A.hasHeads(handle.doc(), heads)) return;
      clearTimeout(timer);
      handle.off("heads-changed", changed);
      resolve();
    };
    const timer = setTimeout(() => {
      handle.off("heads-changed", changed);
      reject(Error("Repo did not consume synchronized heads"));
    }, 5_000);
    handle.on("heads-changed", changed);
    changed();
  });
}

async function bounded(work, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("queued updates confirm durable bytes without running callbacks twice", async (t) => {
  const documentId = interpretAsDocumentId(new Uint8Array(16).fill(10));
  const plain = await plainHostFixture({ documentId });
  t.after(() => plain.close());
  const handle = await plain.repo.find(documentId);
  await handle.change((d) => {
    d.items = [];
  });
  const put = plain.storage.put.bind(plain.storage);
  let failures = 1;
  plain.storage.put = async (...args) => {
    if (failures-- > 0) throw Error("offline");
    return put(...args);
  };
  let callbacks = 0;
  await handle.change((d) => {
    callbacks++;
    d.items.push("first");
  });
  assert.equal(callbacks, 1);
  assert.deepEqual(handle.doc().items, ["first"]);
  failures = 10;
  await assert.rejects(
    handle.change((d) => {
      callbacks++;
      d.items.push("second");
    }),
    { queued: true },
  );
  await assert.rejects(
    handle.change((d) => {
      callbacks++;
      d.items.push("third");
    }),
    { code: "pending_retry_failed", queued: false },
  );
  failures = 0;
  await handle.change((d) => {
    callbacks++;
    d.items.push("third");
  });
  assert.deepEqual(handle.doc().items, ["first", "second", "third"]);
  assert.equal(callbacks, 3);
  assert.equal(plain.host.actors().size, 0);
});

it("handle lifecycle covers every state and event", () => {
  const table = {
    open: { drain: "draining", finish: "open" },
    draining: { drain: "draining", finish: "closed" },
    closed: { drain: "closed", finish: "closed" },
  };
  for (const [state, events] of Object.entries(table))
    for (const [event, expected] of Object.entries(events))
      assert.equal(handleLifecycle(state, event), expected);
});

it("adapter has one live root, stable handles, and serial updates with fresh host actors", async (t) => {
  const documentId = interpretAsDocumentId(new Uint8Array(16).fill(7));
  const plain = await plainHostFixture({ documentId });
  t.after(() => plain.close());
  const [handle, again] = await Promise.all([
    plain.repo.find(documentId),
    plain.repo.find(documentId),
  ]);
  assert.equal(handle, again);
  assert.equal(handle.doc(), plain.host.doc(treeOf(documentId)));
  assert.equal(plain.host.connections().length, 0);
  await Promise.all(
    Array.from({ length: 8 }, () =>
      handle.change(
        (doc) => {
          doc.count = (doc.count ?? 0) + 1;
        },
        { time: 42 },
      ),
    ),
  );
  assert.equal(handle.doc().count, 8);
  const changes = A.getAllChanges(handle.doc()).map(A.decodeChange);
  assert.equal(new Set(changes.map((change) => change.actor)).size, 8);
  assert.ok(
    changes.every((change) => change.actor.startsWith(plain.hostActorPrefix) && change.time === 42),
  );
  assert.equal(plain.host.actors().size, 0);
  const before = handle.doc();
  const actor = plain.hostActorPrefix + "ab".repeat(8);
  const recorded = A.change(A.clone(before, { actor }), (doc) => {
    doc.recorded = true;
  });
  const bytes = A.getChanges(before, recorded);
  const heads = A.getHeads(recorded);
  A.free(recorded);
  await handle.update((doc) => A.applyChanges(doc, bytes)[0]);
  assert.deepEqual(A.getHeads(handle.doc()), heads);
  assert.equal(plain.host.actor(actor), undefined);
  const controller = new AbortController();
  controller.abort(Error("cancelled"));
  await assert.rejects(plain.repo.find(documentId, { signal: controller.signal }), /cancelled/);
});

it("a failed deletion can retry without restoring history or accepting retained handles", async (t) => {
  const documentId = interpretAsDocumentId(new Uint8Array(16).fill(8));
  const plain = await plainHostFixture({ documentId });
  t.after(() => plain.close());
  const handle = await plain.repo.find(documentId);
  await handle.change((doc) => {
    doc.value = 1;
  });
  const remove = plain.storage.delete.bind(plain.storage);
  plain.storage.delete = async () => {
    throw Error("delete failed");
  };
  await assert.rejects(plain.repo.delete(documentId), /delete failed/);
  assert.throws(() => handle.change(() => {}), /deleted/);
  plain.storage.delete = remove;
  await plain.repo.delete(documentId);
  assert.equal(await plain.host.store.read(treeOf(documentId)), null);
  assert.equal(plain.host.doc(treeOf(documentId)), null);
});

it("abort during a cold find rejects that caller without cancelling the shared load", async (t) => {
  const documentId = interpretAsDocumentId(new Uint8Array(16).fill(9));
  const plain = await plainHostFixture({ documentId });
  t.after(() => plain.close());
  const get = plain.storage.get.bind(plain.storage);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(release);
  plain.storage.get = async (...args) => {
    await gate;
    return get(...args);
  };
  const controller = new AbortController();
  const finding = plain.repo.find(documentId, { signal: controller.signal });
  controller.abort(Error("cancelled"));
  await assert.rejects(finding, /cancelled/);
  release();
  const handle = await plain.repo.find(documentId);
  assert.deepEqual(handle.doc(), {});
});
