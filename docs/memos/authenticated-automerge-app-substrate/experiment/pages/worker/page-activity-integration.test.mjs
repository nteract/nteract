import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import worker, { Page } from "./index.mjs";
import { authenticate } from "./auth.mjs";
import { DocumentPolicy } from "./policy.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
function request(token, path, body) {
  return new Request(`https://pages.invalid${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body && { body: JSON.stringify(body) }),
  });
}
async function fixture(t, role = "owner") {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const identity = await authenticate(request(token, "/api/tools", {}), auth.env);
  const doc = A.change(A.from(createPageData({ pageId })), (draft) =>
    initializePage(draft, "A selected passage."),
  );
  const writes = [],
    broadcasts = [];
  const storage = {
    async put(key, value) {
      writes.push([key, value]);
    },
    async sync() {
      writes.push(["sync"]);
    },
    async delete(key) {
      writes.push(["delete", key]);
    },
  };
  const handle = Object.assign(new EventEmitter(), {
    doc: () => doc,
    broadcast: (value) => broadcasts.push(value),
  });
  const page = Object.assign(Object.create(Page.prototype), {
    env: auth.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage },
    metadata: {
      pageId,
      owner: role === "owner" ? identity.principal : "user:other",
      deleted: false,
      acl: {
        revision: 0,
        members: role === "owner" ? {} : { [identity.principal]: { role, generation: 1 } },
        invites: {},
      },
    },
    handle,
    cacheTitle: () => assert.fail("ephemeral tools must not update the catalog"),
  });
  page.policy = new DocumentPolicy({
    storage,
    metadata: () => page.policyMetadata ?? page.metadata,
  });
  page.observeActivity();
  t.after(() => {
    page.activity.close();
    A.free(doc);
  });
  auth.env.PAGES = {
    getByName: (id) => {
      assert.equal(id, pageId);
      return page;
    },
  };
  return {
    ...auth,
    token,
    identity,
    doc,
    page,
    writes,
    broadcasts,
    call: (operation, args = {}, accessToken = token) =>
      worker.fetch(
        request(accessToken, "/api/tools", {
          operation,
          arguments: { page_id: pageId, ...args },
        }),
        auth.env,
      ),
  };
}

test("gateway progress and presence requests are authenticated, ephemeral and read-scope compatible", async (t) => {
  const f = await fixture(t),
    heads = A.getHeads(f.doc),
    saved = A.save(f.doc);
  const started = await f.call("report_page_progress", { message: "Reviewing a passage" });
  assert.equal(started.status, 200, await started.clone().text());
  const receipt = await started.json();
  assert.ok(receipt.lease_token);
  assert.equal(f.broadcasts.at(-1).kind, "page-activity");
  assert.equal(f.broadcasts.at(-1).progress[0].driver, "ChatGPT");
  const readToken = f.apiKey({ scopes: ["cloud:read"] });
  const read = await f.call("read_page_presence", {}, readToken);
  assert.equal(read.status, 200);
  const projection = await read.json();
  assert.equal(projection.progress.length, 1);
  assert.deepEqual(projection.heads, heads);
  assert.ok(!JSON.stringify(projection).includes(receipt.lease_token));
  assert.equal(
    (await f.call("report_page_progress", { message: "Not allowed" }, readToken)).status,
    403,
  );
  assert.equal((await f.call("read_page_presence", { arbitrary: true })).status, 400);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(A.getHeads(f.doc), heads);
  assert.deepEqual(A.save(f.doc), saved);
});

test("viewers can read presence but cannot report progress; removed readers see no roster", async (t) => {
  const f = await fixture(t, "viewer");
  assert.equal((await f.call("read_page_presence")).status, 200);
  assert.equal((await f.call("report_page_progress", { message: "Not allowed" })).status, 403);
  f.page.metadata.acl.members[f.identity.principal] = { role: "none", generation: 2 };
  const denied = await f.call("read_page_presence");
  assert.equal(denied.status, 403);
  assert.deepEqual(Object.keys(await denied.json()), ["error"]);
  assert.deepEqual(f.writes, []);
});

test("native selection listener uses authenticated profile identity and session handshake includes a fresh snapshot", async (t) => {
  const f = await fixture(t);
  const key = "a".repeat(64),
    senderId = "browser-peer";
  const release = await f.page.policy.bind(
    key,
    senderId,
    { ...f.identity, driver: "Browser" },
    {
      reauthenticate: async () => f.identity,
      disconnect() {},
    },
  );
  const blockId = Object.keys(f.doc.blocks)[0],
    path = ["blocks", blockId, "richText"];
  const message = {
    kind: "selection",
    value: {
      block_id: blockId,
      start: A.getCursor(f.doc, path, 2),
      end: A.getCursor(f.doc, path, 10),
      heads: A.getHeads(f.doc),
    },
    identity: { principal: "forged" },
  };
  f.page.handle.emit("ephemeral-message", { senderId, message });
  const projection = await (await f.call("read_page_presence")).json();
  assert.equal(projection.participants[0].principal, f.identity.principal);
  assert.equal(projection.participants[0].driver, "Browser");
  assert.equal(projection.participants[0].selection.kind, "selection");
  const count = f.page.handle.listenerCount("ephemeral-message");
  f.page.observeActivity();
  assert.equal(f.page.handle.listenerCount("ephemeral-message"), count);
  f.page.cacheTitle = () => {};
  const connected = await f.page.run(request(f.token, "/api/connect"));
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).activity.epoch, f.page.activity.epoch);
  release();
  f.page.activity.prune();
  assert.equal(f.page.activity.selections.size, 0);
  assert.deepEqual((await (await f.call("read_page_presence")).json()).participants, []);
});

test("restrictive ACL barrier removes progress before storage awaits and failed persistence cannot restore it", async (t) => {
  const f = await fixture(t, "editor");
  const started = await f.call("report_page_progress", { message: "Before access changes" });
  assert.equal(started.status, 200);
  let sawRestriction = false;
  f.page.ctx.storage.put = async () => {
    sawRestriction = true;
    assert.equal(f.page.activity.snapshot().progress.length, 0);
    throw Error("simulated interrupted ACL persistence");
  };
  await assert.rejects(
    f.page.installAccess({
      ...f.page.metadata,
      acl: {
        revision: 1,
        invites: {},
        members: { [f.identity.principal]: { role: "viewer", generation: 2 } },
      },
    }),
    /interrupted ACL/,
  );
  assert.equal(sawRestriction, true);
  assert.equal(f.page.activity.snapshot().progress.length, 0);
  assert.equal(f.broadcasts.at(-1).progress.length, 0);
});
