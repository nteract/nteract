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
import { encoder, key, markLocalPageTrashed, store } from "./local-catalog.mjs";
import { deviceRows } from "./listing.mjs";

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

test("a writer that vouches for its earlier snapshot still merges another tab's checkpoint", async () => {
  const { identity, page } = fixture();
  const base = A.load(Uint8Array.from(atob(page.snapshot), (c) => c.charCodeAt(0)));
  const mine = A.change(A.clone(base, { actor: "aa".repeat(16) }), (doc) => {
    doc.text = "Mine";
  });
  const first = encodeSnapshot(A.save(mine));
  await writeLocalPage(identity, { ...page, snapshot: first });
  // Another tab writes its own edit, merged into the stored checkpoint.
  const theirs = A.change(A.clone(base, { actor: "bb".repeat(16) }), (doc) => {
    doc.title = "Theirs";
  });
  await writeLocalPage(identity, { ...page, snapshot: encodeSnapshot(A.save(theirs)) });
  // This tab's next snapshot holds `first`, but the stored one is no longer
  // `first`: the merge still runs and keeps the other tab's edit.
  const next = A.change(mine, (doc) => {
    doc.text = "Mine, later";
  });
  const written = await writeLocalPage(
    identity,
    { ...page, snapshot: encodeSnapshot(A.save(next)) },
    { covers: first },
  );
  const stored = A.load(Uint8Array.from(atob(written.snapshot), (c) => c.charCodeAt(0)));
  assert.equal(stored.title, "Theirs");
  assert.equal(stored.text, "Mine, later");
});

test("a writer whose earlier snapshot is the stored one replaces it without a merge", async () => {
  const { identity, page } = fixture();
  await writeLocalPage(identity, page);
  const base = A.load(Uint8Array.from(atob(page.snapshot), (c) => c.charCodeAt(0)));
  const next = encodeSnapshot(
    A.save(
      A.change(base, (doc) => {
        doc.text = "After";
      }),
    ),
  );
  const written = await writeLocalPage(
    identity,
    { ...page, snapshot: next },
    { covers: page.snapshot },
  );
  assert.equal(written.snapshot, next);
  assert.equal((await readLocalPage(identity, page.page_id)).snapshot, next);
});

test("a clean checkpoint clears pending only when its writer knew every other replica's actor", async () => {
  const { identity, page } = fixture();
  const entry = (n) => ({ actor: n.repeat(32), replica: n.repeat(32) });
  const edits = (...actors) => ({ actors, ackedHeads: [], unattributed: false });
  // The right tab recorded its actor and marked its edit pending.
  await writeLocalPage(
    identity,
    { ...page, localEdits: edits(entry("b")) },
    { replica: "b".repeat(32) },
  );
  // The left tab never saw it: its clean write keeps the flag.
  const unaware = await writeLocalPage(
    identity,
    { ...page, pending: false, localEdits: edits(entry("a")) },
    { replica: "a".repeat(32) },
  );
  assert.equal(unaware.pending, true);
  // A write that knew the right tab's actor decides it.
  const aware = await writeLocalPage(
    identity,
    { ...page, pending: false, localEdits: edits(entry("a"), entry("b")) },
    { replica: "a".repeat(32) },
  );
  assert.equal(aware.pending, false);
  // A record without localEdits gives the fence nothing to read.
  await writeLocalPage(identity, { ...page, pending: true });
  const legacy = await writeLocalPage(identity, { ...page, pending: false, localEdits: undefined });
  assert.equal(legacy.pending, false);
});

const ALL = { query: "", access: null, projectId: null };
const grant = (role, revision = 3) => ({ role, revision, generation: 1, canRead: role !== "none" });
const listed = async (identity) =>
  Object.fromEntries((await listLocalPages(identity)).map((page) => [page.page_id, page]));

test("a revoked shared Page's pending copy stays out of the library once the server stops listing it", async () => {
  // Alice opened a Page shared with her and left before its first receipt
  // landed: the copy is pending, with no edit of hers in it.
  const { identity, page } = fixture();
  await writeLocalPage(identity, { ...page, title: "Launch plan", access: grant("viewer") });
  const local = await listLocalPages(identity);
  assert.equal(local[0].owned, false);
  assert.deepEqual(deviceRows(local, [], ALL), [], "the server's list no longer holds it");
  assert.deepEqual(deviceRows(local, [], { ...ALL, access: "owned" }), []);
  // Offline, every copy still shows on All, as before.
  assert.deepEqual(
    deviceRows(local, [], ALL, { failed: true }).map((row) => row.page_id),
    [page.page_id],
  );
});

test("a checkpoint records whether this account owns the Page, from the last grant that named a role", async () => {
  const identity = { principal: crypto.randomUUID() };
  const write = async (role, extra = {}) => {
    const { page } = fixture();
    const next = { ...page, principal: identity.principal, access: grant(role), ...extra };
    await writeLocalPage(identity, next);
    return next;
  };
  const owner = await write("owner");
  const editor = await write("editor");
  const commenter = await write("commenter");
  const none = await write("none");
  const ungranted = await write("owner", { access: undefined });
  let pages = await listed(identity);
  assert.equal(pages[owner.page_id].owned, true);
  assert.equal(pages[editor.page_id].owned, false);
  assert.equal(pages[commenter.page_id].owned, false);
  assert.equal("owned" in pages[none.page_id], false, "a refused grant says nothing");
  assert.equal("owned" in pages[ungranted.page_id], false);
  // A later refusal (a paused or trashed open writes role none) keeps what
  // the last named role said, for the owner and for a member alike.
  for (const page of [owner, editor])
    await writeLocalPage(identity, { ...page, access: grant("none", 4), pending: true });
  pages = await listed(identity);
  assert.equal(pages[owner.page_id].owned, true);
  assert.equal(pages[editor.page_id].owned, false);
  // A host-verified open that replaces the copy names the role again.
  await writeLocalPage(identity, { ...editor, access: grant("owner", 5) }, { replace: true });
  assert.equal((await listed(identity))[editor.page_id].owned, true);
});

test("an entry written before ownership was recorded answers from its stored grant, or not at all", async () => {
  const { identity, page } = fixture();
  const raw = async (entry) =>
    store.save(key(identity, entry.page_id), encoder.encode(JSON.stringify(entry)));
  const viewer = { ...page, access: grant("viewer") };
  const owner = { ...page, page_id: crypto.randomUUID(), access: grant("owner") };
  const refused = { ...page, page_id: crypto.randomUUID(), access: grant("none") };
  const bare = { ...page, page_id: crypto.randomUUID() };
  for (const entry of [viewer, owner, refused, bare]) await raw(entry);
  const pages = await listed(identity);
  assert.equal(pages[viewer.page_id].owned, false);
  assert.equal(pages[owner.page_id].owned, true);
  // Unknown: these list as every pending copy did, until the Page is opened
  // again and its checkpoint names a role.
  assert.equal("owned" in pages[refused.page_id], false);
  assert.equal("owned" in pages[bare.page_id], false);
  assert.deepEqual(
    deviceRows(Object.values(pages), [], ALL)
      .map((row) => row.page_id)
      .sort(),
    [owner.page_id, refused.page_id, bare.page_id].sort(),
  );
  // The next write records it.
  await writeLocalPage(identity, { ...refused, access: grant("editor", 4) });
  assert.equal((await listed(identity))[refused.page_id].owned, false);
});

test("a pending copy of a Page the host moved to Trash leaves the library and keeps its copy", async () => {
  // The owner's copy has edits the host never confirmed, as a Page whose
  // format the host doesn't open always does: its session never syncs.
  const { identity, page } = fixture();
  const access = grant("owner");
  const written = await writeLocalPage(identity, { ...page, access, replicaKey: "1:owner" });
  const before = await readLocalPage(identity, page.page_id, { markers: true });
  assert.deepEqual(
    deviceRows(await listLocalPages(identity), [], ALL).map((row) => row.page_id),
    [page.page_id],
    "the server no longer lists the Page, so its pending copy shows",
  );
  const marked = await markLocalPageTrashed(identity, page.page_id, {
    grant: "1:owner",
    revision: access.revision,
  });
  assert.equal(marked.access.trashed, true);
  assert.deepEqual(await listLocalPages(identity), []);
  assert.deepEqual(deviceRows(await listLocalPages(identity), [], ALL), []);
  assert.deepEqual(
    deviceRows(await listLocalPages(identity), [], ALL, { failed: true }),
    [],
    "offline, Trash still holds it",
  );
  // The copy stays for restore: only the access fact changed.
  const after = await readLocalPage(identity, page.page_id, { markers: true });
  assert.deepEqual(after, { ...before, access: { ...before.access, trashed: true } });
  assert.equal(after.snapshot, written.snapshot);
  assert.equal(after.pending, true);
  // Restored and opened again: the host-verified checkpoint names the
  // untrashed grant, and the copy lists as before.
  await writeLocalPage(identity, { ...page, access, replicaKey: "1:owner" });
  assert.deepEqual(
    deviceRows(await listLocalPages(identity), [], ALL).map((row) => row.page_id),
    [page.page_id],
  );
});

test("marking a Page trashed writes nothing over a marker, another account's entry or a newer grant", async () => {
  const { identity, page } = fixture();
  const raw = async (entry, who = identity) =>
    store.save(key(who, entry.page_id), encoder.encode(JSON.stringify(entry)));
  const stored = async (pageId, who = identity) =>
    JSON.parse(new TextDecoder().decode(await store.load(key(who, pageId))));
  // Nothing stored: nothing is created.
  assert.equal(await markLocalPageTrashed(identity, page.page_id, { grant: "1:owner" }), null);
  assert.equal(await store.load(key(identity, page.page_id)), undefined);
  // A deletion or access marker stays as it is.
  const deleted = { principal: identity.principal, page_id: crypto.randomUUID(), deleted: true };
  const revoked = { principal: identity.principal, page_id: crypto.randomUUID(), revoked: true };
  for (const marker of [deleted, revoked]) {
    await raw(marker);
    assert.equal(await markLocalPageTrashed(identity, marker.page_id, { grant: "1:owner" }), null);
    assert.deepEqual(await stored(marker.page_id), marker);
  }
  // An entry under this account's key that names another principal.
  const foreign = { ...page, page_id: crypto.randomUUID(), principal: crypto.randomUUID() };
  await raw(foreign);
  assert.equal(await markLocalPageTrashed(identity, foreign.page_id, { grant: "1:owner" }), null);
  assert.deepEqual(await stored(foreign.page_id), foreign);
  // A newer grant's entry: another replica key, or a greater grant revision.
  const access = grant("owner", 7);
  const rekeyed = { ...page, page_id: crypto.randomUUID(), access, replicaKey: "2:owner" };
  const revised = {
    ...page,
    page_id: crypto.randomUUID(),
    access,
    replicaKey: "1:owner",
    grant_revision: 7,
  };
  for (const entry of [rekeyed, revised]) {
    await raw(entry);
    assert.equal(
      await markLocalPageTrashed(identity, entry.page_id, { grant: "1:owner", revision: 3 }),
      null,
    );
    assert.deepEqual(await stored(entry.page_id), entry);
    assert.equal((await listed(identity))[entry.page_id].page_id, entry.page_id);
  }
  // The same grant at the same revision is marked; a legacy entry without a
  // grant revision is too.
  const current = { ...page, page_id: crypto.randomUUID(), access, replicaKey: "1:owner" };
  await raw(current);
  await markLocalPageTrashed(identity, current.page_id, { grant: "1:owner", revision: 7 });
  assert.deepEqual(await stored(current.page_id), {
    ...current,
    access: { ...access, trashed: true },
  });
  assert.equal((await listed(identity))[current.page_id], undefined);
});

test("a clean write the pending fence keeps pending still records owned", async () => {
  const { identity, page } = fixture();
  const entry = (n) => ({ actor: n.repeat(32), replica: n.repeat(32) });
  const edits = (...actors) => ({ actors, ackedHeads: [], unattributed: false });
  await writeLocalPage(
    identity,
    { ...page, access: grant("editor"), localEdits: edits(entry("b")) },
    { replica: "b".repeat(32) },
  );
  // The writer never saw the other tab's actor, and its grant now says owner.
  const kept = await writeLocalPage(
    identity,
    { ...page, pending: false, access: grant("owner", 4), localEdits: edits(entry("a")) },
    { replica: "a".repeat(32) },
  );
  assert.equal(kept.pending, true);
  assert.equal(kept.owned, true);
  const stored = await readLocalPage(identity, page.page_id);
  assert.equal(stored.pending, true);
  assert.equal(stored.owned, true);
});
