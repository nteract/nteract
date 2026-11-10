import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { fixture, pageId, commentsUuid } from "./trash-fixture.mjs";
import { world } from "./projects-fixture.mjs";
import { commentsDocumentId } from "./comments-store.mjs";
import { parseDocumentDescriptor } from "../model/document-types.mjs";
import { PageSession } from "../viewer/session.mjs";
import { previewAnswer } from "../viewer/early-session.mjs";

test("connect describes host-owned IDs without changing document bytes or host metadata", async (t) => {
  const f = await fixture(t);
  const metadata = structuredClone(f.page.metadata);
  const bytes = A.save(f.doc());
  const commentsBytes = A.save(f.commentsDoc());
  const { status, body } = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(status, 200);
  assert.deepEqual(body.documents, {
    page: { id: metadata.documentId, type: "pages.page", format: 1 },
    comments: { id: commentsDocumentId(commentsUuid), type: "pages.comments", format: 1 },
  });
  assert.equal(body.documentId, body.documents.page.id);
  assert.equal(body.commentsDocumentId, body.documents.comments.id);
  assert.equal(body.recordStorage, "automerge");
  assert.equal(body.page_id, pageId);
  assert.equal(body.serverSenderId, f.page.serverSenderId);
  assert.equal(body.identity.principal, f.owner);
  assert.equal(body.canWrite, true);
  assert.equal(body.access.canWrite, true);
  assert.deepEqual(f.page.metadata, metadata);
  assert.deepEqual(A.save(f.doc()), bytes);
  assert.deepEqual(A.save(f.commentsDoc()), commentsBytes);
  for (const descriptor of Object.values(body.documents))
    assert.deepEqual(parseDocumentDescriptor(descriptor), descriptor);
});

test("comments descriptors follow handle availability, not document content or UUID presence", async (t) => {
  const f = await fixture(t);
  assert.ok(f.page.commentsUuid);
  f.page.commentsHandle = undefined;
  const { status, body } = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(status, 200);
  assert.equal(Object.hasOwn(body, "commentsDocumentId"), false);
  assert.deepEqual(body.documents, {
    page: { id: f.page.metadata.documentId, type: "pages.page", format: 1 },
  });
  assert.equal(f.page.commentsHandle, undefined);
});

test("Project content discovery describes pages.page, not a separate document type", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const host = w.page(project.document_id);
  const response = await host.fetch(
    new Request(`https://pages.invalid/api/connect?page=${project.document_id}`, {
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.documents.page, {
    id: host.metadata.documentId,
    type: "pages.page",
    format: 1,
  });
});

test("connect still refuses unreadable Pages without disclosing descriptors", async (t) => {
  const f = await fixture(t);
  const { status, body } = await f.pageCall("stranger", `/api/connect?page=${pageId}`);
  assert.equal(status, 403);
  assert.equal(body.code, "page_access_denied");
  assert.equal(Object.hasOwn(body, "documents"), false);
});

test("existing discovery consumers ignore known and unknown additive documents metadata", async (t) => {
  const f = await fixture(t);
  const { body } = await f.pageCall("owner", `/api/connect?page=${pageId}&preview=1`);
  const { documents: _documents, ...legacy } = body;
  const discoveries = [
    ["legacy", legacy],
    ["known descriptors", body],
    [
      "unknown types",
      {
        ...body,
        documents: {
          page: { id: "unused-page-id", type: "pages.future-page", format: 1 },
          comments: { id: "unused-comments-id", type: "pages.future-comments", format: 1 },
        },
      },
    ],
    [
      "unknown formats",
      {
        ...body,
        documents: {
          page: { ...body.documents.page, format: 99 },
          comments: { ...body.documents.comments, format: 99 },
        },
      },
    ],
  ];

  const outcomes = [];
  for (const [label, discovery] of discoveries) {
    assert.deepEqual(previewAnswer(discovery), previewAnswer(legacy), label);
    const session = new PageSession(pageId);
    session.acceptAuthentication({ identity: body.identity, canWrite: true });
    t.after(() => session.close());
    t.mock.method(session, "initializeLocal", async (key) => {
      session.replicaKey = key;
    });
    const sockets = [];
    // Exercise requestConnect, authentication, access, profiles and activity.
    // Replace local storage and the socket-opening boundary.
    t.mock.method(session, "openPlainConnection", async () => {
      sockets.push(session.connection.serverSenderId);
    });
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(url, `/api/connect?page=${pageId}&sync=automerge`);
      return Response.json(discovery);
    });
    await assert.doesNotReject(session.openConnection(false), label);
    fetch.mock.restore();
    assert.equal(session.canWrite, true, label);
    assert.equal(!!session.accessReloadRequired, false, label);
    assert.equal(!!session.accessDenied, false, label);
    const comments = [];
    session.repo = { async flush() {} };
    t.mock.method(session, "commentsOpen", (event) => comments.push(event));
    session.openComments();
    outcomes.push({
      documentId: session.connection.documentId,
      comments,
      sockets,
      canWrite: session.canWrite,
      access: session.access,
      generation: session.connectionGeneration,
      profiles: session.profiles,
      activityEpoch: session.activityEpoch,
    });
  }
  for (let i = 1; i < outcomes.length; i++)
    assert.deepEqual(outcomes[i], outcomes[0], discoveries[i][0]);
  assert.equal(outcomes[1].documentId, body.documentId);
  assert.deepEqual(outcomes[1].comments, [{ type: "open", id: body.commentsDocumentId }]);
  assert.deepEqual(outcomes[1].sockets, [body.serverSenderId]);
});
