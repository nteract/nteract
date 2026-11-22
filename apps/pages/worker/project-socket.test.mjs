import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { BUILD_FORMATS } from "../model/document-types.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { hostTreeOf } from "../sync/host-handle.mjs";
import { decodeFrame, encodeFrame } from "../sync/wire.mjs";
import { Page } from "./index.mjs";

// Minimal Cloudflare WebSocketPair double that delivers close codes and binary
// frames across the pair, so `Page.connect` runs its real plain-sync lease path.
class Socket extends EventTarget {
  readyState = 1;
  closed = null;
  sent = [];
  accept() {}
  send(data) {
    this.other.dispatchEvent(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.other.closed = { code, reason };
    this.readyState = 3;
    this.other.readyState = 3;
    for (const socket of [this, this.other])
      socket.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

function installWebSocketPair(t) {
  const PreviousPair = globalThis.WebSocketPair;
  const PreviousResponse = globalThis.Response;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      const a = new Socket();
      const b = new Socket();
      a.other = b;
      b.other = a;
      return { 0: a, 1: b };
    }
  };
  globalThis.Response = class extends PreviousResponse {
    constructor(body, init) {
      if (init?.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, "status", { value: 101 });
        this.webSocket = init.webSocket;
        return;
      }
      super(body, init);
    }
  };
  t.after(() => {
    globalThis.WebSocketPair = PreviousPair;
    globalThis.Response = PreviousResponse;
  });
}

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    for (const name of Array.isArray(key) ? key : [key]) this.values.delete(name);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort()
      .slice(0, limit);
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key))]));
  }
  async sync() {}
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
}

async function setupProjectPage(t) {
  installWebSocketPair(t);
  const auth = await createAuthFixture();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = "user:anaconda-fixture:owner";
  const member = "user:anaconda-fixture:member";
  const member2 = "user:anaconda-fixture:member-2";
  const pageId = "44444444-4444-4444-8444-444444444444";
  const projectId = "prj_00000000-0000-4000-8000-000000000001";
  let project = {
    space_id: projectId,
    owner,
    acl: {
      revision: 1,
      members: {
        [member]: { role: "editor", generation: 1 },
        [member2]: { role: "viewer", generation: 1 },
      },
    },
  };
  let projectUnavailable = false;
  let projectReads = 0;
  let pageSpaceId = projectId;
  const env = {
    ...auth.env,
    CATALOGS: {
      getByName: () => ({
        fetch: async () => Response.json({ complete: true, space_id: pageSpaceId }),
      }),
    },
    PROJECTS: {
      getByName: () => ({
        fetch: async () => {
          projectReads++;
          if (projectUnavailable) return new Response("unavailable", { status: 503 });
          return Response.json(project);
        },
      }),
    },
  };
  const page = new Page(
    {
      id: { name: pageId },
      storage: new Storage(),
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
    },
    env,
  );
  t.after(async () => {
    await page.plain?.close();
    page.projectLease?.stop();
  });
  const doc = A.change(A.from(createPageData({ pageId, title: "Project Page" })), (draft) =>
    initializePage(draft, "Shared through a Project"),
  );
  const ownerToken = auth.apiKey({ userId: "owner" });
  const memberToken = auth.apiKey({ userId: "member" });
  const member2Token = auth.apiKey({ userId: "member-2" });
  const registered = await page.fetch(
    new Request("https://pages.invalid/internal/register", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "x-pages-driver": "Browser" },
      body: JSON.stringify({
        page_id: pageId,
        expected_principal: owner,
        document_id: interpretAsDocumentId(generateAutomergeUrl()),
        initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
        title: "Project Page",
        nonce: "register-project-socket",
        record_storage: "automerge",
      }),
    }),
  );
  assert.equal(registered.status, 201);
  const openSync = async (token, presenceId) => {
    const response = await page.fetch(
      new Request(
        `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}&presence_id=${presenceId}&page_id=${pageId}`,
        {
          headers: {
            upgrade: "websocket",
            authorization: `Bearer ${token}`,
            "x-pages-driver": "Browser",
          },
        },
      ),
    );
    assert.equal(response.status, 101);
    return response.webSocket;
  };
  return {
    page,
    pageId,
    projectId,
    owner,
    member,
    member2,
    ownerToken,
    memberToken,
    member2Token,
    openSync,
    getProjectReads: () => projectReads,
    resetProjectReads: () => {
      projectReads = 0;
    },
    setProject: (next) => {
      project = next;
    },
    setProjectUnavailable: (flag) => {
      projectUnavailable = flag;
    },
    setPageSpaceId: (next) => {
      pageSpaceId = next;
    },
  };
}

test("Project sockets renew in place across lease periods with one Project read per renewal, and close on revocation", async (t) => {
  const usageLines = [];
  t.mock.method(console, "info", (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "pages.usage.v1") usageLines.push(parsed);
    } catch {
      /* ignore non-JSON */
    }
  });
  const ctx = await setupProjectPage(t);
  const first = await ctx.openSync(ctx.memberToken, "11111111-1111-4111-8111-111111111111");
  const second = await ctx.openSync(ctx.member2Token, "22222222-2222-4222-8222-222222222222");
  ctx.resetProjectReads();

  // Stay open across 3+ full 60 s lease periods without dropping either socket.
  // Tick in 10 s steps so both 50 s Project renewals and 15 s API-key renewals settle before 60 s deadlines.
  for (let step = 0; step < 18; step++) {
    t.mock.timers.tick(10_000);
    await flushMicrotasks();
    assert.equal(first.closed, null, `first socket stays open at ${(step + 1) * 10}s`);
    assert.equal(second.closed, null, `second socket stays open at ${(step + 1) * 10}s`);
  }
  assert.equal(
    ctx.getProjectReads(),
    3,
    "one shared Project lookup per 50 s renewal serves both sockets (50 s, 100 s, 150 s)",
  );

  // Owner revokes only the first member: the next in-place renewal closes first
  // with 4409 access_changed before the lease deadline; second stays open.
  ctx.setProject({
    space_id: ctx.projectId,
    owner: ctx.owner,
    acl: { revision: 2, members: { [ctx.member2]: { role: "viewer", generation: 1 } } },
  });
  for (let step = 0; step < 6 && !first.closed; step++) {
    t.mock.timers.tick(10_000);
    await flushMicrotasks();
  }
  assert.deepEqual(first.closed, { code: 4409, reason: "access_changed" });
  assert.equal(second.closed, null, "unaffected Project reader stays connected");
  // Closing `first` mid-batch must not disarm renewal for `second` across future lease periods.
  for (let cycle = 0; cycle < 2; cycle++) {
    t.mock.timers.tick(11_500);
    await flushMicrotasks();
    assert.equal(
      second.closed,
      null,
      `second socket keeps renewing after first closed (cycle ${cycle + 1})`,
    );
  }
  const closeRecord = usageLines.findLast((line) => line.action === "sync.close");
  assert.equal(closeRecord.close_code, 4409);
  assert.equal(closeRecord.close_reason, "access_changed");
  assert.equal(closeRecord.outcome, "access_changed");

  // Re-checking admission for the revoked member fails closed.
  const denied = await ctx.page.fetch(
    new Request(`https://pages.invalid/api/connect?page_id=${ctx.pageId}`, {
      headers: { authorization: `Bearer ${ctx.memberToken}`, "x-pages-driver": "Browser" },
    }),
  );
  assert.equal(denied.status, 403);

  // Peer-initiated close records `client_close` without trusting peer close text or code.
  second.close(4409, "secret-client-note");
  await flushMicrotasks();
  const peerClose = usageLines.findLast((line) => line.action === "sync.close");
  assert.equal(peerClose.close_code, undefined);
  assert.equal(peerClose.close_reason, "client_close");
});

test("Project sockets recover from brief Project unavailability and fail closed with 4503 if it persists", async (t) => {
  const ctx = await setupProjectPage(t);
  const socket = await ctx.openSync(ctx.memberToken, "33333333-3333-4333-8333-333333333333");

  // Brief outage at the 50 s renewal mark, recovering before the 60 s deadline.
  // Advance in 15 s steps first so API-key renewal stays fresh before the Project outage.
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(15_000);
    await flushMicrotasks();
  }
  ctx.setProjectUnavailable(true);
  t.mock.timers.tick(5_000);
  await flushMicrotasks();
  assert.equal(socket.closed, null, "transient outage does not close early");

  ctx.setProjectUnavailable(false);
  t.mock.timers.tick(2_500);
  await flushMicrotasks();
  assert.equal(socket.closed, null, "retry recovers before lease expiry");

  // Sustained outage past the lease deadline fails closed with 4503 project_lease_expired.
  ctx.setProjectUnavailable(true);
  for (let i = 0; i < 5 && !socket.closed; i++) {
    t.mock.timers.tick(15_000);
    await flushMicrotasks();
  }
  assert.deepEqual(socket.closed, { code: 4503, reason: "project_lease_expired" });
});

test("a frame arriving right at Project lease expiry closes with 4503 project_lease_expired, not 4401", async (t) => {
  const ctx = await setupProjectPage(t);
  const socket = await ctx.openSync(ctx.memberToken, "44444444-4444-4444-8444-444444444444");
  const [conn] = [...ctx.page.plain.host.connections()].filter((c) => !c.trusted);
  assert.ok(conn);
  // Stop automatic renewal so we can land a frame right at conn.expiresAt before armExpiry runs.
  ctx.page.projectLease.stop();
  conn.expiresAt = Date.now();
  const replies = [];
  socket.addEventListener("message", ({ data }) => replies.push(decodeFrame(new Uint8Array(data))));
  socket.send(
    encodeFrame({
      t: "sync",
      doc: hostTreeOf(ctx.page.metadata.documentId),
      m: null,
      r: 1,
    }),
  );
  await flushMicrotasks();
  assert.deepEqual(socket.closed, { code: 4503, reason: "project_lease_expired" });
  const refused = replies.find((frame) => frame?.t === "refused");
  assert.equal(refused?.code, "temporarily_unavailable");
});

test("moving a Page out of its Project closes Project-inherited sockets with 4409 access_changed", async (t) => {
  const ctx = await setupProjectPage(t);
  const socket = await ctx.openSync(ctx.memberToken, "55555555-5555-4555-8555-555555555555");
  ctx.setPageSpaceId(null);
  for (let i = 0; i < 6 && !socket.closed; i++) {
    t.mock.timers.tick(10_000);
    await flushMicrotasks();
  }
  assert.deepEqual(socket.closed, { code: 4409, reason: "access_changed" });
  assert.equal(ctx.page.projectLease.state.name, "idle");
});

test("downgrading a Project editor closes them with 4409 while the owner stays open, and extendLeases never revives an expired socket", async (t) => {
  const ctx = await setupProjectPage(t);
  const ownerSocket = await ctx.openSync(ctx.ownerToken, "88888888-8888-4888-8888-888888888888");
  const memberSocket = await ctx.openSync(ctx.memberToken, "66666666-6666-4666-8666-666666666666");
  const member2Socket = await ctx.openSync(
    ctx.member2Token,
    "77777777-7777-4777-8777-777777777777",
  );

  // Downgrade member from editor to viewer: accessShape changes, so renewal closes them with 4409
  // while the owner and unaffected viewer stay connected.
  ctx.setProject({
    space_id: ctx.projectId,
    owner: ctx.owner,
    acl: {
      revision: 2,
      members: {
        [ctx.member]: { role: "viewer", generation: 1 },
        [ctx.member2]: { role: "viewer", generation: 1 },
      },
    },
  });
  for (let i = 0; i < 6 && !memberSocket.closed; i++) {
    t.mock.timers.tick(10_000);
    await flushMicrotasks();
  }
  assert.deepEqual(memberSocket.closed, { code: 4409, reason: "access_changed" });
  assert.equal(ownerSocket.closed, null);
  assert.equal(member2Socket.closed, null);

  // If a socket's lease is already at or past expiry, extendLeases must close it with 4503 instead of reviving it.
  const member2Conn = [...ctx.page.plain.host.connections()].find(
    (c) => !c.trusted && c.identity.principal === ctx.member2,
  );
  assert.ok(member2Conn);
  member2Conn.expiresAt = Date.now();
  const result = ctx.page.plain.extendLeases();
  assert.equal(result.closed, 1);
  assert.equal(result.extended, 0);
  assert.deepEqual(member2Socket.closed, { code: 4503, reason: "project_lease_expired" });
  assert.equal(ownerSocket.closed, null);
});
