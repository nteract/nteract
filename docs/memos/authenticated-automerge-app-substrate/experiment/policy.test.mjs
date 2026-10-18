import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessRegistry, PermissionDenied } from "./policy.mjs";

const doc = "01".repeat(16);
const runtime = "02".repeat(16);
// Isolated policy tests own this verifier fixture; integration tests use auth.mjs.
const fixtureVerifier = () => true;
async function signIn(registry, principal, options = {}) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  const identity = {
    principal,
    displayName: principal,
    driver: "test driver",
    credentialKind: "oidc",
    canWrite: true,
    expiresAt: Date.now() + 120_000,
    ...options,
  };
  const challenge = registry.beginBinding(identity, key);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", pair.privateKey, challenge.message),
  );
  await registry.finishBinding(challenge.id, signature);
  return { key, pair, identity, challenge, signature };
}

test("enrollment proofs are single-use and cannot relabel an active signing key", async () => {
  const registry = new AccessRegistry({ isVerifiedIdentity: fixtureVerifier });
  const alice = await signIn(registry, "issuer:alice");
  await assert.rejects(
    registry.finishBinding(alice.challenge.id, alice.signature),
    PermissionDenied,
  );
  const bad = registry.beginBinding({ ...alice.identity, principal: "issuer:bob" }, alice.key);
  await assert.rejects(registry.finishBinding(bad.id, alice.signature), PermissionDenied);
  const rebind = registry.beginBinding({ ...alice.identity, principal: "issuer:bob" }, alice.key);
  const proof = new Uint8Array(
    await crypto.subtle.sign("Ed25519", alice.pair.privateKey, rebind.message),
  );
  await assert.rejects(registry.finishBinding(rebind.id, proof), /distinct signing key/);
  assert.equal(registry.getBinding(alice.key).principal, "issuer:alice");
});

test("ACL roles, credential bounds, and runtime authority remain independent of payload", async () => {
  const registry = new AccessRegistry({ isVerifiedIdentity: fixtureVerifier });
  const writer = await signIn(registry, "writer");
  const reader = await signIn(registry, "reader");
  const stranger = await signIn(registry, "stranger");
  const restricted = await signIn(registry, "writer", {
    credentialKind: "api-key",
    canWrite: false,
  });
  const service = await signIn(registry, "runtime-service", { credentialKind: "api-key" });
  registry.setDocument(doc, { profile: "typed", grants: { writer: "writer", reader: "reader" } });
  registry.setDocument(runtime, {
    profile: "runtime",
    grants: { writer: "writer", "runtime-service": "writer" },
    runtimeWriters: ["runtime-service"],
  });
  const policy = registry.policy();
  policy.authorizeFetch(reader.key, doc);
  policy.authorizePut(writer.key, writer.key, doc);
  assert.throws(() => policy.authorizeFetch(stranger.key, doc), PermissionDenied);
  for (const [requestor, author] of [
    [reader.key, reader.key],
    [writer.key, reader.key],
    [restricted.key, writer.key],
  ])
    assert.throws(() => policy.authorizePut(requestor, author, doc), PermissionDenied);
  assert.throws(() => policy.authorizePut(writer.key, writer.key, runtime), /Runtime authority/);
  policy.authorizePut(service.key, service.key, runtime);
  assert.throws(() => registry.setDocument(runtime, { profile: "generic" }), /already registered/);
  assert.throws(() => registry.setDocument(doc + "0".repeat(32)), /Invalid host document/);
  assert.deepEqual(policy.filterAuthorizedFetch(reader.key, [doc, runtime]), [doc]);
});

test("revocation and expiry apply to policy calls and trusted presence projection", async () => {
  let now = Date.now();
  const registry = new AccessRegistry({
    now: () => now,
    leaseMs: 5000,
    isVerifiedIdentity: fixtureVerifier,
  });
  const writer = await signIn(registry, "alice", { displayName: "Alice", driver: "ChatGPT" });
  registry.setDocument(doc, { grants: { alice: "reader" } });
  registry.ephemeralPolicy().authorizePublish(writer.key, doc);
  const projected = registry.presence(writer.key, doc, {
    principal: "mallory",
    displayName: "Mallory",
    driver: "admin",
    anchor: "block:1",
  });
  assert.equal(projected.displayName, "Alice");
  assert.equal(projected.driver, "ChatGPT");
  assert.equal(projected.principal, "alice");
  registry.setRole(doc, "alice", "none");
  assert.deepEqual(registry.ephemeralPolicy().filterAuthorizedSubscribers(doc, [writer.key]), []);
  assert.throws(() => registry.presence(writer.key, doc, {}), PermissionDenied);
  registry.setRole(doc, "alice", "reader");
  now += 5001;
  assert.throws(() => registry.policy().authorizeFetch(writer.key, doc), PermissionDenied);
  assert.throws(() => registry.policy().authorizeConnect(writer.key), PermissionDenied);
});

test("revocation fences a proof already being verified", async () => {
  const registry = new AccessRegistry({ isVerifiedIdentity: fixtureVerifier });
  const writer = await signIn(registry, "alice");
  const challenge = registry.beginBinding(writer.identity, writer.key);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", writer.pair.privateKey, challenge.message),
  );
  const completion = registry.finishBinding(challenge.id, signature);
  registry.revokeKey(writer.key);
  await assert.rejects(completion, /revoked during enrollment/);
  assert.throws(() => registry.getBinding(writer.key), PermissionDenied);
});

// Revocation outlives one session or pending proof within this host registry.
test("a revoked key cannot enroll again even with a current verified identity", async () => {
  const registry = new AccessRegistry({ isVerifiedIdentity: fixtureVerifier });
  const writer = await signIn(registry, "alice");
  registry.revokeKey(writer.key);
  assert.throws(() => registry.beginBinding(writer.identity, writer.key), /revoked/);
  assert.throws(() => registry.getBinding(writer.key), PermissionDenied);
  const replacement = await signIn(registry, "alice");
  assert.notEqual(replacement.key, writer.key);
  assert.equal(registry.getBinding(replacement.key).principal, "alice");
});
