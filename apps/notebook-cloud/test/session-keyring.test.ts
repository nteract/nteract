import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSessionKeyring,
  parseSessionKeyring,
  sessionKeyring,
  SessionKeyringError,
  splitSealed,
} from "../src/session-keyring.ts";
import {
  openServerSecret,
  sealServerSecret,
  serverSessionId,
  serverSessionIds,
} from "../src/oidc-session-store.ts";

const A = "a".repeat(32);
const B = "b".repeat(48);
const C = "c".repeat(40);

const keys = (active: string, entries: Record<string, string>, extra = {}) =>
  JSON.stringify({ active, keys: entries, ...extra });

describe("session keyring configuration", () => {
  it("synthesizes k1 from the single secret and nothing from a short one", () => {
    assert.deepEqual(sessionKeyring({ NOTEBOOK_CLOUD_APP_SESSION_SECRET: A }), {
      active: { kid: "k1", secret: A },
      keys: [{ kid: "k1", secret: A }],
      source: "secret",
    });
    assert.equal(sessionKeyring({ NOTEBOOK_CLOUD_APP_SESSION_SECRET: "short" }), null);
    assert.equal(sessionKeyring({}), null);
    assert.equal(sessionKeyring(undefined), null);
  });

  it("puts the active key first and ignores the single secret when a keyring is set", () => {
    const keyring = sessionKeyring({
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: C,
      NOTEBOOK_CLOUD_APP_SESSION_KEYS: keys(
        "k2",
        { k1: A, k2: B },
        { activated_at: { k2: "2026-11-06T00:00:00Z" } },
      ),
    })!;
    assert.equal(keyring.source, "keyring");
    assert.deepEqual(
      keyring.keys.map(({ kid }) => kid),
      ["k2", "k1"],
    );
    assert.equal(keyring.active, keyring.keys[0]);
  });

  for (const [label, raw, reason] of [
    ["not JSON", "{", /not JSON/],
    ["an array", "[]", /expected a JSON object/],
    ["unknown fields", JSON.stringify({ active: "k1", keys: { k1: A }, x: 1 }), /unknown field/],
    ["no keys", keys("k1", {}), /1 to 4 keys/],
    ["five keys", keys("k1", { k1: A, k2: B, k3: C, k4: A + "d", k5: A + "e" }), /1 to 4 keys/],
    ["a dotted kid", keys("k.1", { "k.1": A }), /a kid must be/],
    ["a long kid", keys("k".repeat(33), { ["k".repeat(33)]: A }), /a kid must be/],
    ["a short secret", keys("k1", { k1: "x".repeat(31) }), /shorter than 32 bytes/],
    ["a non-string secret", JSON.stringify({ active: "k1", keys: { k1: 7 } }), /not a string/],
    ["whitespace", keys("k1", { k1: ` ${A}` }), /surrounding whitespace/],
    ["a shared secret", keys("k1", { k1: A, k2: A }), /share a secret/],
    ["a missing active", keys("k3", { k1: A }), /active must name a kid/],
    ["no active", JSON.stringify({ keys: { k1: A } }), /active must name a kid/],
    [
      "a bad activation time",
      keys("k1", { k1: A }, { activated_at: { k1: "soon" } }),
      /activated_at/,
    ],
    [
      "an activation for an absent kid",
      keys("k1", { k1: A }, { activated_at: { k2: "2026-11-06T00:00:00Z" } }),
      /activated_at/,
    ],
  ] as const)
    it(`refuses ${label}`, () => {
      assert.throws(() => parseSessionKeyring(raw), reason);
      const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: A, NOTEBOOK_CLOUD_APP_SESSION_KEYS: raw };
      // Every use throws, including repeated ones served from the cache.
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.throws(() => sessionKeyring(env), SessionKeyringError);
        assert.throws(() => assertSessionKeyring(env), reason);
      }
    });

  it("never puts a secret in its error", () => {
    const secret = "s".repeat(20) + "-private";
    try {
      parseSessionKeyring(keys("k1", { k1: secret }));
      assert.fail("expected an error");
    } catch (error) {
      assert.doesNotMatch(String(error), /private/);
    }
  });

  it("splits kid-prefixed and bare seals", () => {
    assert.deepEqual(splitSealed("iv.ct"), { kid: "k1", rest: ["iv", "ct"] });
    assert.deepEqual(splitSealed("k2.iv.ct"), { kid: "k2", rest: ["iv", "ct"] });
  });
});

describe("sealed sign-in state across a rotation", () => {
  const legacy = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: A };
  const k1Only = { NOTEBOOK_CLOUD_APP_SESSION_KEYS: keys("k1", { k1: A }) };
  const rotated = { NOTEBOOK_CLOUD_APP_SESSION_KEYS: keys("k2", { k1: A, k2: B }) };
  const retired = { NOTEBOOK_CLOUD_APP_SESSION_KEYS: keys("k2", { k2: B }) };

  it("keeps the bare format under the single secret and prefixes the kid under a keyring", async () => {
    const bare = await sealServerSecret(legacy, { v: 1 }, "bind");
    assert.match(bare, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(await sealServerSecret(k1Only, { v: 1 }, "bind"), /^k1\./);
    assert.match(await sealServerSecret(rotated, { v: 1 }, "bind"), /^k2\./);
  });

  it("opens bare blobs as k1 and prefixed blobs by their kid", async () => {
    const bare = await sealServerSecret(legacy, { v: "bare" }, "bind");
    const k2 = await sealServerSecret(rotated, { v: "k2" }, "bind");
    assert.deepEqual(await openServerSecret(rotated, bare, "bind"), { v: "bare" });
    assert.deepEqual(await openServerSecret(k1Only, bare, "bind"), { v: "bare" });
    assert.deepEqual(await openServerSecret(rotated, k2, "bind"), { v: "k2" });
    assert.deepEqual(await openServerSecret(retired, k2, "bind"), { v: "k2" });
    // The single secret has no k2; a keyring without k1 can't open bare blobs.
    await assert.rejects(openServerSecret(legacy, k2, "bind"), /Invalid encrypted session/);
    await assert.rejects(openServerSecret(retired, bare, "bind"), /Invalid encrypted session/);
    await assert.rejects(openServerSecret(rotated, k2, "other"));
  });

  it("refuses an unknown kid and a kid that names the wrong key", async () => {
    const k2 = await sealServerSecret(rotated, { v: 1 }, "bind");
    await assert.rejects(
      openServerSecret(rotated, "k9" + k2.slice(2), "bind"),
      /Invalid encrypted session/,
    );
    await assert.rejects(openServerSecret(rotated, "k1" + k2.slice(2), "bind"));
    await assert.rejects(openServerSecret(rotated, k2 + ".extra", "bind"));
  });

  it("derives session ids with the active key first and the legacy id unchanged", async () => {
    const token = "t".repeat(43);
    const legacyId = await serverSessionId(legacy, token);
    assert.equal(await serverSessionId(k1Only, token), legacyId);
    const ids = await serverSessionIds(rotated, token);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], await serverSessionId(rotated, token));
    assert.equal(ids[1], legacyId);
    assert.notEqual(ids[0], legacyId);
    assert.deepEqual(await serverSessionIds(retired, token), [ids[0]]);
  });
});
