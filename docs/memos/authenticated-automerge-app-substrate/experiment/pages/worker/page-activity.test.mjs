import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage } from "../model/page.mjs";
import { PageActivity, ACTIVITY_LIMITS } from "./page-activity.mjs";
import { pageAccess } from "./access.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const identity = (extra = {}) => ({
  principal: "user:owner",
  displayName: "Example Person",
  driver: "ChatGPT",
  namespace: "user",
  canWrite: true,
  expiresAt: 120_000,
  ...extra,
});
function fixture(t, markdown = "A visible selected passage. Another useful passage.") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const doc = A.change(A.from(createPageData({ pageId })), (draft) =>
    initializePage(draft, markdown),
  );
  const metadata = { pageId, owner: "user:owner", acl: { members: {}, revision: 0 } };
  let profiles = {};
  const broadcasts = [];
  const options = {
    pageId,
    access: (identity) => pageAccess(metadata, identity),
    profiles: () => profiles,
    onChange: (value) => broadcasts.push(value),
  };
  const activity = new PageActivity(options);
  t.after(() => {
    activity.close();
    A.free(doc);
  });
  return {
    activity,
    metadata,
    broadcasts,
    options,
    doc,
    blockId: Object.keys(doc.blocks)[0],
    profiles(value) {
      profiles = value;
    },
  };
}
const report = (f, args = {}, person = identity()) =>
  f.activity.report(f.doc, person, { page_id: pageId, message: "Reviewing this passage", ...args });
const lease = ({ progress_id, lease_token }) => ({ progress_id, lease_token });

test("progress leases separate two agents on one account without changing document history", (t) => {
  const f = fixture(t),
    before = A.save(f.doc),
    heads = A.getHeads(f.doc);
  const one = report(f, {
    targets: [{ block_id: f.blockId, match_text: "selected passage" }],
    expected_heads: heads,
  });
  const two = report(f);
  assert.notEqual(one.progress_id, two.progress_id);
  assert.notEqual(one.lease_token, two.lease_token);
  assert.throws(() => report(f, { ...lease(one), lease_token: two.lease_token }), { status: 403 });
  const renewed = report(f, { ...lease(one), message: "Checking sources" });
  assert.equal(renewed.lease_token, undefined);
  assert.equal(renewed.targets[0].quote, "selected passage");
  assert.equal(f.activity.read(f.doc).progress.length, 2);
  for (const value of [f.activity.snapshot(), f.activity.read(f.doc), ...f.broadcasts]) {
    assert.ok(!JSON.stringify(value).includes(one.lease_token));
    assert.ok(!JSON.stringify(value).includes(two.lease_token));
    assert.ok(!JSON.stringify(value).includes("lease_token"));
  }
  const cleared = f.activity.report(f.doc, identity(), {
    page_id: pageId,
    ...lease(one),
    clear: true,
  });
  assert.equal(cleared.cleared, true);
  assert.deepEqual(
    f.activity.read(f.doc).progress.map((value) => value.progress_id),
    [two.progress_id],
  );
  assert.deepEqual(A.getHeads(f.doc), heads);
  assert.deepEqual(A.save(f.doc), before);
});

test("lease ownership, scope and payload validation reject without replacing accepted progress", (t) => {
  const f = fixture(t),
    one = report(f);
  f.metadata.acl.members["user:other"] = { role: "editor", generation: 1 };
  assert.throws(() => report(f, lease(one), identity({ principal: "user:other" })), {
    status: 403,
  });
  assert.throws(() => report(f, lease(one), identity({ namespace: "another" })), { status: 403 });
  assert.throws(() => report(f, {}, identity({ canWrite: false })), { status: 403 });
  for (const args of [
    { unknown: true },
    { message: "" },
    { message: "x".repeat(241) },
    { message: "line\nbreak" },
    { progress_id: one.progress_id },
    { lease_token: one.lease_token },
    { clear: true },
    { clear: "yes" },
    { expected_heads: A.getHeads(f.doc) },
    { ...lease(one), clear: true, targets: [] },
    { targets: "bad" },
  ])
    assert.throws(() => report(f, args), { status: 400 });
  assert.equal(f.activity.read(f.doc).progress.length, 1);
  assert.equal(f.activity.revision, 1);
});

test("server expiry clears broadcasts and credential expiry can shorten the lease", (t) => {
  const f = fixture(t);
  const first = report(f, {}, identity({ expiresAt: 2000 }));
  const second = report(f);
  assert.equal(first.expires_at, new Date(2000).toISOString());
  assert.equal(second.expires_at, new Date(61_000).toISOString());
  t.mock.timers.tick(1000);
  assert.deepEqual(
    f.activity.snapshot().progress.map((value) => value.progress_id),
    [second.progress_id],
  );
  t.mock.timers.tick(59_000);
  assert.deepEqual(f.broadcasts.at(-1).progress, []);
  assert.throws(() => report(f, lease(second)), { status: 404 });
});

test("ACL generation change, removal and a fresh worker cannot revive old progress leases", (t) => {
  const f = fixture(t);
  const person = identity({ principal: "user:member" });
  f.metadata.acl.members[person.principal] = { role: "editor", generation: 1 };
  const first = report(f, {}, person);
  f.metadata.acl.members[person.principal] = { role: "editor", generation: 2 };
  assert.equal(f.activity.read(f.doc).progress.length, 0);
  assert.throws(() => report(f, lease(first), person), { status: 404 });
  report(f, {}, person);
  f.metadata.acl.members[person.principal] = { role: "viewer", generation: 3 };
  f.activity.prune();
  assert.deepEqual(f.broadcasts.at(-1).progress, []);
  const owner = report(f);
  const fresh = new PageActivity(f.options);
  t.after(() => fresh.close());
  assert.notEqual(fresh.epoch, f.activity.epoch);
  assert.equal(fresh.snapshot().progress.length, 0);
  assert.throws(
    () => fresh.report(f.doc, identity(), { page_id: pageId, ...lease(owner), message: "Resume" }),
    { status: 404 },
  );
});

test("bounded progress count and aggregate UTF-8 budget reject before changing existing records", (t) => {
  const passages = ["A", "B", "C"].map((end) => "甲".repeat(1023) + end);
  const f = fixture(t, passages.join("\n\n"));
  for (let i = 0; i < ACTIVITY_LIMITS.perPrincipal; i++) report(f);
  assert.throws(() => report(f), { status: 429 });
  f.activity.close();
  const targets = passages.map((match_text) => ({ block_id: f.blockId, match_text }));
  let rejected = false;
  for (let i = 0; i < ACTIVITY_LIMITS.progress; i++) {
    const person = identity({ principal: `user:${i}` });
    f.metadata.acl.members[person.principal] = { role: "editor", generation: 1 };
    const before = JSON.stringify(f.activity.snapshot()),
      broadcasts = f.broadcasts.length;
    try {
      report(f, { targets, expected_heads: A.getHeads(f.doc) }, person);
    } catch (error) {
      assert.equal(error.status, 413);
      assert.equal(JSON.stringify(f.activity.snapshot()), before);
      assert.equal(f.broadcasts.length, broadcasts);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true, "large multibyte quotes should hit the aggregate budget");
  f.activity.close();
  for (let i = 0; i < ACTIVITY_LIMITS.progress; i++) {
    f.metadata.acl.members[`user:${i}`] = { role: "editor", generation: 1 };
    report(f, {}, identity({ principal: `user:${i}` }));
  }
  f.metadata.acl.members["user:last"] = { role: "editor", generation: 1 };
  assert.throws(() => report(f, {}, identity({ principal: "user:last" })), { status: 429 });
});

test("reverse selections trust live native peers and expire on server time or disconnect", (t) => {
  const f = fixture(t);
  const profile = identity();
  f.profiles({ browser: profile });
  const path = ["blocks", f.blockId, "richText"];
  const value = {
    block_id: f.blockId,
    start: A.getCursor(f.doc, path, 2),
    end: A.getCursor(f.doc, path, 9),
    backward: false,
    heads: A.getHeads(f.doc),
  };
  f.activity.receive({
    senderId: "impostor",
    message: { kind: "selection", value, identity: profile },
  });
  assert.equal(f.activity.selections.size, 0);
  f.activity.receive({
    senderId: "browser",
    message: { kind: "selection", value: { ...value, heads: [] } },
  });
  assert.equal(f.activity.selections.size, 0);
  f.activity.receive({ senderId: "browser", message: { kind: "selection", value } });
  const peer = f.activity.read(f.doc).participants[0];
  assert.equal(peer.selection.kind, "selection");
  assert.equal(peer.last_seen, new Date(1000).toISOString());
  assert.equal(peer.principal, profile.principal);
  assert.equal("typing" in peer, false);
  t.mock.timers.tick(30_000);
  assert.equal(f.activity.read(f.doc).participants[0].selection, undefined);
  f.activity.receive({ senderId: "browser", message: { kind: "selection", value } });
  f.activity.receive({ senderId: "browser", message: { kind: "selection", value: null } });
  assert.equal(f.activity.selections.size, 0);
  f.activity.receive({ senderId: "browser", message: { kind: "selection", value } });
  f.profiles({ browser: { ...profile, driver: "Different browser lease" } });
  assert.equal(f.activity.read(f.doc).participants[0].selection, undefined);
  f.profiles({ browser: profile });
  f.activity.receive({ senderId: "browser", message: { kind: "selection", value } });
  f.profiles({});
  assert.deepEqual(f.activity.read(f.doc).participants, []);
  assert.equal(f.activity.selections.size, 0);
});
