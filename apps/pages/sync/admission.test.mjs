import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { proseNewlineSpans } from "../model/richtext-test-support.mjs";
import { commentAdmission } from "./comments.mjs";
import { Refusal, defaultPolicy } from "./host.mjs";
import { browser, host, idle, newId, raw, until, urlOf } from "./test-helpers.mjs";

const ALICE = "account:alice";
const BOB = "account:bob";
const CAROL = "account:carol";
const who = (principal) => ({
  principal,
  displayName: principal.slice(8),
  driver: "Browser",
});
const page = A.from({ blocks: { b1: { position: "a0", richText: "One" } } });
const changesOf = async (h, id, actor) =>
  A.getAllChanges(await h.document(id))
    .map((c) => A.decodeChange(c))
    .filter((c) => c.actor === actor);

/** A host with the worker's comment wiring: refusals block the principal. */
async function commentsHost(options = {}) {
  const blocked = new Map();
  const log = [];
  const admitComments = commentAdmission({
    isBlocked: (conn) => blocked.has(conn.principal),
  });
  const h = await host({
    ...options,
    policy: {
      admit: (conn, doc, live, fresh, preview, actorPrincipal) =>
        doc.kind === "comments"
          ? admitComments(conn, doc, live, fresh, preview, actorPrincipal)
          : preview,
      refused(conn, _doc, refusal) {
        log.push({ principal: conn.principal, code: refusal.code });
        if (refusal.fatal && refusal.code !== "comments_blocked" && refusal.code !== "expired")
          blocked.set(conn.principal, refusal.code);
      },
      ...options.policy,
    },
  });
  return { h, blocked, log };
}

test("a forged edit of another author's message is refused before it's stored, and blocks the forger", async () => {
  const { h, blocked, log } = await commentsHost();
  const id = newId();
  await h.seed(id, "comments", commentsGenesis("0f5db4ee-ab47-48e4-a0e2-facc277a3efe"));
  const alice = await browser(h, { principal: ALICE, role: "editor" });
  const bob = await browser(h, { principal: BOB, role: "commenter" });
  let bob2;
  try {
    const ha = await alice.repo.find(urlOf(id));
    let ids;
    ha.change((d) => {
      ids = applyComment(d, { block_id: "b1", body: "Alice opens" }, who(ALICE), null, {
        page,
        role: "editor",
      });
    });
    await until(async () => (await h.document(id)).threads[ids.thread_id], {
      label: "Alice's thread",
    });

    // A commenter may reply.
    const hb = await bob.repo.find(urlOf(id));
    await until(() => hb.doc().threads[ids.thread_id]);
    hb.change((d) =>
      applyComment(
        d,
        { action: "reply", thread_id: ids.thread_id, body: "Bob replies" },
        who(BOB),
        null,
        {
          page,
          role: "commenter",
        },
      ),
    );
    const messages = async () =>
      Object.keys((await h.document(id)).threads[ids.thread_id].messages).length;
    await until(async () => (await messages()) === 2, { label: "Bob's reply" });
    const before = h.store.manifest(id).seq;
    const bobActor = A.getActorId(hb.doc());

    hb.change((d) =>
      A.updateText(
        d,
        ["threads", ids.thread_id, "messages", ids.message_id, "richText"],
        "Alice agrees with Bob",
      ),
    );
    await until(() => log.some((e) => e.principal === BOB), {
      label: "refusal",
    });
    assert.deepEqual(log.at(-1), {
      principal: BOB,
      code: "not_message_author",
    });
    await until(() => bob.link.client.closed, { label: "Bob disconnected" });
    assert.equal(blocked.get(BOB), "not_message_author");
    assert.equal(h.store.manifest(id).seq, before, "nothing stored");
    assert.equal((await changesOf(h, id, bobActor)).length, 1, "only Bob's reply is stored");
    await idle();
    assert.equal(
      ha.doc().threads[ids.thread_id].messages[ids.message_id].richText,
      "\ufffcAlice opens",
    );

    // A fresh browser (new session, new actor) is still blocked.
    bob2 = await browser(h, { principal: BOB, role: "commenter" });
    const hb2 = await bob2.repo.find(urlOf(id));
    hb2.change((d) =>
      applyComment(d, { block_id: "b1", body: "A new thread" }, who(BOB), null, {
        page,
        role: "commenter",
      }),
    );
    await until(() => log.filter((e) => e.principal === BOB).length === 2, {
      label: "second refusal",
    });
    assert.equal(log.at(-1).code, "comments_blocked");
    assert.equal(h.store.manifest(id).seq, before);

    ha.change((d) =>
      A.updateText(
        d,
        ["threads", ids.thread_id, "messages", ids.message_id, "richText"],
        "\ufffcAlice opens, edited",
      ),
    );
    await until(
      async () =>
        (await h.document(id)).threads[ids.thread_id].messages[ids.message_id].richText ===
        "\ufffcAlice opens, edited",
    );
  } finally {
    for (const c of [alice, bob, bob2].filter(Boolean)) await c.repo.shutdown();
  }
});

test("a comment out of the editor's form is refused over plain sync without blocking its principal", async () => {
  const { h, blocked, log } = await commentsHost();
  const id = newId();
  await h.seed(id, "comments", commentsGenesis("1a2b3c4d-ab47-48e4-a0e2-facc277a3efe"));
  const alice = await browser(h, { principal: ALICE, role: "editor" });
  try {
    const ha = await alice.repo.find(urlOf(id));
    let ids;
    ha.change((d) => {
      ids = applyComment(d, { block_id: "b1", body: "Alice opens" }, who(ALICE), null, {
        page,
        role: "editor",
      });
    });
    await until(async () => (await h.document(id)).threads[ids.thread_id], {
      label: "Alice's thread",
    });
    const before = h.store.manifest(id).seq;
    // A reply whose newline is stored as text, where the editor writes a
    // hard break.
    ha.change((d) => {
      const message = d.threads[ids.thread_id].messages[ids.message_id];
      d.threads[ids.thread_id].messages.stale = {
        richText: "",
        author: { ...message.author },
        createdAt: new Date().toISOString(),
        deletedAt: null,
      };
      A.updateSpans(
        d,
        ["threads", ids.thread_id, "messages", "stale", "richText"],
        proseNewlineSpans("Old\ntab"),
      );
    });
    await until(() => log.some((e) => e.principal === ALICE), { label: "refusal" });
    assert.deepEqual(log.at(-1), { principal: ALICE, code: "outdated_form" });
    assert.equal(blocked.has(ALICE), false, "the principal isn't blocked");
    assert.equal(h.store.manifest(id).seq, before, "nothing stored");
    assert.equal((await h.document(id)).threads[ids.thread_id].messages.stale, undefined);
  } finally {
    await alice.repo.shutdown();
  }
});

async function relaySetup() {
  let clock = 1_000_000;
  const { h, log } = await commentsHost({ now: () => clock });
  const id = newId();
  await h.seed(id, "page", A.from({ title: "Relay" }, { actor: "00".repeat(16) }));
  const alice = await browser(h, {
    principal: ALICE,
    role: "editor",
    expiresAt: clock + 60_000,
  });
  const ha = await alice.repo.find(urlOf(id));
  ha.change((d) => (d.alice = 1));
  await until(async () => (await h.document(id)).alice === 1, {
    label: "Alice's first edit",
  });
  return { h, log, id, alice, ha, advance: (ms) => (clock += ms) };
}

test("an expired author's new changes are refused; admitted history stays", async () => {
  const { h, log, id, alice, ha, advance } = await relaySetup();
  try {
    advance(61_000);
    const seq = h.store.manifest(id).seq;
    ha.change((d) => (d.alice = 2));
    await until(() => log.length > 0, { label: "refusal" });
    assert.deepEqual(log[0], { principal: ALICE, code: "expired" });
    assert.equal((await h.document(id)).alice, 1);
    assert.equal(h.store.manifest(id).seq, seq);
    assert.equal((await changesOf(h, id, A.getActorId(ha.doc()))).length, 1);
  } finally {
    await alice.repo.shutdown();
  }
});

test("a writer relaying an expired author's new change is refused", async () => {
  const { h, log, id, alice, ha, advance } = await relaySetup();
  const carol = await browser(h, { principal: CAROL, role: "editor" });
  try {
    alice.link.client.close();
    ha.change((d) => (d.alice = 3));
    advance(61_000);
    const offline = A.clone(ha.doc());
    const hc = await carol.repo.find(urlOf(id));
    const seq = h.store.manifest(id).seq;
    await hc.update((current) => A.merge(current, offline));
    await until(() => log.length > 0, { label: "refusal" });
    assert.deepEqual(log[0], { principal: CAROL, code: "actor_claimed" });
    assert.equal((await h.document(id)).alice, 1);
    assert.equal(h.store.manifest(id).seq, seq);
  } finally {
    await alice.repo.shutdown();
    await carol.repo.shutdown();
  }
});

test("re-sending accepted history is a no-op, whoever sends it", async () => {
  const { h, log, id, alice, ha, advance } = await relaySetup();
  try {
    advance(61_000);
    const carol = raw(h, {
      principal: CAROL,
      role: "editor",
      senderId: "carol",
    });
    const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
    m.changes = A.getAllChanges(ha.doc());
    const seq = h.store.manifest(id).seq;
    carol.link.client.send({
      t: "sync",
      doc: id,
      m: A.encodeSyncMessage(m),
      r: 1,
    });
    await until(() => carol.frames.length > 0);
    assert.equal(carol.frames[0].t, "sync");
    assert.equal(carol.frames[0].has, true);
    assert.deepEqual(
      log.filter((e) => e.principal === CAROL),
      [],
    );
    assert.equal(h.store.manifest(id).seq, seq);
    assert.equal(h.actor(A.getActorId(ha.doc())).principal, ALICE);
  } finally {
    await alice.repo.shutdown();
  }
});

test("a viewer's changes are stripped and the rest of its message stands", async () => {
  const { h, id, alice } = await relaySetup();
  const viewer = await browser(h, {
    principal: "account:dana",
    role: "viewer",
  });
  try {
    const hv = await viewer.repo.find(urlOf(id));
    assert.equal(hv.doc().alice, 1);
    hv.change((d) => (d.viewer = true));
    await until(() => h.stats.stripped > 0, { label: "strip" });
    assert.equal((await h.document(id)).viewer, undefined);
  } finally {
    await alice.repo.shutdown();
    await viewer.repo.shutdown();
  }
});

test("the default policy refuses expired leases and gates writes by role", () => {
  assert.ok(defaultPolicy.denied({ expiresAt: 5 }, 10) instanceof Refusal);
  assert.equal(defaultPolicy.denied({ expiresAt: 50 }, 10), null);
  assert.equal(defaultPolicy.canWrite({ role: "commenter" }, { kind: "page" }), false);
  assert.equal(defaultPolicy.canWrite({ role: "commenter" }, { kind: "comments" }), true);
});
