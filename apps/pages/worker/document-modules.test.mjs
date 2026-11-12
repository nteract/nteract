import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { interpretAsDocumentId } from "@automerge/automerge-repo";
import { MEMBER_TYPES } from "../model/document-types.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { PlainHostStorage } from "../sync/plain-host-fixture.mjs";
import { Refusal } from "../sync/host.mjs";
import { until } from "../sync/test-helpers.mjs";
import { decodeFrame, encodeFrame, framePipe } from "../sync/wire.mjs";
import {
  COMMENTS_MODULE,
  PAGE_FAMILY,
  PAGE_FAMILY_MODULES,
  PAGE_MODULE,
  SOURCES_MODULE,
  modulesByKind,
} from "./document-modules.mjs";
import { commentsDocUuid, derivedDocUuid } from "./comments-store.mjs";
import { PlainSync, treeOf } from "./plain-sync.mjs";
import { REVISION_DOCS, REVISION_PATTERN, formatRevision, parseRevision } from "./revisions.mjs";

const NOTES_FEATURE = "test.notes-v1";

/** A test-only type the host has never heard of. It records what the host
 * asked it, refuses a change that sets `refuse`, and records refusals. */
function notesModule(kind = "notes") {
  const asked = { admit: 0, refused: [] };
  return {
    asked,
    module: {
      type: "test.notes",
      kind,
      revisionLetter: "n",
      revisionNoun: "notes",
      revisionField: "notes_revision",
      writeAccess: "notes-write",
      writeAction: "notes.write",
      hostMessages: false,
      featureStamps: () => [[NOTES_FEATURE]],
      admit(_conn, _doc, _live, _fresh, preview) {
        asked.admit++;
        if (preview.refuse) throw new Refusal("notes_refused", "Notes refuse this change");
        return preview;
      },
      refused(conn, _doc, refusal) {
        asked.refused.push({ principal: conn.principal, code: refusal.code });
      },
    },
  };
}

const docId = (n) => interpretAsDocumentId(new Uint8Array(16).fill(n));

async function fixture({ modules, documents }) {
  const accounted = [];
  const refusals = [];
  const writes = [];
  const plain = new PlainSync({
    storage: new PlainHostStorage(),
    modules,
    policy: {
      account(identity, write) {
        if (write) accounted.push(write);
        return { role: "editor", canWrite: true, canComment: true, generation: 0 };
      },
      leaseExpiresAt: () => Infinity,
    },
    onRefused: (_conn, refusal, { doc }) => refusals.push({ kind: doc.kind, code: refusal.code }),
    onWrite: (_conn, doc) => writes.push(doc.kind),
  });
  await plain.load([]);
  for (const [id, kind, seed] of documents) await plain.host.seed(treeOf(id), kind, seed);
  return { plain, accounted, refusals, writes };
}

/** A browser on PlainSync.accept through a stand-in WebSocket, sending raw
 * sync frames. */
function connect(plain, features, principal = "account:alice", formats) {
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeFrame(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeFrame(frame).buffer })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  const frames = [];
  link.client.onMessage((frame) => frames.push(frame));
  plain.accept(
    socket,
    {
      principal,
      displayName: principal,
      driver: "Browser",
      canWrite: true,
      credentialKind: "api-key",
    },
    { features, formats, senderId: `b-${crypto.randomUUID()}` },
  );
  let r = 0;
  return {
    frames,
    /** Send `base` changed by `edit` as one sync frame; resolve with the
     * host's answer to it. */
    async write(id, base, edit) {
      const next = A.change(A.clone(base), edit);
      const message = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
      message.changes = A.getChanges(base, next);
      const frame = { t: "sync", doc: treeOf(id), m: A.encodeSyncMessage(message), r: ++r };
      link.client.send(frame);
      await until(() => frames.some((f) => f.r === frame.r), { label: `answer to ${frame.r}` });
      return frames.find((f) => f.r === frame.r);
    },
  };
}

test("the host admits, refuses, accounts and gates a third type by asking its module", async () => {
  const notes = notesModule();
  const id = docId(7);
  const seed = A.from({ lines: {} }, { actor: "00".repeat(16) });
  const f = await fixture({
    modules: [...PAGE_FAMILY_MODULES, notes.module],
    documents: [[id, "notes", seed]],
  });
  try {
    const writer = connect(f.plain, [...BUILD_FEATURES, NOTES_FEATURE]);
    const admitted = await writer.write(id, seed, (d) => (d.lines.a = "one"));
    assert.equal(admitted.t, "sync");
    assert.equal((await f.plain.host.document(treeOf(id))).lines.a, "one");
    assert.deepEqual(f.accounted, ["notes-write"], "the module's write access is accounted");
    assert.deepEqual(f.writes, ["notes"]);
    assert.equal(notes.asked.admit, 1);

    const refused = await writer.write(id, seed, (d) => (d.refuse = true));
    assert.equal(refused.t, "refused");
    assert.equal(refused.code, "notes_refused");
    assert.equal(refused.fatal, false);
    assert.equal((await f.plain.host.document(treeOf(id))).refuse, undefined);
    assert.deepEqual(notes.asked.refused, [{ principal: "account:alice", code: "notes_refused" }]);
    assert.deepEqual(f.refusals, [{ kind: "notes", code: "notes_refused" }]);

    // The module's own stamp gates writes: a build without its feature is
    // refused before the module is asked.
    const stale = connect(f.plain, [...BUILD_FEATURES], "account:bob");
    const gated = await stale.write(id, seed, (d) => (d.lines.b = "two"));
    assert.equal(gated.t, "refused");
    assert.equal(gated.code, "schema_unsupported");
    assert.equal(notes.asked.admit, 2);
    assert.equal((await f.plain.host.document(treeOf(id))).lines.b, undefined);
  } finally {
    await f.plain.close();
  }
});

test("the sources module refuses every browser change, blocks no one, and admits the host", async () => {
  const id = docId(8);
  const seed = A.from({ sources: {} }, { actor: "00".repeat(16) });
  const f = await fixture({
    modules: PAGE_FAMILY_MODULES,
    documents: [[id, "sources", seed]],
  });
  try {
    const writer = connect(f.plain, [...BUILD_FEATURES]);
    for (const edit of [
      (d) => (d.sources.x = { name: "forged" }),
      (d) => delete d.sources,
      (d) => (d.title = "outside the source map"),
    ]) {
      const refused = await writer.write(id, seed, edit);
      assert.equal(refused.t, "refused");
      assert.equal(refused.code, "request_rejected");
      assert.equal(refused.fatal, false);
    }
    assert.deepEqual({ ...(await f.plain.host.document(treeOf(id))) }, { sources: {} });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.accounted, [], "no browser holds write access to it, so none is asked");
    assert.deepEqual(f.refusals, [{ kind: "sources", code: "request_rejected" }]);
    assert.equal(f.plain.blocked.size, 0, "a refused source change blocks no principal");

    // The socket stays open: a later frame is answered.
    const later = await writer.write(id, seed, (d) => (d.sources.y = { name: "again" }));
    assert.equal(later.t, "refused");

    // The host's own writes land through admitTrusted.
    const handle = await f.plain.repo.find(id);
    await handle.change((d) => (d.sources.z = { name: "host" }));
    assert.equal((await f.plain.host.document(treeOf(id))).sources.z.name, "host");
  } finally {
    await f.plain.close();
  }
});

test("a module that refuses denied writes refuses a reader's frame by name; one that strips drops it", async () => {
  const id = docId(11);
  const seed = A.from({ lines: {} }, { actor: "00".repeat(16) });
  for (const deniedWrites of ["refuse", "strip"]) {
    const notes = notesModule();
    const f = await fixture({
      modules: [...PAGE_FAMILY_MODULES, { ...notes.module, deniedWrites }],
      documents: [[id, "notes", seed]],
    });
    // A reader: the policy refuses every write access.
    f.plain.policy = {
      account(_identity, write) {
        if (write) throw new Error("read only");
        return { role: "viewer", canWrite: false, canComment: false, generation: 0 };
      },
      leaseExpiresAt: () => Infinity,
    };
    try {
      const reader = connect(f.plain, [...BUILD_FEATURES, NOTES_FEATURE]);
      const answer = await reader.write(id, seed, (d) => (d.lines.a = "one"));
      assert.equal(answer.t, deniedWrites === "refuse" ? "refused" : "sync", deniedWrites);
      if (deniedWrites === "refuse") assert.equal(answer.code, "request_rejected");
      assert.equal(notes.asked.admit, 0, "the module's admission is not asked");
      assert.equal((await f.plain.host.document(treeOf(id))).lines.a, undefined);
    } finally {
      await f.plain.close();
    }
  }
});

test("a socket reads only the documents whose formats it declared", async () => {
  const sources = docId(12);
  const comments = docId(13);
  const f = await fixture({
    modules: PAGE_FAMILY_MODULES,
    documents: [
      [sources, "sources", A.from({ sources: {} }, { actor: "00".repeat(16) })],
      [comments, "comments", A.from({ threads: {} }, { actor: "01".repeat(16) })],
    ],
  });
  const page = { type: "pages.page", format: 3 };
  const commentsFormat = { type: "pages.comments", format: 2 };
  try {
    const old = connect(f.plain, [...BUILD_FEATURES], "account:old", [page, commentsFormat]);
    const current = connect(f.plain, [...BUILD_FEATURES], "account:new", [
      page,
      commentsFormat,
      { type: "pages.sources", format: 1 },
    ]);
    const base = A.from({ sources: {} }, { actor: "02".repeat(16) });
    // A document the socket doesn't read is answered as an unknown one:
    // nothing held, nothing sent.
    const unread = await old.write(sources, base, (d) => (d.sources.a = { name: "x" }));
    assert.equal(unread.t, "sync");
    assert.equal(unread.has, false);
    assert.deepEqual(unread.heads, []);
    const read = await current.write(sources, base, (d) => (d.sources.a = { name: "x" }));
    assert.equal(read.t, "refused", "a reader of sources is answered, and its write refused");
    const thread = await old.write(
      comments,
      A.from({ threads: {} }, { actor: "03".repeat(16) }),
      () => {},
    );
    assert.equal(thread.has, true, "a client without the sources format still syncs comments");
  } finally {
    await f.plain.close();
  }
});

test("a document whose kind has no module is refused cleanly, and the host keeps serving", async () => {
  const notes = notesModule();
  const orphan = docId(9);
  const served = docId(10);
  const seed = A.from({ lines: {} }, { actor: "00".repeat(16) });
  const f = await fixture({
    modules: [...PAGE_FAMILY_MODULES, notes.module],
    documents: [
      [orphan, "unregistered", seed],
      [served, "notes", seed],
    ],
  });
  try {
    const writer = connect(f.plain, [...BUILD_FEATURES, NOTES_FEATURE]);
    const refused = await writer.write(orphan, seed, (d) => (d.lines.a = "one"));
    assert.equal(refused.t, "refused");
    assert.equal(refused.code, "request_rejected");
    assert.equal(refused.fatal, false);
    assert.equal((await f.plain.host.document(treeOf(orphan))).lines.a, undefined);
    assert.deepEqual(f.refusals, [{ kind: "unregistered", code: "request_rejected" }]);

    // Trusted host writes to it are refused too; nothing is stored.
    const handle = await f.plain.repo.find(orphan);
    await assert.rejects(handle.change((d) => (d.lines.host = "host")));
    assert.equal((await f.plain.host.document(treeOf(orphan))).lines.host, undefined);

    const admitted = await writer.write(served, seed, (d) => (d.lines.a = "one"));
    assert.equal(admitted.t, "sync");
    assert.equal((await f.plain.host.document(treeOf(served))).lines.a, "one");
  } finally {
    await f.plain.close().catch(() => {});
  }
});

test("revision handles take each module's letter and name its document", () => {
  assert.deepEqual(
    REVISION_DOCS,
    Object.fromEntries(PAGE_FAMILY_MODULES.map((module) => [module.kind, module.revisionLetter])),
  );
  assert.deepEqual(REVISION_DOCS, { page: "r", comments: "c", sources: "s" });
  for (const module of PAGE_FAMILY_MODULES) {
    const handle = formatRevision(module.kind, 42);
    assert.equal(handle, `${module.revisionLetter}42`);
    assert.ok(REVISION_PATTERN.test(handle));
    assert.equal(parseRevision(handle, module.kind), 42);
  }
  assert.ok(!REVISION_PATTERN.test("n42"));
  assert.throws(
    () => parseRevision("c1", "page"),
    (error) => error.code === "invalid_revision" && error.message.endsWith("this Page"),
  );
  assert.throws(
    () => parseRevision("r1", "comments"),
    (error) => error.code === "invalid_revision" && error.message.endsWith("this Page's comments"),
  );
  assert.equal(parseRevision("s7", "sources"), 7);
  assert.throws(
    () => parseRevision("r1", "sources"),
    (error) => error.code === "invalid_revision" && error.message.endsWith("this Page's sources"),
  );
});

test("the Page family is three modules with distinct kinds and handle letters", () => {
  assert.deepEqual([...PAGE_FAMILY.keys()], ["page", "comments", "sources"]);
  assert.equal(PAGE_FAMILY.get("page"), PAGE_MODULE);
  assert.equal(PAGE_FAMILY.get("comments"), COMMENTS_MODULE);
  assert.equal(PAGE_FAMILY.get("sources"), SOURCES_MODULE);
  assert.deepEqual(
    PAGE_FAMILY_MODULES.map((module) => module.type),
    [...MEMBER_TYPES, "pages.sources"],
    "one module for each member type of a Page, and one for the sources a Page may hold",
  );
  const other = notesModule().module;
  assert.throws(() => modulesByKind([PAGE_MODULE, { ...other, kind: "page" }]), /kind/);
  assert.throws(
    () => modulesByKind([PAGE_MODULE, { ...other, revisionLetter: "r" }]),
    /revision letter/,
  );
});

test("page and comments strip a denied browser write; sources refuses every one", () => {
  assert.equal(PAGE_MODULE.deniedWrites, "strip");
  assert.equal(COMMENTS_MODULE.deniedWrites, "strip");
  assert.equal(SOURCES_MODULE.deniedWrites, "refuse");
  assert.equal(SOURCES_MODULE.writeAccess, null);
  assert.equal(Object.hasOwn(SOURCES_MODULE, "admit"), false);
});

test("a derived document's module carries its label and fixed genesis", async () => {
  const pageId = "33333333-3333-4333-8333-333333333333";
  assert.equal(PAGE_MODULE.derived, undefined, "a Page document is not derived from its id");
  assert.equal(
    await derivedDocUuid(COMMENTS_MODULE.derived.label, pageId),
    await commentsDocUuid(pageId),
  );
  assert.notEqual(
    await derivedDocUuid(SOURCES_MODULE.derived.label, pageId),
    await commentsDocUuid(pageId),
  );
  for (const module of [COMMENTS_MODULE, SOURCES_MODULE]) {
    const uuid = await derivedDocUuid(module.derived.label, pageId);
    const [first, again] = [module.derived.genesis(uuid), module.derived.genesis(uuid)];
    assert.deepEqual(A.getHeads(first), A.getHeads(again), `${module.kind} genesis is fixed`);
    A.free(first);
    A.free(again);
  }
});

/** Host source files under worker/ and sync/: everything but tests. */
async function hostSources() {
  const root = new URL("../", import.meta.url);
  const files = [];
  for (const dir of ["worker", "sync"])
    for (const name of await readdir(new URL(`${dir}/`, root)))
      if (
        name.endsWith(".mjs") &&
        !name.endsWith(".test.mjs") &&
        // A shared test contract, run against each handle implementation.
        name !== "handle-contract.mjs"
      )
        files.push([`${dir}/${name}`, await readFile(new URL(`${dir}/${name}`, root), "utf8")]);
  return files;
}

// A comparison of a document's kind (`kind`, `doc.kind`, or a document name
// `doc`) with "page" or "comments", either way round, or a literal list of
// them asked whether it includes one. `options.kind`, `route.kind` and other
// property kinds name catalog entries and routes, not documents.
const KIND = String.raw`(?<![\w.?])(?:doc\.kind|kind|doc)`;
const NAME = String.raw`["'](?:page|comments)["']`;
const KIND_COMPARISON = new RegExp(
  [
    String.raw`${KIND}\s*[!=]==?\s*${NAME}`,
    String.raw`${NAME}\s*[!=]==?\s*${KIND}\b`,
    String.raw`\[\s*${NAME}\s*,\s*${NAME}\s*\]\s*\.includes\(`,
  ].join("|"),
);

test("host code asks a document's module and compares no kind with page or comments", async () => {
  assert.ok(
    KIND_COMPARISON.test(`if (doc.kind === "page") guard();`),
    "the check sees a comparison",
  );
  assert.ok(KIND_COMPARISON.test(`["page", "comments"].includes(kind)`));
  assert.ok(!KIND_COMPARISON.test(`if (options.kind !== "page") return;`));
  const found = [];
  for (const [path, source] of await hostSources())
    source.split("\n").forEach((line, index) => {
      if (KIND_COMPARISON.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  assert.deepEqual(found, []);
});
