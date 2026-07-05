import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloudAppSessionsEqual } from "../viewer/use-cloud-auth.ts";
import type { CloudAppSession } from "../viewer/app-session.ts";

// The app-session content comparator gates the store's identity preservation:
// a content-identical /api/auth/session fetch must not install a fresh object,
// or every effect dependency derived from it (resolveSyncAuth → the live-room
// effect) changes identity and reconnects the live room once per page load. The
// store's applyFetchedSession consumes this comparator; the reference-hold
// behavior is covered end-to-end by the F2 case in cloud-auth-store.test.ts.
describe("cloud app session identity stability", () => {
  const session = (overrides: Partial<CloudAppSession> = {}): CloudAppSession => ({
    provider: "oidc",
    expires_at: 1_750_000_000,
    cache_key: "cache-a",
    ...overrides,
  });

  describe("cloudAppSessionsEqual", () => {
    it("treats content-identical sessions as equal across object identities", () => {
      assert.equal(cloudAppSessionsEqual(session(), session()), true);
    });

    it("compares by reference, null, and each field", () => {
      const a = session();
      assert.equal(cloudAppSessionsEqual(a, a), true);
      assert.equal(cloudAppSessionsEqual(null, null), true);
      assert.equal(cloudAppSessionsEqual(a, null), false);
      assert.equal(cloudAppSessionsEqual(null, a), false);
      assert.equal(cloudAppSessionsEqual(a, session({ expires_at: 1_750_000_001 })), false);
      assert.equal(cloudAppSessionsEqual(a, session({ cache_key: "cache-b" })), false);
    });
  });
});
