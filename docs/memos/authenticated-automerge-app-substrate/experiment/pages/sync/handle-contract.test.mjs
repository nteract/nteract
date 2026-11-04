import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Repo, documentIdToBinary, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PlainByteStore, treeOf } from "../worker/plain-sync.mjs";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { handleContract } from "./handle-contract.mjs";
import { PlainHostStorage, plainHostFixture } from "./plain-host-fixture.mjs";
import { framePipe } from "./wire.mjs";

handleContract("PlainSync trusted Repo handle", async (t) => {
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
    knownFailures: {
      // Reproduced with a 60-second wait on 55e993b8a: after a host io
      // refusal, incoming peer history and recorded replay both reach doc(),
      // but the next PlainSync.flush never settles. Keep the failing gate
      // executable; the adapter fixture must not inherit this exception.
      storageRetry:
        "Bridge storage retry hangs in PlainSync.flush after io refusal and peer delivery (55e993b8a)",
    },
    handle,
    documentId,
    flush: (ids) => plain.flush(ids),
    prepare: async (id, kind) => {
      documents.set(id, kind);
      plain.serve(id, kind);
      await plain.prime(id);
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
      const backend = plain.backend;
      const store = backend.store.bind(backend);
      let entered;
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      backend.store = async () => {
        entered();
        throw Error("contract admission rejected");
      };
      return {
        entered: waiting,
        release: () => {
          backend.store = store;
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
      const backend = plain.backend;
      const store = backend.store.bind(backend);
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      backend.store = async (...args) => {
        entered();
        await gate;
        return store(...args);
      };
      return {
        entered: waiting,
        release: () => {
          backend.store = store;
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
