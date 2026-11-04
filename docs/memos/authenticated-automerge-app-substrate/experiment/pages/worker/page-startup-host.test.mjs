import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { proposeAccessUpdate } from "./access.mjs";
import { CONTENT_ACTIVITY_KEY } from "./content-activity.mjs";
import { errorResponse } from "./auth.mjs";
import { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { proposeSharingMutation } from "./sharing.mjs";
import { trashRecord } from "./trash.mjs";
import { commentsUuid, fixture, pageId, serverKey } from "./trash-fixture.mjs";

// A shared-Page check (`/internal/catalog`) on a Page host that hasn't booted
// answers from the host record (page-startup.mjs). These hosts are built by
// the real constructor over the fixture's storage; the repo is the fixture's
// document, and booting it is counted.

const observedAt = "2026-10-20T10:00:00.000Z";
const contentAt = "2026-10-21T10:00:00.000Z";
const namespace = "user:anaconda-fixture";
const reader = `${namespace}:company-reader`;

/** The fixture's Page with its record in storage, as a host after eviction
 * finds it, its stored title projection and content time, and `cold()` to
 * start a host over that storage. `boots()` counts repo boots; `reads` holds
 * page-startup's state at each read of the document. */
async function hosts(t, options = {}) {
  const f = await fixture(t, options);
  let boots = 0;
  const reads = [];
  const host = { f, reads, boots: () => boots };
  const handleOf = (page, doc) => ({
    doc: () => {
      reads.push(page.startup.name);
      return doc();
    },
    broadcast() {},
    on() {},
    off() {},
  });
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    boots++;
    this.policy = new DocumentPolicy({
      storage: this.ctx.storage,
      metadata: () => this.metadata,
      serverKey,
    });
    await this.policy.load();
    this.serverKey = serverKey;
    this.serverSenderId = "server-sender";
    this.backend = { async flush() {} };
    const page = this;
    this.repo = {
      find: async () => handleOf(page, f.doc),
      import: async (_bytes, { docId } = {}) =>
        handleOf(page, docId === f.initial.documentId ? f.doc : f.commentsDoc),
      async delete() {},
      async flush() {},
    };
    this.commentsUuid = commentsUuid;
    await host.onBoot?.();
  });
  /** A new object over this storage. `limit(call)` may return a promise that
   * rejects to end the `call`th blockConcurrencyWhile early (0 is the
   * constructor's), as the runtime's 30 s limit does: the call rejects and
   * resets the object, and its callback runs on. */
  host.cold = ({ onReset, limit } = {}) => {
    let calls = 0;
    return new Page(
      {
        id: { name: pageId },
        storage: f.storage,
        // As the runtime does: a throw resets the object (onReset).
        blockConcurrencyWhile: async (fn) => {
          const ended = limit?.(calls++);
          try {
            return await (ended ? Promise.race([fn(), ended]) : fn());
          } catch (error) {
            onReset?.(error);
            throw error;
          }
        },
        waitUntil: (promise) => f.tasks.push(promise),
      },
      f.env,
    );
  };
  /** A Durable Object stub over this storage: it routes each request to the
   * live object and starts a new one after a reset, as the runtime does. */
  host.stub = () => {
    const stub = { objects: 0 };
    let live;
    stub.fetch = async (request) => {
      if (!live) {
        const page = host.cold({ onReset: () => live === page && (live = undefined) });
        live = page;
        stub.objects++;
        try {
          await page.ready;
        } catch (error) {
          return errorResponse(error);
        }
      }
      return live.fetch(request);
    };
    return stub;
  };
  host.record = async (metadata) => f.storage.put("host/document", metadata);
  await host.record(f.initial);
  await f.storage.put("host/title-projection", {
    title: "Launch plan",
    observed_at: observedAt,
    keep: true,
  });
  await f.storage.put(CONTENT_ACTIVITY_KEY, { content_updated_at: contentAt });
  host.check = async (page, who, identity) => {
    if (identity) page.identify = async () => identity;
    const response = await page.fetch(
      f.request(f.tokens[who] ?? f.tokens.owner, "/internal/catalog", {}),
    );
    return { status: response.status, body: await response.json() };
  };
  return host;
}

/** One host answering from its record and one booted first, each over its
 * own copy of storage, give the same answer, which this returns. `booted`
 * says the first host's check boots it. `fresh` compares a title observed by
 * each boot (no stored projection) only as a time. */
async function sameAnswer(h, who, { identity, booted = false, fresh = false } = {}) {
  const before = structuredClone(h.f.storage.values);
  const lazy = h.cold();
  await lazy.ready;
  assert.equal(lazy.startup.name, "metadata");
  const fromRecord = await h.check(lazy, who, identity);
  assert.equal(lazy.repo !== undefined, booted, booted ? "the check boots" : "no boot");
  h.f.storage.values = structuredClone(before);
  const full = h.cold();
  await full.ready;
  await full.documentReady();
  const fromDocument = await h.check(full, who, identity);
  if (fresh)
    for (const answer of [fromRecord, fromDocument]) {
      assert.match(answer.body.title_observed_at, /^\d{4}-\d\d-\d\dT/);
      delete answer.body.title_observed_at;
    }
  assert.deepEqual(fromRecord, fromDocument);
  h.f.storage.values = before;
  return fromRecord;
}

test("a check from the host record answers as a booted host does, for every relation", async (t) => {
  for (const memberRole of ["viewer", "commenter", "editor"]) {
    const h = await hosts(t, { memberRole });
    const member = await sameAnswer(h, "member");
    assert.equal(member.status, 200);
    assert.deepEqual(member.body, {
      page_id: pageId,
      title: "Launch plan",
      shared: true,
      owner: h.f.owner,
      role: memberRole,
      source: "member",
      revision: 1,
      lifecycle_revision: 0,
      state: "active",
      title_observed_at: observedAt,
      title_keep_time: true,
      content_updated_at: contentAt,
    });
    if (memberRole !== "editor") continue;
    const owner = await sameAnswer(h, "owner");
    assert.equal(owner.status, 200);
    assert.equal(owner.body.role, "owner");
    const stranger = await sameAnswer(h, "stranger");
    assert.equal(stranger.status, 403);
  }
});

test("read-only and expired credentials get the same answer from the record as from a booted host", async (t) => {
  const h = await hosts(t);
  h.f.tokens.readOnly = h.f.auth.apiKey({ userId: "member-user", scopes: ["cloud:read"] });
  h.f.tokens.expired = h.f.auth.apiKey({ userId: "member-user", status: 401 });
  const readOnly = await sameAnswer(h, "readOnly");
  assert.equal(readOnly.status, 200);
  // A read-only credential still reports the role its holder has.
  assert.equal(readOnly.body.role, "editor");
  // The provider no longer accepts the key: both refuse before any title.
  const expired = await sameAnswer(h, "expired");
  assert.equal(expired.status, 401);
  assert.equal(expired.body.title, undefined);
});

test("a company reader's check from the record names the domain, as a booted host's does", async (t) => {
  const h = await hosts(t);
  await h.record({
    ...h.f.initial,
    acl: { ...h.f.initial.acl, domainView: { domain: "example.com", namespace } },
  });
  const identity = {
    principal: reader,
    namespace,
    displayName: "Reader",
    driver: "Browser",
    canWrite: false,
    expiresAt: Date.now() + 60_000,
    domainAccess: { domain: "example.com", namespace, expiresAt: Date.now() + 30_000 },
  };
  const answer = await sameAnswer(h, "reader", { identity });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.source, "domain_opened");
  assert.equal(answer.body.domain, "example.com");
  assert.equal(answer.body.role, "viewer");
  // An expired lease reads nothing, from either.
  const expired = await sameAnswer(h, "reader", {
    identity: { ...identity, domainAccess: { ...identity.domainAccess, expiresAt: 1 } },
  });
  assert.equal(expired.status, 403);
});

test("a revoked member is refused from the record, and a revocation in storage applies at once", async (t) => {
  const h = await hosts(t);
  const ownerIdentity = { principal: h.f.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const revoked = {
    ...h.f.initial,
    acl: proposeAccessUpdate(h.f.initial, ownerIdentity, {
      principal: h.f.member,
      role: null,
      expected_revision: 1,
    }).acl,
  };
  const page = h.cold();
  await page.ready;
  assert.equal((await h.check(page, "member")).status, 200);
  // The host record is the authority: the next check reads it again.
  await h.record(revoked);
  const refused = await h.check(page, "member");
  assert.equal(refused.status, 403);
  assert.equal(h.boots(), 0);
  assert.deepEqual(await sameAnswer(h, "member"), refused);
});

test("Trash and deletion refuse from the record; a grant holder's check of a trashed Page boots", async (t) => {
  const h = await hosts(t);
  const now = new Date().toISOString();
  await h.record({
    ...h.f.initial,
    deleted: true,
    lifecycleRevision: 1,
    trash: trashRecord({
      pageId,
      principal: h.f.owner,
      now,
      receipt: { page_id: pageId, state: "trashed", trashed: true, title: "Launch plan" },
    }),
  });
  const stranger = await sameAnswer(h, "stranger");
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.code, "page_not_found");
  const member = await sameAnswer(h, "member", { booted: true });
  assert.equal(member.status, 403);
  assert.equal(member.body.code, "page_trashed");
  const owner = await sameAnswer(h, "owner", { booted: true });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.state, "trashed");

  // A purged Page forgets its title projection; a check needs none.
  await h.f.storage.delete("host/title-projection");
  await h.record({
    ...h.f.initial,
    deleted: true,
    lifecycleRevision: 2,
    purged: { purged_at: now, purged_by: h.f.owner },
    deletion: { key: "host/operation/purge", fingerprint: "f", receipt: { deleted: true } },
  });
  for (const who of ["owner", "member", "stranger"]) {
    const deleted = await sameAnswer(h, who);
    assert.equal(deleted.status, 404, who);
  }
});

test("an invitation the caller can't claim answers from the record; a claimable one boots and claims", async (t) => {
  const h = await hosts(t);
  const ownerIdentity = {
    principal: h.f.owner,
    namespace,
    canWrite: true,
    expiresAt: Date.now() + 60_000,
  };
  const { metadata } = await proposeSharingMutation(
    h.f.initial,
    ownerIdentity,
    {
      action: "invite",
      email: "invitee@example.com",
      role: "viewer",
      expected_revision: 1,
      idempotency_key: "startup-invite",
    },
    Date.now(),
  );
  await h.record(metadata);
  const invitee = {
    principal: `${namespace}:invitee`,
    namespace,
    displayName: "Invitee",
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 60_000,
  };
  // Another address: nothing to claim, and no grant.
  const other = await sameAnswer(h, "invitee", {
    identity: { ...invitee, verifiedEmail: "someone@example.com" },
  });
  assert.equal(other.status, 403);
  // The invited address claims it: the check boots, installs the grant and
  // answers from the loaded host, as a booted host does.
  const claimant = { ...invitee, verifiedEmail: "invitee@example.com" };
  const boots = h.boots();
  const lazy = h.cold();
  await lazy.ready;
  const claimed = await h.check(lazy, "invitee", claimant);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.role, "viewer");
  assert.equal(h.boots(), boots + 1);
  assert.equal(
    (await h.f.storage.get("host/document")).acl.members[claimant.principal].role,
    "viewer",
  );
});

test("a check boots when the record can't answer it", async (t) => {
  const cases = {
    "no stored title": [async (h) => h.f.storage.delete("host/title-projection"), true],
    "an index report that failed earlier": [
      async (h) => h.f.storage.put("host/index/report-pending", true),
      false,
    ],
  };
  for (const [label, [setup, fresh]] of Object.entries(cases)) {
    const h = await hosts(t);
    await setup(h);
    const answer = await sameAnswer(h, "member", { booted: true, fresh });
    assert.equal(answer.status, 200, label);
    assert.equal(answer.body.title, "Launch plan", label);
  }
});

test("a title projection that misses a Catalog makes the next restart's check boot and send it again", async (t) => {
  const h = await hosts(t);
  const catalogs = h.f.env.CATALOGS;
  const sent = [];
  let refuse = h.f.member;
  h.f.env.CATALOGS = {
    getByName: (principal) => ({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/internal/projection") {
          sent.push(principal);
          if (principal === refuse) return Response.json({ error: "Busy" }, { status: 503 });
        }
        return catalogs.getByName(principal).fetch(request);
      },
    }),
  };
  const settle = async () => {
    while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  };
  const pending = () => h.f.storage.get("host/title-projection/pending");
  // No stored title: the check boots, observes the title, stores it and
  // projects it. The member's Catalog refuses, so the mark stays.
  await h.f.storage.delete("host/title-projection");
  const first = h.cold();
  await first.ready;
  assert.equal((await h.check(first, "member")).status, 200);
  await settle();
  assert.equal(h.boots(), 1);
  assert.deepEqual(sent.sort(), [h.f.member, h.f.owner].sort());
  assert.equal((await h.f.storage.get("host/title-projection")).title, "Launch plan");
  assert.equal(await pending(), true);

  // After a restart the stored title is there, but the mark makes the check
  // boot, and the loaded host's first check sends it to every Catalog again.
  refuse = undefined;
  sent.length = 0;
  const second = h.cold();
  await second.ready;
  const answer = await h.check(second, "member");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.title, "Launch plan");
  assert.equal(h.boots(), 2);
  await settle();
  assert.deepEqual(sent.sort(), [h.f.member, h.f.owner].sort());
  assert.equal(await pending(), undefined, "every Catalog took it");

  // Then the record answers again.
  const third = h.cold();
  await third.ready;
  assert.equal((await h.check(third, "member")).status, 200);
  assert.equal(h.boots(), 2);
});

test("a projection that finishes after a newer title was stored leaves the mark", async (t) => {
  const h = await hosts(t);
  const page = h.cold();
  await page.ready;
  await page.documentReady();
  const settle = async () => {
    while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  };
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const catalogs = h.f.env.CATALOGS;
  h.f.env.CATALOGS = {
    getByName: (principal) => ({
      fetch: async (request) => {
        await held;
        return catalogs.getByName(principal).fetch(request);
      },
    }),
  };
  // A projection of the stored title is running when an ACL commit stores a
  // new observation of it (marked); the older projection lands after.
  page.cacheTitle();
  page.titleObservation("Launch plan", { observe: true });
  release();
  await settle();
  assert.equal(await h.f.storage.get("host/title-projection/pending"), true);
});

test("a creation intent or a legacy record boots in the constructor, as every host did", async (t) => {
  const h = await hosts(t);
  await h.f.storage.put("host/creation", {
    metadata: h.f.initial,
    bytes: A.save(h.f.doc()),
  });
  const page = h.cold();
  await page.ready;
  assert.equal(page.startup.name, "ready");
  assert.equal(h.boots(), 1);
  assert.equal(await h.f.storage.get("host/creation"), undefined, "the boot replayed it");
  assert.equal((await h.check(page, "member")).status, 200);

  const legacy = await hosts(t);
  const { comments_doc: _named, ...unnamed } = legacy.f.initial;
  await legacy.record(unnamed);
  const old = legacy.cold();
  await old.ready;
  assert.equal(old.startup.name, "ready");
  assert.equal(legacy.boots(), 1);
  assert.equal((await legacy.f.storage.get("host/document")).comments_doc, commentsUuid);
});

test("checks around a request that needs the document boot the repo once, before any read", async (t) => {
  const h = await hosts(t);
  const page = h.cold();
  await page.ready;
  const first = h.check(page, "member");
  const read = page.fetch(
    h.f.request(h.f.tokens.member, "/internal/tool", {
      operation: "read_page",
      arguments: { page_id: pageId, comments: "none" },
    }),
  );
  const second = h.check(page, "member");
  const [a, r, b] = await Promise.all([first, read, second]);
  assert.equal(a.status, 200);
  assert.equal(r.status, 200);
  assert.equal(b.status, 200);
  assert.equal(h.boots(), 1);
  assert.equal(page.startup.name, "ready");
  assert.deepEqual(
    { ...a.body, title_observed_at: undefined },
    { ...b.body, title_observed_at: undefined },
  );
  // The document was read only once the boot had started, never by a check
  // answered from the record.
  assert.ok(h.reads.length > 0);
  assert.ok(
    h.reads.every((state) => ["booting", "ready"].includes(state)),
    h.reads.join(),
  );

  // A check that arrives while a boot runs waits for it.
  const later = await hosts(t);
  let release;
  later.onBoot = () => new Promise((resolve) => (release = resolve));
  const booting = later.cold();
  await booting.ready;
  const boot = booting.documentReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(booting.startup.name, "booting");
  let answered = false;
  const waiting = later.check(booting, "member").then((answer) => {
    answered = true;
    return answer;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false, "the check waits for the boot");
  release();
  await boot;
  const answer = await waiting;
  assert.equal(answer.status, 200);
  assert.equal(later.boots(), 1);
  assert.ok(later.reads.every((state) => ["booting", "ready"].includes(state)));
});

test("a failed lazy boot resets the object; checks answer from the record and the next boot succeeds", async (t) => {
  const h = await hosts(t);
  let failures = 1;
  h.onBoot = () => {
    if (failures-- > 0) throw Error("record store unavailable");
  };
  const stub = h.stub();
  const check = async () => {
    const response = await stub.fetch(h.f.request(h.f.tokens.member, "/internal/catalog", {}));
    return { status: response.status, body: await response.json() };
  };
  const read = () =>
    stub.fetch(
      h.f.request(h.f.tokens.member, "/internal/tool", {
        operation: "read_page",
        arguments: { page_id: pageId, comments: "none" },
      }),
    );
  assert.equal((await check()).status, 200, "the record answers first");
  // The transient failure reaches only the request that needed the boot.
  assert.equal((await read()).status, 500);
  assert.equal(h.boots(), 1);
  // A new object answers from the record, never with the stale error.
  const after = await check();
  assert.equal(after.status, 200);
  assert.equal(after.body.title, "Launch plan");
  assert.equal(stub.objects, 2, "the failed boot reset the object");
  assert.equal(h.boots(), 1, "the check booted nothing");
  // The next request that needs the document boots again, and succeeds.
  assert.equal((await read()).status, 200);
  assert.equal(h.boots(), 2);
  assert.equal((await check()).status, 200);
});

test("an object a failed boot hasn't been replaced yet still answers checks from its record", async (t) => {
  const h = await hosts(t);
  h.onBoot = () => {
    throw Error("record store unavailable");
  };
  const page = h.cold();
  await page.ready;
  const read = await page.fetch(
    h.f.request(h.f.tokens.member, "/internal/tool", {
      operation: "read_page",
      arguments: { page_id: pageId },
    }),
  );
  assert.equal(read.status, 500);
  assert.equal(page.startup.name, "failed");
  const check = await h.check(page, "member");
  assert.equal(check.status, 200);
  assert.equal(check.body.title, "Launch plan");
  // A check the record can't answer needs the boot this object can't give.
  await h.f.storage.put("host/index/report-pending", true);
  assert.equal((await h.check(page, "member")).status, 500);
  assert.equal(h.boots(), 1);
});

test("a constructor boot that fails still fails construction", async (t) => {
  const h = await hosts(t);
  h.onBoot = () => {
    throw Error("record store unavailable");
  };
  const { comments_doc: _named, ...unnamed } = h.f.initial;
  await h.record(unnamed);
  let reset;
  const page = h.cold({ onReset: (error) => (reset = error) });
  await assert.rejects(page.ready, /record store unavailable/);
  assert.equal(reset?.message, "record store unavailable", "inside blockConcurrencyWhile");
});

/** A rejection like celld's when a blockConcurrencyWhile outlives 30 s. */
const limitError = () =>
  Error(
    "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
  );

test("a lazy boot the runtime gives up on is abandoned: its requests fail and it writes nothing more", async (t) => {
  const h = await hosts(t);
  let release;
  h.onBoot = () => new Promise((resolve) => (release = resolve));
  let giveUp;
  const page = h.cold({
    limit: (call) => (call === 1 ? new Promise((_, reject) => (giveUp = reject)) : undefined),
  });
  await page.ready;
  const read = () =>
    page.fetch(
      h.f.request(h.f.tokens.member, "/internal/tool", {
        operation: "read_page",
        arguments: { page_id: pageId, comments: "none" },
      }),
    );
  const opening = read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.startup.name, "booting");
  const queued = read();
  const check = h.check(page, "member");
  await new Promise((resolve) => setImmediate(resolve));
  const before = structuredClone(h.f.storage.values);
  // The opening request's blockConcurrencyWhile ends early, while the boot
  // inside it still waits.
  giveUp(limitError());
  const [a, b, c] = await Promise.all([opening, queued, check]);
  assert.ok(a.status >= 500, `the opening request: ${a.status}`);
  assert.ok(b.status >= 500, `a queued read: ${b.status}`);
  assert.ok(c.status >= 500, `a queued check: ${c.status}`);
  assert.equal(page.startup.name, "abandoned");
  // The boot finishes after the reset and stops before its first write.
  release();
  while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.startup.name, "abandoned");
  assert.deepEqual(h.f.storage.values, before, "nothing written after the reset");
  assert.deepEqual(h.reads, [], "the document was never read");
  assert.equal(page.handle, undefined);
  // A later request on the old object gets the reset's error too.
  const late = await read();
  assert.ok(late.status >= 500, `a late read: ${late.status}`);
  assert.equal(h.boots(), 1);
});

test("a constructor boot the runtime gives up on is abandoned and writes nothing more", async (t) => {
  const h = await hosts(t);
  let release;
  h.onBoot = () => new Promise((resolve) => (release = resolve));
  // An older record without a comments document name: the boot writes it.
  const { comments_doc: _named, ...unnamed } = h.f.initial;
  await h.record(unnamed);
  let giveUp;
  const page = h.cold({
    limit: (call) => (call === 0 ? new Promise((_, reject) => (giveUp = reject)) : undefined),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.startup.name, "booting");
  giveUp(limitError());
  await assert.rejects(page.ready, /waited for too long/);
  assert.equal(page.startup.name, "abandoned");
  release();
  while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.startup.name, "abandoned");
  assert.equal(
    (await h.f.storage.get("host/document")).comments_doc,
    undefined,
    "the abandoned boot didn't write the record",
  );
  assert.deepEqual(h.reads, []);
});

test("a title whose projection mark can't be written isn't stored, so the next check boots", async (t) => {
  const h = await hosts(t);
  // No stored title: the check boots, observes the title and projects it.
  await h.f.storage.delete("host/title-projection");
  const put = h.f.storage.put;
  h.f.storage.put = async function (key, value) {
    if (key === "host/title-projection/pending") throw Error("storage unavailable");
    return put.call(this, key, value);
  };
  const page = h.cold();
  await page.ready;
  assert.equal((await h.check(page, "member")).status, 200);
  while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  assert.equal(h.boots(), 1);
  assert.equal(
    await h.f.storage.get("host/title-projection"),
    undefined,
    "no title without its mark",
  );
  assert.equal(await h.f.storage.get("host/title-projection/pending"), undefined);
  // The next object finds no stored title, so its check boots and projects
  // the title again.
  h.f.storage.put = put;
  const next = h.cold();
  await next.ready;
  const answer = await h.check(next, "member");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.title, "Launch plan");
  assert.equal(h.boots(), 2);
  while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
  assert.equal((await h.f.storage.get("host/title-projection")).title, "Launch plan");
  assert.equal(await h.f.storage.get("host/title-projection/pending"), undefined);
});

test("two requests that need the document boot the repo once", async (t) => {
  const h = await hosts(t);
  let release;
  h.onBoot = () => new Promise((resolve) => (release = resolve));
  const page = h.cold();
  await page.ready;
  const read = () =>
    page.fetch(
      h.f.request(h.f.tokens.member, "/internal/tool", {
        operation: "read_page",
        arguments: { page_id: pageId, comments: "none" },
      }),
    );
  const first = read();
  const second = read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.startup.name, "booting");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(h.boots(), 1);
});

test("a check from the record projects nothing and reports nothing", async (t) => {
  const h = await hosts(t);
  const calls = [];
  const catalogs = h.f.env.CATALOGS;
  h.f.env.CATALOGS = {
    getByName: (principal) => {
      calls.push(principal);
      return catalogs.getByName(principal);
    },
  };
  const page = h.cold();
  await page.ready;
  assert.equal((await h.check(page, "member")).status, 200);
  await Promise.allSettled(h.f.tasks.splice(0));
  assert.deepEqual(calls, []);
  // A booted host's first check projects the title, as it always has.
  await page.documentReady();
  assert.equal((await h.check(page, "member")).status, 200);
  await Promise.allSettled(h.f.tasks.splice(0));
  assert.ok(calls.includes(h.f.owner));
});
