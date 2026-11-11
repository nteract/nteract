import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  encodeSnapshot,
  retireLocalPage,
  listLocalPages,
  readLocalPage,
  writeLocalPage,
} from "./local-pages.mjs";

function fixture() {
  const identity = { principal: crypto.randomUUID() };
  const pageId = crypto.randomUUID();
  const doc = A.from({ page_id: pageId, title: "A local Page", text: "Before deletion" });
  return {
    identity,
    page: {
      principal: identity.principal,
      page_id: pageId,
      document_id: crypto.randomUUID(),
      title: doc.title,
      snapshot: encodeSnapshot(A.save(doc)),
      pending: true,
      registered: true,
      created_at: "2026-10-19T15:00:00Z",
      updated_at: "2026-10-19T15:00:00Z",
    },
  };
}

test("deletion hides the checkpoint and rejects late receipt or close writes", async () => {
  const { identity, page } = fixture();
  await writeLocalPage(identity, page);
  await retireLocalPage(identity, page.page_id, { reason: "deleted" });
  for (const late of [
    { ...page, pending: false },
    { ...page, pending: true, title: "Closed after deletion" },
    { ...page, document_id: crypto.randomUUID() },
  ]) {
    await assert.rejects(writeLocalPage(identity, late), {
      code: "LOCAL_PAGE_DELETED",
      status: 410,
    });
  }
  assert.equal(await readLocalPage(identity, page.page_id), null);
  assert.deepEqual(await listLocalPages(identity), []);
  assert.deepEqual(await listLocalPages(identity, { pendingOnly: true }), []);
});

test("a deletion wins against both earlier and later queued checkpoint transactions", async () => {
  const { identity, page } = fixture();
  await writeLocalPage(identity, page);
  const outcomes = await Promise.allSettled([
    writeLocalPage(identity, { ...page, title: "Queued before deletion" }),
    retireLocalPage(identity, page.page_id, { reason: "deleted" }),
    writeLocalPage(identity, { ...page, title: "Queued after deletion" }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.equal(outcomes[2].status, "rejected");
  assert.equal(outcomes[2].reason.code, "LOCAL_PAGE_DELETED");
  assert.equal(await readLocalPage(identity, page.page_id), null);
  assert.deepEqual(await listLocalPages(identity), []);
});

test("deletion is scoped to the account even when another account has the same Page ID", async () => {
  const { identity, page } = fixture();
  const other = { principal: crypto.randomUUID() };
  const otherPage = { ...page, principal: other.principal };
  await writeLocalPage(identity, page);
  await writeLocalPage(other, otherPage);
  await retireLocalPage(identity, page.page_id, { reason: "deleted" });
  await writeLocalPage(other, { ...otherPage, title: "Other account's checkpoint" });
  assert.equal(await readLocalPage(identity, page.page_id), null);
  assert.equal((await readLocalPage(other, page.page_id)).title, "Other account's checkpoint");
  assert.equal((await listLocalPages(other)).length, 1);
});

test("a persisted deletion blocks stale writers using another tab's database connection", async () => {
  const { identity, page } = fixture();
  const peer = await import(`./local-pages.mjs?peer=${crypto.randomUUID()}`);
  assert.notEqual(peer.readLocalPage, readLocalPage);
  await writeLocalPage(identity, page);
  const stale = await peer.readLocalPage(identity, page.page_id);
  await retireLocalPage(identity, page.page_id, { reason: "deleted" });
  await assert.rejects(peer.writeLocalPage(identity, stale), { code: "LOCAL_PAGE_DELETED" });
  assert.equal(await peer.readLocalPage(identity, page.page_id), null);
  assert.deepEqual(await peer.listLocalPages(identity), []);
});

test("deleting before a local checkpoint exists prevents a delayed initial write", async () => {
  const { identity, page } = fixture();
  await retireLocalPage(identity, page.page_id, { reason: "deleted" });
  await assert.rejects(writeLocalPage(identity, page), { code: "LOCAL_PAGE_DELETED" });
  await retireLocalPage(identity, page.page_id, { reason: "deleted" });
  assert.equal(await readLocalPage(identity, page.page_id), null);
});

test("independent tabs retain the first nonce a draft's registration is given, across stale checkpoints", async () => {
  const { identity, page } = fixture();
  const original = {
    ...page,
    registered: false,
    // A draft an older build saved, with no nonce yet.
    registration: { page_id: page.page_id },
  };
  await writeLocalPage(identity, original);
  const stale = await readLocalPage(identity, page.page_id);
  const first = await writeLocalPage(identity, {
    ...original,
    registration: { ...original.registration, nonce: "first-tab-nonce" },
  });
  const second = await writeLocalPage(identity, {
    ...stale,
    registration: { ...stale.registration, nonce: "other-tab-nonce" },
  });
  assert.equal(first.registration.nonce, "first-tab-nonce");
  assert.deepEqual(second.registration, first.registration);
  const checkpoint = await writeLocalPage(identity, stale);
  assert.deepEqual(checkpoint.registration, first.registration);
  assert.deepEqual((await readLocalPage(identity, page.page_id)).registration, first.registration);
});

test("expired registration replacement is atomic across competing tabs and stale checkpoints", async () => {
  const { identity, page } = fixture();
  const original = {
    ...page,
    registered: false,
    registration: { nonce: "expired-registration" },
  };
  await writeLocalPage(identity, original);
  const first = await writeLocalPage(identity, {
    ...original,
    registrationSupersedes: "expired-registration",
    registration: { nonce: "first-replacement" },
  });
  assert.equal(first.registration.nonce, "first-replacement");
  assert.equal(first.registrationSupersedes, undefined);
  const competing = await writeLocalPage(identity, {
    ...original,
    registrationSupersedes: "expired-registration",
    registration: { nonce: "second-replacement" },
  });
  assert.deepEqual(competing.registration, first.registration);
  const stale = await writeLocalPage(identity, original);
  assert.deepEqual(stale.registration, first.registration);
  const completed = await writeLocalPage(identity, { ...first, registered: true });
  const late = await writeLocalPage(identity, {
    ...first,
    registrationSupersedes: "first-replacement",
    registration: { nonce: "late-replacement" },
  });
  assert.equal(late.registered, true);
  assert.deepEqual(late.registration, completed.registration);
});
