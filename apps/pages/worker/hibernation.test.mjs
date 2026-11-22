import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import {
  OIDC_SESSION_SCHEMA,
  SERVER_SESSION_COOKIE,
  createServerAppSession,
  randomSecret,
  revokeServerSession,
  sealServerSecret,
  serverSessionContext,
  serverSessionId,
} from "@nteract/session";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { BUILD_FORMATS } from "../model/document-types.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { hostTreeOf } from "../sync/host-handle.mjs";
import { decodeFrame, encodeFrame } from "../sync/wire.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import {
  ATTACHMENT_MAX_BYTES,
  OIDC_REAUTH_MS,
  encodeSocketAttachment,
  nextAlarmAt,
  parseSocketAttachment,
} from "./hibernation.mjs";
import { Page } from "./index.mjs";
import {
  recordOrganizationMemberships,
  resetMembershipCache,
} from "./organization-memberships.mjs";
import { PROJECT_ACCESS_LEASE_MS } from "./project-access.mjs";
import { PROJECT_LEASE_RENEW_AHEAD_MS } from "./project-lease.mjs";
import { READER_MS } from "./usage-session.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

class SqliteD1 {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const sql of OIDC_SESSION_SCHEMA) this.sqlite.exec(sql);
  }
  prepare(sql) {
    const stmt = this.sqlite.prepare(sql);
    const wrap = (values) => ({
      bind: (...next) => wrap(next),
      first: async () => {
        const row = stmt.get(...values);
        return row ? { ...row } : null;
      },
      all: async () => ({ results: stmt.all(...values).map((row) => ({ ...row })) }),
      run: async () => {
        const result = stmt.run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    });
    return wrap([]);
  }
  async batch(stmts) {
    const out = [];
    for (const stmt of stmts) out.push(await stmt.run());
    return out;
  }
}

class HibernatingSocket extends EventTarget {
  readyState = 1;
  closed = null;
  attachment = null;
  sent = [];
  accept() {}
  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(data) {
    this.other.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.other.closed = { code, reason };
    this.readyState = 3;
    this.other.readyState = 3;
    this.onClosed?.(this);
  }
}

class HibernatingStorage {
  values = new Map();
  alarmAt = null;
  alarmSets = 0;
  alarmDeletes = 0;
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
  async setAlarm(at) {
    this.alarmAt = at;
    this.alarmSets++;
  }
  async deleteAlarm() {
    this.alarmAt = null;
    this.alarmDeletes++;
  }
  async getAlarm() {
    return this.alarmAt;
  }
}

function installHibernatingPair(t) {
  const PreviousPair = globalThis.WebSocketPair;
  const PreviousResponse = globalThis.Response;
  globalThis.WebSocketPair = class WebSocketPair {
    constructor() {
      const a = new HibernatingSocket();
      const b = new HibernatingSocket();
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

test("encodeSocketAttachment strips proofs, keeps domain/org namespaces, enforces 1900-byte cap, and requires sessionCheck", () => {
  const encoded = encodeSocketAttachment({
    senderId: "b-1",
    started: 1000,
    expiresAt: 61_000,
    reauthAt: 61_000,
    projectBound: true,
    joined: ["doc-a", "doc-a"],
    features: ["f1"],
    formats: [{ type: "page", format: 2 }],
    access: { generation: 1, role: "editor", canWrite: true, canComment: true, trashed: false },
    identity: {
      principal: "user:kilo:alice",
      displayName: "Alice",
      accountDisplayName: "Alice Private",
      namespace: "user:kilo",
      credentialKind: "oidc",
      driver: "Browser",
      canWrite: true,
      expiresAt: 900_000,
      domainAccess: { domain: "acme.com", namespace: "user:kilo", expiresAt: 700_000 },
      organizations: [{ id: "org_1", role: "member", namespace: "user:kilo", expiresAt: 700_000 }],
      emailProof: { secret: "must-not-persist" },
      verifiedEmail: "alice@example.com",
      clientProvenance: { agent: "hidden" },
    },
    sessionCheck: {
      entries: [
        { kid: "k1", id: "hmac-id-1" },
        { kid: "k2", id: "hmac-id-2" },
        { kid: "k3", id: "hmac-id-3" },
        { kid: "k4", id: "hmac-id-4" },
      ],
      origin: "https://pages.invalid",
    },
    usageState: { name: "open", nextAt: 31_000 },
    pageId: "page-1",
  });
  assert.ok(encoded);
  const rawJson = JSON.stringify(encoded);
  assert.ok(new TextEncoder().encode(rawJson).byteLength <= ATTACHMENT_MAX_BYTES);
  assert.equal(rawJson.includes("must-not-persist"), false);
  assert.equal(rawJson.includes("alice@example.com"), false);
  assert.deepEqual(encoded.joined, ["doc-a"]);
  assert.equal(encoded.identity.domainAccess.namespace, "user:kilo");
  assert.equal(encoded.identity.organizations[0].namespace, "user:kilo");

  const parsed = parseSocketAttachment(encoded);
  assert.equal(parsed.senderId, "b-1");
  assert.equal(parsed.projectBound, true);
  assert.equal(parsed.sessionCheck.entries.length, 4);
  assert.equal(parsed.sessionCheck.origin, "https://pages.invalid");
  assert.equal(parsed.identity.domainAccess.namespace, "user:kilo");
  assert.equal(parsed.identity.organizations[0].namespace, "user:kilo");
  // More than SESSION_KEYRING_MAX_KEYS (4) entries is rejected.
  assert.equal(
    parseSocketAttachment({
      ...encoded,
      sessionCheck: {
        entries: Array.from({ length: 5 }, (_, i) => ({ kid: `k${i + 1}`, id: `id-${i + 1}` })),
        origin: "https://pages.invalid",
      },
    }),
    null,
  );

  // Missing sessionCheck (e.g. API key) returns null so the host keeps it on the resident path.
  assert.equal(
    encodeSocketAttachment({
      senderId: "b-1",
      started: 1000,
      joined: [],
      features: [],
      access: { generation: 1, role: "viewer", canWrite: false, canComment: false, trashed: false },
      identity: {
        principal: "user:kilo:alice",
        displayName: "Alice",
        namespace: "user:kilo",
        credentialKind: "api-key",
        driver: "API",
        canWrite: true,
        expiresAt: 61_000,
      },
      sessionCheck: null,
    }),
    null,
  );

  // Oversized organization list returns null so the host falls back to resident mode.
  const huge = encodeSocketAttachment({
    senderId: "b-1",
    started: 1000,
    joined: [],
    features: [],
    access: { generation: 1, role: "viewer", canWrite: false, canComment: false, trashed: false },
    identity: {
      principal: "user:kilo:alice",
      displayName: "Alice",
      namespace: "user:kilo",
      credentialKind: "oidc",
      driver: "Browser",
      canWrite: true,
      expiresAt: 900_000,
      organizations: Array.from({ length: 60 }, (_, i) => ({
        id: `org_${String(i).padStart(20, "0")}`,
        role: "member",
        namespace: "user:kilo",
        expiresAt: 900_000,
      })),
    },
    sessionCheck: { entries: [{ kid: "k1", id: "hmac-id-1" }], origin: "https://pages.invalid" },
  });
  assert.equal(huge, null);
  assert.equal(parseSocketAttachment({ v: 999 }), null);
  assert.equal(parseSocketAttachment(null), null);
});

test("nextAlarmAt picks the earliest wake across dwell, reauth, expiry, and Project renewal", () => {
  assert.equal(nextAlarmAt({ sockets: [], projectLeaseState: null, now: 1000 }), null);
  assert.equal(
    nextAlarmAt({
      sockets: [
        {
          closed: false,
          driver: "Browser",
          usageState: { name: "open", nextAt: 31_000 },
          reauthAt: 61_000,
          expiresAt: 60_000,
        },
      ],
      projectLeaseState: { name: "armed", at: 50_000 },
      now: 1_000,
    }),
    31_000,
  );
  assert.equal(
    nextAlarmAt({
      sockets: [
        {
          closed: false,
          driver: "Browser",
          usageState: { name: "open", nextAt: 90_000 },
          reauthAt: 61_000,
          expiresAt: 60_000,
        },
      ],
      projectLeaseState: { name: "armed", at: 50_000 },
      now: 1_000,
    }),
    50_000,
  );
  // Past deadlines clamp to `now`.
  assert.equal(
    nextAlarmAt({
      sockets: [
        { closed: false, driver: "API", usageState: { name: "open", nextAt: 500 }, expiresAt: 800 },
      ],
      projectLeaseState: null,
      now: 1_000,
    }),
    1_000,
  );
});

test("hibernating Page survives cold DO eviction, fires dwell/lease/OIDC alarms, and enforces event-driven revocation push", async (t) => {
  installHibernatingPair(t);
  const startMs = Date.UTC(2026, 10, 21, 12, 0, 0);
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: startMs });

  const usageLines = [];
  t.mock.method(console, "info", (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "pages.usage.v1") usageLines.push(parsed);
    } catch {
      /* ignore */
    }
  });

  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const oidcDb = new SqliteD1();
  const sessionSecret = "test-session-secret-0123456789abcdef0123456789";
  const owner = "user:anaconda-fixture:owner";
  const reader = "user:kilo-oidc:reader";
  const pageId = "99999999-9999-4999-8999-999999999999";
  const projectId = "prj_00000000-0000-4000-8000-000000000009";
  let project = {
    space_id: projectId,
    owner,
    acl: { revision: 1, members: { [reader]: { role: "viewer", generation: 1 } } },
  };
  let projectReads = 0;

  const env = {
    ...auth.env,
    DB: oidcDb,
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://oidc.invalid",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages-test",
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: sessionSecret,
    CATALOGS: {
      getByName: () => ({
        fetch: async () => Response.json({ complete: true, space_id: projectId }),
      }),
    },
    PROJECTS: {
      getByName: () => ({
        fetch: async () => {
          projectReads++;
          return Response.json(project);
        },
      }),
    },
  };

  // Seed a real server OIDC session row in SQLite for `reader`.
  const nowSeconds = Math.floor(startMs / 1000);
  const rawCookieToken = randomSecret();
  const sessionId = await serverSessionId(env, rawCookieToken);
  const sessionCtx = serverSessionContext(env, "https://pages.invalid");
  const appSession = await createServerAppSession(
    env,
    {
      principal: reader,
      scope: "editor",
      metadata: {
        principalNamespace: "kilo-oidc",
        displayName: "Reader",
        emailVerified: false,
      },
    },
    `cache-${sessionId}`,
    nowSeconds + 3600,
    nowSeconds,
  );
  const sealed = await sealServerSecret(
    env,
    { refreshToken: "refresh-token-value" },
    `session:${sessionId}:${sessionCtx}`,
  );
  oidcDb.sqlite
    .prepare(
      `INSERT INTO oidc_server_sessions
      (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at, generation, lease, lease_until, retry_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, 0)`,
    )
    .run(
      sessionId,
      sessionCtx,
      JSON.stringify(appSession),
      sealed,
      nowSeconds + 3600,
      nowSeconds + 3600,
      nowSeconds + 3600,
    );
  const cookieHeader = `${SERVER_SESSION_COOKIE}=${rawCookieToken}`;

  const storage = new HibernatingStorage();
  const acceptedSockets = new Set();
  const makeCtx = () => ({
    id: { name: pageId },
    storage,
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil() {},
    acceptWebSocket(ws) {
      acceptedSockets.add(ws);
      ws.onClosed = (closedWs) => acceptedSockets.delete(closedWs);
    },
    getWebSockets() {
      return [...acceptedSockets].filter((ws) => !ws.closed);
    },
  });

  // 1. Register Page and open hibernating browser OIDC socket.
  let page = new Page(makeCtx(), env);
  const doc = A.change(A.from(createPageData({ pageId, title: "Hibernated Page" })), (draft) =>
    initializePage(draft, "Hello hibernation"),
  );
  const ownerToken = auth.apiKey({ userId: "owner" });
  const registered = await page.fetch(
    new Request("https://pages.invalid/internal/register", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "x-pages-driver": "Browser" },
      body: JSON.stringify({
        page_id: pageId,
        expected_principal: owner,
        document_id: interpretAsDocumentId(generateAutomergeUrl()),
        initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
        title: "Hibernated Page",
        nonce: "register-hibernated-page",
        record_storage: "automerge",
      }),
    }),
  );
  assert.equal(registered.status, 201);

  const openRes = await page.fetch(
    new Request(
      `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}&presence_id=11111111-1111-4111-8111-111111111111&page_id=${pageId}`,
      {
        headers: {
          upgrade: "websocket",
          origin: "https://pages.invalid",
          cookie: cookieHeader,
          "x-pages-driver": "Browser",
        },
      },
    ),
  );
  assert.equal(openRes.status, 101);
  const clientSocket = openRes.webSocket;
  const [serverSocket] = [...acceptedSockets];
  assert.ok(serverSocket, "socket accepted via ctx.acceptWebSocket");
  assert.equal(
    JSON.stringify(serverSocket.attachment).includes(rawCookieToken),
    false,
    "raw session cookie token must never be written into WebSocket attachment",
  );
  assert.equal(storage.alarmAt, startMs + READER_MS, "first alarm set for 30 s page.read dwell");

  // Join the Page document so `joined` is recorded in the attachment.
  const docHex = hostTreeOf(page.metadata.documentId);
  const initialEpoch = page.activityState().epoch;
  const initialRevision = page.activityState().revision;
  await page.webSocketMessage(serverSocket, encodeFrame({ t: "sync", doc: docHex, m: null, r: 1 }));
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
  assert.ok(serverSocket.attachment.joined.includes(docHex));

  // 2. Simulate full DO eviction: construct a brand-new `Page` against the SAME storage & surviving WebSocket!
  page = new Page(makeCtx(), env);
  projectReads = 0;

  // Fire alarm at T + 30 s: cold wake rehydrates socket, preserves activity epoch with
  // strictly greater revision, emits `page.read`, and reschedules to T + 60 s (OIDC re-check).
  t.mock.timers.tick(READER_MS);
  await page.alarm();
  assert.equal(
    page.activityState().epoch,
    initialEpoch,
    "activity epoch survives cold DO eviction so open tabs keep accepting agent updates",
  );
  assert.ok(
    page.activityState().revision > initialRevision,
    "activity revision advances strictly past pre-eviction snapshots",
  );
  assert.ok(
    usageLines.some((line) => line.action === "page.read" && line.principal === reader),
    "30 s alarm emits page.read after cold eviction wake",
  );
  assert.equal(projectReads, 1, "cold wake loads Project snapshot once for Project-bound socket");
  // Cold wake at T + 30 s refreshed Project snapshot to T + 90 s (renew at T + 80 s),
  // so the next earliest wake is the 60 s OIDC re-check.
  assert.equal(storage.alarmAt, startMs + OIDC_REAUTH_MS, "next alarm targets 60 s OIDC re-check");

  // Sync frame after cold wake works seamlessly on the rehydrated connection.
  const beforeSent = clientSocket.sent.length;
  await page.webSocketMessage(serverSocket, encodeFrame({ t: "sync", doc: docHex, m: null, r: 2 }));
  for (let i = 0; i < 6; i++) await new Promise(setImmediate);
  assert.ok(clientSocket.sent.length > beforeSent, "rehydrated socket replies to sync frame");
  const lastFrame = decodeFrame(new Uint8Array(clientSocket.sent.at(-1)));
  assert.equal(lastFrame.t, "sync");

  // Fire alarm at T + 60 s while OIDC session is still active: socket stays open,
  // advances OIDC re-check to T + 120 s, and schedules Project renewal at T + 80 s.
  t.mock.timers.tick(OIDC_REAUTH_MS - READER_MS);
  await page.alarm();
  assert.equal(clientSocket.closed, null, "active OIDC session stays open across 60 s alarm");
  assert.equal(
    storage.alarmAt,
    startMs + READER_MS + PROJECT_ACCESS_LEASE_MS - PROJECT_LEASE_RENEW_AHEAD_MS,
    "next alarm targets Project safety-net renewal (T + 80 s)",
  );

  // Fire alarm at T + 80 s: safety-net Project renewal refreshes snapshot and extends deadline.
  t.mock.timers.tick(
    READER_MS + PROJECT_ACCESS_LEASE_MS - PROJECT_LEASE_RENEW_AHEAD_MS - OIDC_REAUTH_MS,
  );
  await page.alarm();
  assert.equal(clientSocket.closed, null);
  assert.equal(projectReads, 2, "safety-net renewal fetches Project once");
  assert.equal(storage.alarmAt, startMs + 2 * OIDC_REAUTH_MS);

  // 3. Event-driven revocation push: owner removes reader from Project and pushes `/internal/project-access-changed`.
  project = { space_id: projectId, owner, acl: { revision: 2, members: {} } };
  const pushRes = await page.fetch(
    new Request("https://pages.invalid/internal/project-access-changed", { method: "POST" }),
  );
  assert.equal(pushRes.status, 204);
  assert.deepEqual(
    clientSocket.closed,
    { code: 4409, reason: "access_changed" },
    "event-driven Project push closes revoked reader immediately without waiting for the 60 s lease",
  );
  assert.equal(storage.alarmAt, null, "alarm deleted once the last socket closes");

  // 4. Re-add reader, open a second hibernated socket, then revoke the OIDC session in D1:
  // the 60 s alarm closes the socket with 4401 sign_in_required.
  project = {
    space_id: projectId,
    owner,
    acl: { revision: 3, members: { [reader]: { role: "viewer", generation: 2 } } },
  };
  const openRes2 = await page.fetch(
    new Request(
      `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}&presence_id=22222222-2222-4222-8222-222222222222&page_id=${pageId}`,
      {
        headers: {
          upgrade: "websocket",
          origin: "https://pages.invalid",
          cookie: cookieHeader,
          "x-pages-driver": "Browser",
        },
      },
    ),
  );
  assert.equal(openRes2.status, 101);
  const clientSocket2 = openRes2.webSocket;
  await revokeServerSession(
    env,
    new Request("https://pages.invalid/api/auth/logout", { headers: { cookie: cookieHeader } }),
  );
  // First the 50 s Project lease alarm extends the Project lease, then the 60 s
  // OIDC alarm wakes a cold DO and closes the revoked session with 4401.
  t.mock.timers.tick(PROJECT_ACCESS_LEASE_MS - PROJECT_LEASE_RENEW_AHEAD_MS);
  await page.alarm();
  assert.equal(clientSocket2.closed, null);
  page = new Page(makeCtx(), env);
  t.mock.timers.tick(OIDC_REAUTH_MS - (PROJECT_ACCESS_LEASE_MS - PROJECT_LEASE_RENEW_AHEAD_MS));
  await page.alarm();
  assert.deepEqual(clientSocket2.closed, { code: 4401, reason: "sign_in_required" });

  // 5. Push to a cold DO with zero open sockets returns 204 without booting Automerge.
  const idlePage = new Page(makeCtx(), env);
  const idlePush = await idlePage.fetch(
    new Request("https://pages.invalid/internal/project-access-changed", { method: "POST" }),
  );
  assert.equal(idlePush.status, 204);
  assert.equal(idlePage.plain, undefined, "idle push does not boot Automerge document");

  // 6. API-key sockets stay on the resident path (not registered via acceptWebSocket).
  const beforeAccepted = acceptedSockets.size;
  const apiKeyRes = await page.fetch(
    new Request(
      `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}&presence_id=33333333-3333-4333-8333-333333333333&page_id=${pageId}`,
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${ownerToken}`,
          "x-pages-driver": "Browser",
        },
      },
    ),
  );
  assert.equal(apiKeyRes.status, 101);
  assert.equal(acceptedSockets.size, beforeAccepted, "non-OIDC socket stays on resident path");
  await page.plain?.close();
});

test("domain-grant and organization-grant readers hibernate and survive cold DO eviction, and env context change closes on alarm", async (t) => {
  installHibernatingPair(t);
  resetMembershipCache();
  const startMs = Date.UTC(2026, 10, 21, 14, 0, 0);
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: startMs });

  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const dbFixture = sqliteD1(t);
  const oidcDb = dbFixture.open();
  for (const sql of OIDC_SESSION_SCHEMA) await oidcDb.prepare(sql).run();
  const sessionSecret = "test-session-secret-0123456789abcdef0123456789";
  const namespace = "user:kilo";
  const owner = `${namespace}:owner`;
  const domainPrincipal = `${namespace}:domain-reader`;
  const orgPrincipal = `${namespace}:org-reader`;
  const domainPageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const orgPageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const nowSeconds = Math.floor(startMs / 1000);

  const env = {
    DB: oidcDb,
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://oidc.invalid",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages-test",
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: sessionSecret,
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: namespace,
    PAGES_KILO_APP_URL: "https://kilo.invalid",
    PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com",
    CATALOGS: {
      getByName: () => ({ fetch: async () => Response.json({ complete: true, space_id: null }) }),
    },
    PROJECTS: {
      getByName: () => ({ fetch: async () => new Response("not found", { status: 404 }) }),
    },
  };

  await recordOrganizationMemberships(
    env,
    orgPrincipal,
    [{ id: "org-acme", name: "Acme" }],
    startMs,
  );

  const seedSession = async (principal, metadata) => {
    const token = randomSecret();
    const id = await serverSessionId(env, token);
    const ctx = serverSessionContext(env, "https://pages.invalid");
    const appSession = await createServerAppSession(
      env,
      { principal, scope: "editor", metadata },
      `cache-${id}`,
      nowSeconds + 3600,
      nowSeconds,
    );
    const sealed = await sealServerSecret(env, { refreshToken: "rt" }, `session:${id}:${ctx}`);
    await oidcDb
      .prepare(
        `INSERT INTO oidc_server_sessions
        (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at, generation, lease, lease_until, retry_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, 0)`,
      )
      .bind(
        id,
        ctx,
        JSON.stringify(appSession),
        sealed,
        nowSeconds + 3600,
        nowSeconds + 3600,
        nowSeconds + 3600,
      )
      .run();
    return `${SERVER_SESSION_COOKIE}=${token}`;
  };

  const ownerCookie = await seedSession(owner, {
    principalNamespace: namespace,
    displayName: "Owner",
    emailVerified: false,
  });
  const domainCookie = await seedSession(domainPrincipal, {
    principalNamespace: namespace,
    displayName: "Domain Reader",
    email: "alice@anaconda.com",
    emailVerified: true,
  });
  const orgCookie = await seedSession(orgPrincipal, {
    principalNamespace: namespace,
    displayName: "Org Reader",
    emailVerified: false,
  });

  const domainEnv = {
    ...env,
    PAGES_KILO_APP_URL: undefined,
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: namespace,
  };
  const makePageHost = async (pageId, aclPatch, hostEnv = env) => {
    const storage = new HibernatingStorage();
    const acceptedSockets = new Set();
    const makeCtx = () => ({
      id: { name: pageId },
      storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
      acceptWebSocket(ws) {
        acceptedSockets.add(ws);
        ws.onClosed = (closedWs) => acceptedSockets.delete(closedWs);
      },
      getWebSockets() {
        return [...acceptedSockets].filter((ws) => !ws.closed);
      },
    });
    let page = new Page(makeCtx(), hostEnv);
    const doc = A.change(A.from(createPageData({ pageId, title: "Audience Page" })), (draft) =>
      initializePage(draft, "Shared"),
    );
    const reg = await page.fetch(
      new Request("https://pages.invalid/internal/register", {
        method: "POST",
        headers: {
          origin: "https://pages.invalid",
          cookie: ownerCookie,
          "x-pages-driver": "Browser",
        },
        body: JSON.stringify({
          page_id: pageId,
          expected_principal: owner,
          document_id: interpretAsDocumentId(generateAutomergeUrl()),
          initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
          title: "Audience Page",
          nonce: `register-${pageId}`,
          record_storage: "automerge",
        }),
      }),
    );
    assert.equal(reg.status, 201);
    const record = await storage.get("host/document");
    record.acl = { revision: 1, members: {}, invites: {}, ...aclPatch };
    await storage.put("host/document", record);
    page = new Page(makeCtx(), hostEnv);
    return { page, makeCtx, acceptedSockets, hostEnv };
  };

  const domainHost = await makePageHost(
    domainPageId,
    { domainView: { domain: "anaconda.com", namespace, role: "viewer" } },
    domainEnv,
  );
  const orgHost = await makePageHost(
    orgPageId,
    { organizationAccess: { id: "org-acme", name: "Acme", namespace, role: "viewer" } },
    env,
  );

  const openCookieSync = async (host, pageId, cookie, presenceId) => {
    const res = await host.page.fetch(
      new Request(
        `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}&presence_id=${presenceId}&page_id=${pageId}`,
        {
          headers: {
            upgrade: "websocket",
            origin: "https://pages.invalid",
            cookie,
            "x-pages-driver": "Browser",
          },
        },
      ),
    );
    assert.equal(res.status, 101);
    return res.webSocket;
  };

  const domainClient = await openCookieSync(
    domainHost,
    domainPageId,
    domainCookie,
    "11111111-1111-4111-8111-111111111111",
  );
  const orgClient = await openCookieSync(
    orgHost,
    orgPageId,
    orgCookie,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(domainHost.acceptedSockets.size, 1, "domain reader accepted via hibernation");
  assert.equal(orgHost.acceptedSockets.size, 1, "org reader accepted via hibernation");
  assert.equal(domainClient.closed, null);
  assert.equal(orgClient.closed, null);

  // Cold DO eviction + 60 s alarm: both domain and org readers keep their access because
  // `namespace` is preserved on `domainAccess` and `organizations` in the attachment.
  t.mock.timers.tick(OIDC_REAUTH_MS);
  await new Page(domainHost.makeCtx(), domainEnv).alarm();
  await new Page(orgHost.makeCtx(), env).alarm();
  assert.equal(domainClient.closed, null, "domain reader survives cold eviction and 60 s alarm");
  assert.equal(orgClient.closed, null, "org reader survives cold eviction and 60 s alarm");

  // Removing the org reader from the organization directory closes their hibernated
  // socket with 4409 access_changed on the next 60 s alarm.
  await recordOrganizationMemberships(env, orgPrincipal, [], Date.now());
  resetMembershipCache();
  t.mock.timers.tick(OIDC_REAUTH_MS);
  await new Page(orgHost.makeCtx(), env).alarm();
  assert.deepEqual(
    orgClient.closed,
    { code: 4409, reason: "access_changed" },
    "directory removal closes hibernated organization socket on alarm",
  );

  // Malformed frame on a hibernated socket closes cleanly with 4400 request_rejected.
  const [domainServerSocket] = [...domainHost.acceptedSockets];
  const domainPageBeforeClose = new Page(domainHost.makeCtx(), domainEnv);
  await domainPageBeforeClose.webSocketMessage(domainServerSocket, "not-binary");
  assert.deepEqual(domainClient.closed, { code: 4400, reason: "request_rejected" });

  // Open a fresh domain socket, then verify cold webSocketClose fast-path + env rotation.
  const domainClient2 = await openCookieSync(
    domainHost,
    domainPageId,
    domainCookie,
    "33333333-3333-4333-8333-333333333333",
  );
  const [domainServer2] = [...domainHost.acceptedSockets];
  // Simulate peer closing while DO is cold (no surviving sockets left).
  domainHost.acceptedSockets.delete(domainServer2);
  const coldClosePage = new Page(domainHost.makeCtx(), domainEnv);
  await coldClosePage.webSocketClose(domainServer2, 1000, "tab-closed");
  assert.equal(coldClosePage.plain, undefined, "cold fast-path close skips Automerge boot");

  // Reopen and verify changing NOTEBOOK_CLOUD_OIDC_CLIENT_ID invalidates on the next alarm.
  const domainClient3 = await openCookieSync(
    domainHost,
    domainPageId,
    domainCookie,
    "44444444-4444-4444-8444-444444444444",
  );
  void domainClient2;
  t.mock.timers.tick(OIDC_REAUTH_MS);
  await new Page(domainHost.makeCtx(), {
    ...domainEnv,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages-rotated",
  }).alarm();
  assert.deepEqual(domainClient3.closed, { code: 4401, reason: "sign_in_required" });
});

test("Space -> Catalog -> Page push delivers /internal/project-access-changed on revocation and cross-Project move", async (t) => {
  const { world } = await import("./projects-fixture.mjs");
  const w = await world(t);
  const createdProject = await w.call("owner", "create_project", {
    title: "Push Project",
    nonce: "push-proj-1",
  });
  assert.equal(createdProject.status, 200);
  const projectId = createdProject.body.project_id;
  const createdPage = await w.createPage({
    title: "Child Page",
    markdown: "In project",
    project_id: projectId,
  });
  assert.equal(createdPage.status, 200);
  const pageId = createdPage.body.page_id;
  await w.settle();

  // Spy on `/internal/project-access-changed` hitting the child Page DO.
  const pushes = [];
  const origGetByName = w.env.PAGES.getByName;
  w.env.PAGES.getByName = (name) => {
    const stub = origGetByName(name);
    return {
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/internal/project-access-changed") pushes.push(name);
        return stub.fetch(request);
      },
    };
  };

  // Add member directly via set_role, then revoke via manage_project_access -> Space pushes via Catalog to child Page!
  const memberPrincipal = "user:anaconda-fixture:member-user";
  const access1 = await w.call("owner", "get_project_access", { project_id: projectId });
  const added = await w.call("owner", "manage_project_access", {
    project_id: projectId,
    action: "set_role",
    principal: memberPrincipal,
    role: "editor",
    expected_revision: access1.body.revision,
    nonce: "push-add-1",
  });
  assert.equal(added.status, 200);
  await w.settle();
  const access2 = await w.call("owner", "get_project_access", { project_id: projectId });
  pushes.length = 0;
  const revoked = await w.call("owner", "manage_project_access", {
    project_id: projectId,
    action: "set_role",
    principal: memberPrincipal,
    role: null,
    expected_revision: access2.body.revision,
    nonce: "push-revoke-1",
  });
  assert.equal(revoked.status, 200);
  await w.settle();
  assert.ok(
    pushes.includes(pageId),
    "Space -> Catalog -> Page push notifies child Page immediately on set_role",
  );
  assert.ok(
    pushes.includes(createdProject.body.document_id),
    "Space also notifies the Project content document directly",
  );

  // Moving a Page out of a Project to Your items notifies the Page directly from Catalog.
  const moveProj = await w.call("owner", "create_project", {
    title: "Move Push Project",
    nonce: "push-proj-move-1",
  });
  assert.equal(moveProj.status, 200);
  const movePageRes = await w.createPage({
    title: "Moved Page",
    markdown: "Will leave project",
    project_id: moveProj.body.project_id,
  });
  assert.equal(movePageRes.status, 200);
  const movePageId = movePageRes.body.page_id;
  await w.settle();
  pushes.length = 0;
  const moved = await w.call("owner", "move_page", {
    page_id: movePageId,
    project_id: null,
    nonce: "push-move-1",
  });
  assert.equal(moved.status, 200);
  await w.settle();
  assert.ok(
    pushes.includes(movePageId),
    "Catalog notifies moved Page immediately when leaving a Project",
  );
});
