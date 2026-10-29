import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import {
  ADMISSION_CAPABILITY,
  ADMISSION_OUTCOMES,
  admissionCloseOutcome,
} from "../shared/admission.mjs";
import {
  ADMISSION_CODES,
  ADMISSION_REASONS,
  admissionCloseCode,
  admissionCode,
  admissionReason,
  logAdmissionDenied,
  withAdmissionReason,
} from "./admission-reasons.mjs";
import { authenticate } from "./auth.mjs";
import { default as gateway, Page } from "./index.mjs";
import { DocumentPolicy, PermissionDenied, admissionCancelled } from "./policy.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";

test("every internal reason maps to one client code with a distinct close code", () => {
  for (const [reason, code] of Object.entries(ADMISSION_REASONS)) {
    assert.ok(Object.hasOwn(ADMISSION_CODES, code), `${reason} maps to a known code`);
    assert.match(reason, /^[a-z_]+$/);
  }
  const closes = Object.values(ADMISSION_CODES).map(({ close }) => close);
  assert.equal(new Set(closes).size, closes.length);
  for (const close of closes) assert.ok(close >= 4000 && close <= 4999);
  // Unauthorized and missing Pages cannot be told apart by code.
  assert.equal(ADMISSION_REASONS.page_not_found, ADMISSION_REASONS.page_no_grant);
  assert.equal(ADMISSION_REASONS.page_access_removed, ADMISSION_REASONS.page_no_grant);
  assert.throws(() => withAdmissionReason(Error("x"), "made_up"), /Unknown admission reason/);
  assert.throws(() => withAdmissionReason(Error("x"), "page_deleted", "made_up"), /Unknown/);
});

test("classification is closed: unknown codes and statuses fall back to fixed reasons", () => {
  const cases = [
    [Object.assign(Error("token abc"), { code: "private-token", status: 500 }), "server_error"],
    [Object.assign(Error("x"), { name: "AuthError" }), "credential_invalid"],
    [Object.assign(Error("x"), { status: 429 }), "connection_capacity"],
    [Object.assign(Error("x"), { status: 426 }), "invalid_request"],
    [new PermissionDenied(), "page_no_grant"],
    [admissionCancelled("native_admission_timeout"), "native_admission_timeout"],
    [new PermissionDenied("x", "native_binding_mismatch"), "native_binding_mismatch"],
    [Object.assign(Error("x"), { code: "oauth_invalid_token", status: 401 }), "credential_invalid"],
  ];
  for (const [error, reason] of cases) assert.equal(admissionReason(error), reason);
  assert.equal(
    admissionCode(new PermissionDenied("x", "native_key_capacity")),
    "signing_key_rejected",
  );
  assert.equal(admissionCloseCode(new PermissionDenied("x", "native_acl_committing")), 4409);
  assert.equal(admissionCloseCode(admissionCancelled()), 4503);
  // A throw site may hide a deletion from strangers without losing the log reason.
  const hidden = withAdmissionReason(new PermissionDenied(), "page_deleted", "page_access_denied");
  assert.equal(admissionReason(hidden), "page_deleted");
  assert.equal(admissionCode(hidden), "page_access_denied");
});

test("admission logs are one JSON line with no principal, token, message or Page ID", (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  const record = logAdmissionDenied(
    Object.assign(Error(`user:secret@example.com Bearer tok_123 ${pageId}`), {
      status: 403,
      code: "native_binding_pending",
    }),
    {
      stage: "native",
      identity: { credentialKind: "oidc", principal: "user:secret", displayName: "Secret" },
    },
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
  assert.deepEqual(Object.keys(record).sort(), [
    "code",
    "credential",
    "event",
    "reason",
    "service",
    "stage",
    "status",
    "timestamp",
  ]);
  assert.equal(record.reason, "native_binding_pending");
  assert.equal(record.code, "temporarily_unavailable");
  assert.equal(record.credential, "oidc");
  for (const secret of ["secret", "tok_123", pageId, "Bearer"])
    assert.equal(lines[0].includes(secret), false, secret);
  logAdmissionDenied(Error("x"), { stage: "bogus", identity: { credentialKind: "token:abc" } });
  const second = JSON.parse(lines[1]);
  assert.equal(second.stage, "unknown");
  assert.equal(second.credential, "none");
});

test("client close interpretation accepts only matching code and reason pairs", () => {
  assert.deepEqual(admissionCloseOutcome({ code: 4403, reason: "page_access_denied" }), {
    code: "page_access_denied",
    ...ADMISSION_OUTCOMES.page_access_denied,
  });
  assert.equal(admissionCloseOutcome({ code: 4422, reason: "signing_key_rejected" }).retry, "stop");
  assert.equal(admissionCloseOutcome({ code: 4503, reason: "" }).retry, "backoff");
  assert.equal(admissionCloseOutcome({ code: 4403, reason: "temporarily_unavailable" }), undefined);
  for (const code of [1000, 1001, 1006, 4000, 4999])
    assert.equal(admissionCloseOutcome({ code, reason: "Disconnected" }), undefined);
});

async function disclosureFixture(auth, metadata) {
  const owner = `user:anaconda-fixture:${auth.subject}`;
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    env: auth.env,
    ctx: { storage: { get: async () => undefined } },
    tail: Promise.resolve(),
    metadata: metadata && { pageId, documentId: "test", owner, tree: "a".repeat(32), ...metadata },
  });
  page.policy = new DocumentPolicy({
    storage: {},
    metadata: () => page.metadata,
    serverKey: "f".repeat(64),
  });
  const tokens = Object.fromEntries(
    ["owner", "viewer", "never-granted", "removed", "stranger"].map((who) => [
      who,
      who === "owner" ? auth.apiKey() : auth.apiKey({ userId: who }),
    ]),
  );
  const call = async (who, path = "/api/connect", { capable = true } = {}) => {
    const response = await page.run(
      new Request(`https://pages.invalid${path}?page=${pageId}`, {
        method: path === "/api/saved" ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(capable && { [ADMISSION_CAPABILITY.header]: ADMISSION_CAPABILITY.value }),
          ...(path === "/api/sync" && { upgrade: "websocket" }),
        },
        ...(path === "/api/saved" ? { body: JSON.stringify({ heads: ["a".repeat(64)] }) } : {}),
      }),
    );
    return {
      status: response.status,
      headers: [...response.headers].sort(),
      body: await response.text(),
    };
  };
  return { call, owner };
}

const member = (who) => `user:anaconda-fixture:${who}`;
const deniedResponse = {
  status: 403,
  headers: [
    ["cache-control", "no-store"],
    ["content-type", "application/json"],
  ],
  body: JSON.stringify({ error: "Document access denied", code: "page_access_denied" }),
};

test("admission routes answer missing, unreadable and hidden-deleted Pages identically", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "warn", () => {});
  const missing = await disclosureFixture(auth, undefined);
  const existing = await disclosureFixture(auth, { deleted: false });
  const deleted = await disclosureFixture(auth, {
    deleted: true,
    acl: {
      revision: 4,
      members: {
        [member("viewer")]: { role: "viewer", generation: 1 },
        // An owner can write a deny tombstone for someone who never had access.
        [member("never-granted")]: { role: "none", generation: 1 },
        [member("removed")]: { role: "none", generation: 2 },
      },
    },
  });
  for (const path of ["/api/connect", "/api/sync", "/api/saved"]) {
    for (const who of ["stranger", "never-granted", "removed"]) {
      assert.deepEqual(await missing.call(who, path), deniedResponse, `missing ${path} ${who}`);
      assert.deepEqual(await existing.call(who, path), deniedResponse, `unreadable ${path} ${who}`);
      assert.deepEqual(await deleted.call(who, path), deniedResponse, `deleted ${path} ${who}`);
    }
    // Only the owner and current grant holders learn that it was deleted.
    for (const who of ["owner", "viewer"]) {
      const response = await deleted.call(who, path);
      assert.equal(response.status, 404, `${path} ${who}`);
      assert.equal(
        response.body,
        JSON.stringify({ error: "Page not found", code: "page_deleted" }),
      );
    }
  }
});

test("a deployed viewer without the capability still renews a never-created draft", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "warn", () => {});
  const missing = await disclosureFixture(auth, undefined);
  // d53a6e64b viewer/session.mjs reconcileExpiredRegistration renews only when
  // /api/connect fails with this exact status and message.
  const legacyAbsent = ({ status, body }) =>
    status === 404 && JSON.parse(body).error === "Page not found";
  const legacy = await missing.call("owner", "/api/connect", { capable: false });
  assert.equal(legacyAbsent(legacy), true);
  // An unreadable existing Page still answers 403, so legacy clients never
  // mistake revocation for absence.
  const existing = await disclosureFixture(auth, { deleted: false });
  assert.deepEqual(
    await existing.call("stranger", "/api/connect", { capable: false }),
    deniedResponse,
  );
  // The current viewer declares the capability and accepts the unified 403.
  const current = await missing.call("owner", "/api/connect");
  assert.deepEqual(current, deniedResponse);
  assert.equal(legacyAbsent(current), false);
});

test("gateway admission denials carry a client code and log a bounded reason", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(JSON.parse(line)));
  const env = { ...auth.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" };
  const send = async (headers, query = `?page=${pageId}`) => {
    const response = await gateway.fetch(
      new Request(`https://pages.invalid/api/connect${query}`, { headers }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await send({}), {
    status: 401,
    body: { error: "Sign in to Pages", code: "sign_in_required" },
  });
  assert.equal(lines.at(-1).reason, "credential_missing");
  assert.equal(
    (await send({ cookie: "x=1", origin: "https://evil.invalid" })).body.code,
    "request_rejected",
  );
  assert.equal(lines.at(-1).reason, "origin_rejected");
  assert.equal((await send({ authorization: "Basic abc" })).body.code, "sign_in_required");
  assert.equal(lines.at(-1).reason, "credential_invalid");
  assert.equal(
    (await send({ authorization: `Bearer ${auth.apiKey()}` }, "?page=bad")).body.code,
    "request_rejected",
  );
  assert.equal(lines.at(-1).reason, "invalid_request");
  assert.equal(lines.at(-1).credential, "api-key");
  // A provider that cannot be reached is not a credential verdict.
  const unavailable = await send({ authorization: "Bearer unreachable.provider.fixture" });
  assert.equal(unavailable.body.code, "temporarily_unavailable");
  assert.equal(lines.at(-1).reason, "credential_unverified");
  await assert.rejects(
    authenticate(
      new Request("https://pages.invalid/api/sync", {
        headers: { authorization: "Bearer pages_x" },
      }),
      env,
    ),
    (error) => admissionReason(error) === "credential_scope",
  );
});
