import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as A from "@automerge/automerge";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { changesContent } from "../worker/content-activity.mjs";
import { commentsDocumentId } from "../worker/comments-store.mjs";

/**
 * Page host handle contract, call sites pinned to main 55e993b8a.
 *
 * makeFixture(t) returns {repo, handle, documentId, peer(id), prepare(id, kind),
 * flush(ids), stored(id), reopen(), holdWrites(), holdAdmission(),
 * rejectAdmission(), rejectWrites(), forget(ids), closed()}.
 * repo is the implementation under test, not a wrapper that supplies missing
 * semantics. peer() returns an independent {handle, senderId, settle()} client.
 * flush is the complete host durability barrier (Repo.flush alone is not one).
 * stored reads fresh storage; reopen copies persisted bytes into fresh storage
 * and returns an empty-cache repo, serving all prepared IDs without finding them.
 * Barriers/rejection return {entered, release}; closed checks transport teardown.
 * The fixture registers teardown on t. No private Repo/SyncHost state is part
 * of this contract; a replacement host adapter can provide the same fixture.
 */
export function handleContract(name, makeFixture) {
  describe(name, { timeout: 60_000 }, () => {
    // worker/index.mjs:3485,3491,4496,4681: load and title projection.
    it("find returns a ready document with stable identity and synchronous doc()", async (t) => {
      const f = await makeFixture(t);
      const handle = await f.repo.find(f.documentId);
      assert.equal(handle.documentId, f.documentId);
      assert.equal(handle.doc().title, "Contract Page");
      assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(f.handle.doc()));
    });

    // worker/mutations.mjs:243-246: awaiting update must await admitted history,
    // not merely invoke the mutator and leave an unobserved persistence task.
    it("update does not resolve before its local admission completes", async (t) => {
      const f = await makeFixture(t);
      const gate = f.holdAdmission();
      t.after(gate.release);
      let resolved = false;
      const update = f.handle
        .update((doc) =>
          A.change(doc, (d) => {
            d.title = "Admitted";
          }),
        )
        .then(() => {
          resolved = true;
        });
      await gate.entered;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(resolved, false);
      gate.release();
      await update;
      assert.equal(f.handle.doc().title, "Admitted");
    });

    // worker/mutations.mjs:243-246,268-271,289-308: apply recorded bytes, then flush.
    it("awaited update adopts recorded changes and preserves unknown data and old views", async (t) => {
      const f = await makeFixture(t);
      const before = f.handle.doc();
      const candidate = A.change(A.clone(before), (d) => {
        d.title = "Recorded edit";
      });
      const changes = A.getChanges(before, candidate);
      const heads = A.getHeads(candidate);
      A.free(candidate);
      const update = f.handle.update((doc) => A.applyChanges(doc, changes)[0]);
      assert.equal(typeof update.then, "function");
      await update;
      assert.ok(A.hasHeads(f.handle.doc(), heads));
      assert.equal(f.handle.doc().title, "Recorded edit");
      assert.equal(before.title, "Contract Page");
      assert.deepEqual(f.handle.doc().future, { keep: [1, 2] });
    });

    // worker/index.mjs:5729-5743 retains a doc across an await. The adapter
    // cannot free borrowed snapshots when sync/host.mjs:339 replaces its doc.
    for (const origin of ["host", "peer"])
      it(`retained snapshots support Automerge reads after a ${origin} replacement`, async (t) => {
        const f = await makeFixture(t);
        const peer = await f.peer();
        const before = f.handle.doc();
        const heads = A.getHeads(before);
        const expected = structuredClone(before);
        const writer = origin === "host" ? f.handle : peer.handle;
        await writer.update((doc) =>
          A.change(doc, (d) => {
            d.title = "Replacement";
          }),
        );
        await peer.settle();
        assert.equal(f.handle.doc().title, "Replacement");
        assert.notDeepEqual(A.getHeads(f.handle.doc()), heads);
        assert.deepEqual(A.getHeads(before), heads);
        const clone = A.clone(before);
        try {
          assert.deepEqual(clone, expected);
          assert.deepEqual(A.getHeads(clone), heads);
          assert.deepEqual(A.view(before, heads), expected);
        } finally {
          A.free(clone);
        }
      });

    // worker/mutations.mjs:268-271: recovery can replay an already applied entry.
    it("replaying settled changes emits no content activity", async (t) => {
      const f = await makeFixture(t);
      const peer = await f.peer();
      const before = f.handle.doc();
      const candidate = A.change(A.clone(before), (d) => {
        d.title = "Replay";
      });
      const changes = A.getChanges(before, candidate);
      A.free(candidate);
      await f.handle.update((doc) => A.applyChanges(doc, changes)[0]);
      await peer.settle();
      const heads = A.getHeads(f.handle.doc());
      let events = 0;
      f.handle.on("change", ({ patches }) => {
        if (changesContent(patches)) events++;
      });
      await f.handle.update((doc) => A.applyChanges(doc, changes)[0]);
      await peer.settle();
      assert.deepEqual(A.getHeads(f.handle.doc()), heads);
      assert.equal(events, 0);
    });

    // worker/index.mjs:3569-3580; worker/content-activity.mjs:92.
    for (const origin of ["host", "peer"])
      it(`${origin} changes emit content patches; off detaches the listener`, async (t) => {
        const f = await makeFixture(t);
        const peer = await f.peer();
        const writer = origin === "peer" ? peer.handle : f.handle;
        const seen = [];
        const listener = ({ patches }) => seen.push(patches);
        f.handle.on("change", listener);
        for (const field of ["title", "blocks", "future"]) {
          const event = nextEvent(t, f.handle, "change", ({ patches }) =>
            patches.some((patch) => patch.path[0] === field),
          );
          await writer.update((doc) =>
            A.change(doc, (d) => {
              if (field === "blocks") d.blocks.b.richText += " more";
              else if (field === "future") d.future.keep.push(3);
              else d.title = `${origin} title`;
            }),
          );
          const { patches } = await event;
          assert.ok(patches.some((patch) => patch.path[0] === field));
          assert.equal(changesContent(patches), field !== "future");
          await peer.settle();
          assert.equal(f.handle.doc().title, `${origin} title`);
          assert.equal(f.handle.doc().blocks.b.richText, field === "title" ? "Text" : "Text more");
          assert.deepEqual(f.handle.doc().future.keep, field === "future" ? [1, 2, 3] : [1, 2]);
          assert.deepEqual(peer.handle.doc(), f.handle.doc());
          assert.deepEqual(A.getHeads(peer.handle.doc()), A.getHeads(f.handle.doc()));
        }
        const count = seen.length;
        f.handle.off("change", listener);
        await writer.update((doc) =>
          A.change(doc, (d) => {
            d.title = "Detached";
          }),
        );
        await peer.settle();
        assert.equal(f.handle.doc().title, "Detached");
        assert.equal(peer.handle.doc().title, "Detached");
        assert.equal(seen.length, count);
      });

    // worker/index.mjs:6202,6219-6235: /api/saved waits even for history-only changes.
    for (const kind of ["page", "comments"])
      for (const origin of ["host", "peer"])
        for (const historyOnly of [false, true])
          it(`${kind} heads-changed exposes requested heads: ${origin}, ${historyOnly ? "history" : "content"}`, async (t) => {
            const f = await makeFixture(t);
            const handle = kind === "page" ? f.handle : await openComments(f);
            const peer = await f.peer(handle.documentId);
            const writer = origin === "host" ? handle : peer.handle;
            const base = writer.doc();
            const candidate = historyOnly
              ? A.emptyChange(A.clone(base))
              : A.change(A.clone(base), (d) => {
                  if (kind === "page") d.title = "Requested";
                  else d.threads.requested = { messages: {} };
                });
            const heads = A.getHeads(candidate);
            const changes = A.getChanges(base, candidate);
            A.free(candidate);
            let notifications = 0;
            const listener = () => {
              notifications++;
            };
            handle.on("heads-changed", listener);
            // Like waitForHeads: extra notifications may precede the requested
            // revision, but one must arrive while doc() can read that revision.
            const incoming = nextEvent(t, handle, "heads-changed", () => {
              if (!A.hasHeads(handle.doc(), heads)) return false;
              assert.deepEqual(A.getHeads(A.view(handle.doc(), heads)), heads);
              if (!historyOnly) {
                if (kind === "page") assert.equal(handle.doc().title, "Requested");
                else assert.deepEqual(handle.doc().threads.requested, { messages: {} });
              }
              return true;
            });
            await writer.update((doc) => A.applyChanges(doc, changes)[0]);
            await incoming;
            await peer.settle();
            const count = notifications;
            handle.off("heads-changed", listener);
            await writer.update((doc) => A.emptyChange(doc));
            const laterHeads = A.getHeads(writer.doc());
            await peer.settle();
            assert.ok(A.hasHeads(handle.doc(), laterHeads));
            assert.notDeepEqual(laterHeads, heads);
            assert.equal(notifications, count);
          });

    // worker/index.mjs:4263-4266; worker/page-activity.mjs:374-379.
    it("inbound ephemeral messages carry the host-attested senderId and can be detached", async (t) => {
      const f = await makeFixture(t);
      const peer = await f.peer();
      const heads = A.getHeads(f.handle.doc());
      const seen = [];
      const listener = (event) => seen.push(event);
      f.handle.on("ephemeral-message", listener);
      const incoming = nextEvent(
        t,
        f.handle,
        "ephemeral-message",
        (event) => event.message.kind === "selection",
      );
      const message = { kind: "selection", senderId: "forged", nested: { value: 1 } };
      peer.handle.broadcast(message);
      const event = await incoming;
      assert.equal(event.senderId, peer.senderId);
      assert.deepEqual(event.message, message);
      const count = seen.length;
      f.handle.off("ephemeral-message", listener);
      const second = nextEvent(
        t,
        f.handle,
        "ephemeral-message",
        (event) => event.message.kind === "selection-clear",
      );
      peer.handle.broadcast({ kind: "selection-clear" });
      await second;
      assert.equal(seen.length, count);
      assert.deepEqual(A.getHeads(f.handle.doc()), heads);
    });

    // worker/index.mjs:4272,4295,4352,5438,5586: presence, profiles and receipts.
    it("broadcast reaches a peer as pages-host without writing document history", async (t) => {
      const f = await makeFixture(t);
      const peer = await f.peer();
      const heads = A.getHeads(f.handle.doc());
      const incoming = nextEvent(
        t,
        peer.handle,
        "ephemeral-message",
        (event) => event.message.kind === "identity-profiles",
      );
      const message = { kind: "identity-profiles", peerProfiles: {} };
      f.handle.broadcast(message);
      const event = await incoming;
      assert.equal(event.senderId, "pages-host");
      assert.deepEqual(event.message, message);
      assert.deepEqual(A.getHeads(f.handle.doc()), heads);
    });

    // worker/index.mjs:4798-4803,5299-5305; worker/plain-sync.mjs:294-302.
    it("update admits locally; the host flush barrier waits for storage before Saved", async (t) => {
      const f = await makeFixture(t);
      const gate = f.holdWrites();
      t.after(gate.release);
      const update = f.handle.update((doc) =>
        A.change(doc, (d) => {
          d.title = "Durable";
        }),
      );
      await gate.entered;
      let flushed = false;
      const flush = f.flush([f.documentId]).then(() => {
        flushed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(flushed, false);
      // Do not require update to finish before host persistence: a future
      // adapter may await it. Today's bridge only awaits local admission.
      gate.release();
      await update;
      const heads = A.getHeads(f.handle.doc());
      await flush;
      const stored = await f.stored(f.documentId);
      try {
        assert.ok(A.hasHeads(stored, heads));
      } finally {
        A.free(stored);
      }
      const reopened = await f.reopen();
      assert.equal((await reopened.find(f.documentId)).doc().title, "Durable");
    });

    // worker/mutations.mjs:243-250,264-275: a rejected write must not produce
    // a successful receipt; replay keeps the recorded hashes after peer edits.
    for (const boundary of ["admission", "storage"])
      it(`${boundary} rejection surfaces, and recorded retry keeps unrelated peer history`, async (t) => {
        const f = await makeFixture(t);
        const peer = await f.peer();
        const base = f.handle.doc();
        const baseHashes = history(base).hashes;
        const candidate = A.change(A.clone(base), (d) => {
          d.title = "Recorded retry";
        });
        const changes = A.getChanges(base, candidate);
        const hashes = changes.map((bytes) => A.decodeChange(bytes).hash);
        A.free(candidate);
        const rejection = boundary === "admission" ? f.rejectAdmission() : f.rejectWrites();
        t.after(rejection.release);
        const update = Promise.resolve().then(() =>
          f.handle.update((doc) => A.applyChanges(doc, changes)[0]),
        );
        const outcome = update.then(
          () => null,
          (error) => error,
        );
        const updateError = await outcome;
        if (!updateError) await assert.rejects(() => f.flush([f.documentId]));
        else assert.ok(updateError instanceof Error);
        await rejection.entered;
        rejection.release();
        const peerBase = peer.handle.doc();
        const peerEdit = A.change(A.clone(peerBase), (d) => {
          d.blocks.b.richText = "Peer survived";
        });
        const peerHeads = A.getHeads(peerEdit);
        const peerChanges = A.getChanges(peerBase, peerEdit);
        A.free(peerEdit);
        const incoming = nextEvent(t, f.handle, "heads-changed", () =>
          A.hasHeads(f.handle.doc(), peerHeads),
        );
        await peer.handle.update((doc) => A.applyChanges(doc, peerChanges)[0]);
        await incoming;
        assert.equal(f.handle.doc().blocks.b.richText, "Peer survived");
        await f.handle.update((doc) => A.applyChanges(doc, changes)[0]);
        assert.equal(f.handle.doc().title, "Recorded retry");
        assert.equal(f.handle.doc().blocks.b.richText, "Peer survived");
        assert.ok(A.hasHeads(f.handle.doc(), [...hashes, ...peerHeads]));
        assert.deepEqual(
          history(f.handle.doc()).hashes,
          [
            ...new Set([
              ...baseHashes,
              ...hashes,
              ...peerChanges.map((bytes) => A.decodeChange(bytes).hash),
            ]),
          ].sort(),
        );
        await peer.settle();
        const expected = history(f.handle.doc());
        const reopened = await f.reopen();
        assert.deepEqual(history((await reopened.find(f.documentId)).doc()), expected);
      });

    it("a rejected update leaves the committed root readable and retries without peer traffic", async (t) => {
      const f = await makeFixture(t);
      const before = f.handle.doc();
      const heads = A.getHeads(before);
      const rejection = f.rejectWrites();
      t.after(rejection.release);
      await assert.rejects(async () =>
        f.handle.update((doc) =>
          A.change(doc, (d) => {
            d.title = "Recovered without peers";
          }),
        ),
      );
      assert.deepEqual(f.handle.doc(), before);
      assert.deepEqual(A.getHeads(f.handle.doc()), heads);
      assert.equal(f.handle.doc().title, "Contract Page");
      rejection.release();
      await f.handle.update((doc) =>
        A.change(doc, (d) => {
          d.future.keep.push(3);
        }),
      );
      assert.equal(f.handle.doc().title, "Recovered without peers");
      assert.deepEqual(f.handle.doc().future.keep, [1, 2, 3]);
      await f.flush([f.documentId]);
    });

    // worker/mutations.mjs:286-314: journal enumeration need not be causal.
    it("dependency-reversed recorded changes apply as one closure", async (t) => {
      const f = await makeFixture(t);
      const base = f.handle.doc();
      let candidate = A.change(A.clone(base), (d) => {
        d.blocks.added = { position: "a1", richText: "first" };
      });
      candidate = A.change(candidate, (d) => {
        d.blocks.added.richText += " second";
      });
      const changes = A.getChanges(base, candidate);
      assert.equal(changes.length, 2);
      const expected = history(candidate);
      A.free(candidate);
      await f.handle.update((doc) => A.applyChanges(doc, [...changes].reverse())[0]);
      assert.deepEqual(history(f.handle.doc()), expected);
      assert.equal(f.handle.doc().blocks.added.richText, "first second");
      assert.deepEqual(A.getMissingDeps(f.handle.doc()), []);
      await f.flush([f.documentId]);
      const reopened = await f.reopen();
      assert.deepEqual(history((await reopened.find(f.documentId)).doc()), expected);
    });

    // worker/index.mjs:5983-5987: creation imports under the recorded ID.
    it("import preserves a supplied document ID, history, and unknown fields", async (t) => {
      const f = await makeFixture(t);
      const id = commentsDocumentId("33333333-3333-4333-8333-333333333333");
      await f.prepare(id, "page");
      const doc = A.from({ title: "Imported", future: { preserved: true } });
      const heads = A.getHeads(doc);
      const expected = history(doc);
      const handle = await f.repo.import(A.save(doc), { docId: id });
      A.free(doc);
      assert.equal(handle.documentId, id);
      assert.ok(A.hasHeads(handle.doc(), heads));
      assert.equal((await f.repo.find(id)).doc().future.preserved, true);
      await f.flush([id]);
      const reopened = await f.reopen();
      const restored = await reopened.find(id);
      assert.equal(restored.documentId, id);
      assert.deepEqual(history(restored.doc()), expected);
      assert.deepEqual(restored.doc(), { title: "Imported", future: { preserved: true } });
    });

    // worker/comments-store.mjs:20-38; worker/index.mjs:3644-3651,4782-4803.
    it("comments genesis reimport merges existing history and flushes both documents", async (t) => {
      const f = await makeFixture(t);
      const uuid = "22222222-2222-4222-8222-222222222222";
      const id = commentsDocumentId(uuid);
      await f.prepare(id, "comments");
      const genesis = commentsGenesis(uuid);
      const bytes = A.save(genesis);
      A.free(genesis);
      const comments = await f.repo.import(bytes, { docId: id });
      await f.flush([f.documentId, id]);
      await f.handle.update((doc) =>
        A.change(doc, (d) => {
          d.title = "Dirty Page";
        }),
      );
      await comments.update((doc) =>
        A.change(doc, (d) => {
          d.threads.retained = { messages: {} };
        }),
      );
      const heads = A.getHeads(comments.doc());
      const pageHistory = history(f.handle.doc());
      const commentHistory = history(comments.doc());
      await f.flush([f.documentId, id]);
      // Reopen exercises the worker's prime-before-import path, not just a
      // warm Repo cache that already knows the comments history.
      const reopened = await f.reopen();
      await f.prepare(id, "comments");
      const again = await reopened.import(bytes, { docId: id });
      assert.deepEqual(A.getHeads(again.doc()), heads);
      assert.deepEqual(history(again.doc()), commentHistory);
      assert.deepEqual(again.doc().threads.retained, { messages: {} });
      const page = await reopened.find(f.documentId);
      assert.equal(page.doc().title, "Dirty Page");
      assert.deepEqual(history(page.doc()), pageHistory);
      await f.flush([f.documentId, id]);
      const stored = await f.stored(id);
      try {
        assert.ok(A.hasHeads(stored, heads));
      } finally {
        A.free(stored);
      }
    });

    // worker/index.mjs:5936-5949: repo deletion is local; forget purges host storage.
    it("delete invalidates retained handles, then forget removes durable history", async (t) => {
      const f = await makeFixture(t);
      await f.repo.delete(f.documentId);
      await assert.rejects(async () => f.handle.update((doc) => A.emptyChange(doc)));
      await f.forget([f.documentId]);
      assert.equal(await f.stored(f.documentId), null);
    });

    // worker/index.mjs:5936-5949: restart deletes from metadata without opening
    // either document. Repeated lifecycle effects must remain idempotent.
    it("deletes unopened Page and comments by ID, repeatedly", async (t) => {
      const f = await makeFixture(t);
      const comments = await openComments(f);
      const ids = [f.documentId, comments.documentId];
      await f.flush(ids);
      const repo = await f.reopen();
      // No find/import on this repo before deletion.
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const id of ids) await repo.delete(id);
        await f.forget(ids);
        for (const id of ids) assert.equal(await f.stored(id), null);
      }
    });

    // worker/index.mjs:5936-5949: a queued admission must not restore purged bytes.
    for (const kind of ["page", "comments"])
      it(`queued ${kind} write overlapping delete cannot resurrect storage`, async (t) => {
        const f = await makeFixture(t);
        const handle = kind === "page" ? f.handle : await openComments(f);
        const id = handle.documentId;
        const gate = f.holdWrites();
        t.after(gate.release);
        const write = Promise.resolve().then(() =>
          handle.update((doc) =>
            A.change(doc, (d) => {
              if (kind === "page") d.title = "Queued";
              else d.threads.queued = { messages: {} };
            }),
          ),
        );
        const written = write.then(
          () => null,
          (error) => error,
        );
        const flushing = f.flush([id]).then(
          () => null,
          (error) => error,
        );
        await gate.entered;
        const deleted = f.repo.delete(id).then(() => f.forget([id]));
        gate.release();
        await Promise.all([written, flushing, deleted]);
        assert.equal(await f.stored(id), null);
        await f.repo.delete(id);
        await f.forget([id]);
        assert.equal(await f.stored(id), null);
      });

    // worker/plain-sync.mjs:433-435: teardown is awaitable, repeatable, and closes transport.
    it("shutdown is repeatable and rejects new work", async (t) => {
      const f = await makeFixture(t);
      await f.flush([f.documentId]);
      await f.repo.shutdown();
      await f.repo.shutdown();
      assert.ok(await f.closed());
      await assert.rejects(async () => f.repo.find(f.documentId));
      await assert.rejects(async () => f.handle.update((doc) => A.emptyChange(doc)));
    });
  });
}

function nextEvent(t, handle, name, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      handle.off(name, listener);
    };
    const listener = (event) => {
      try {
        if (!accepts(event)) return;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      cleanup();
      resolve(event);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Timed out waiting for ${name}`));
    }, 5_000);
    t.after(cleanup);
    handle.on(name, listener);
  });
}

function history(doc) {
  return {
    heads: A.getHeads(doc).sort(),
    hashes: A.getAllChanges(doc)
      .map((bytes) => A.decodeChange(bytes).hash)
      .sort(),
  };
}

async function openComments(f) {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const id = commentsDocumentId(uuid);
  await f.prepare(id, "comments");
  const genesis = commentsGenesis(uuid);
  try {
    const handle = await f.repo.import(A.save(genesis), { docId: id });
    await f.flush([id]);
    return handle;
  } finally {
    A.free(genesis);
  }
}
