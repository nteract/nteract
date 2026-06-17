import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloudAppSessionsEqual,
  nextCloudAppSessionReadyState,
  type CloudAppSessionViewState,
} from "../viewer/use-cloud-auth.ts";
import type { CloudAppSession } from "../viewer/app-session.ts";

// The mount-time /api/auth/session fetch re-confirms a session the page was
// already rendered with. Installing a fresh-but-content-identical session
// object changed the identity of every effect dependency derived from it
// (resolveSyncAuth → the live-room effect), tearing down and reconnecting the
// live room once per page load. The ready-state reducer keeps object
// identities stable so React bails out of the redundant update entirely.
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

  describe("nextCloudAppSessionReadyState", () => {
    it("returns the CURRENT state object when the fetch only confirms it", () => {
      const current: CloudAppSessionViewState = {
        status: "ready",
        session: session(),
        error: null,
      };
      const next = nextCloudAppSessionReadyState(current, session());
      assert.equal(next, current, "content-identical fetch must not produce a new state object");
    });

    it("keeps the current SESSION object when only the wrapper would change", () => {
      const keptSession = session();
      const current: CloudAppSessionViewState = {
        status: "loading",
        session: keptSession,
        error: null,
      };
      const next = nextCloudAppSessionReadyState(current, session());
      assert.notEqual(next, current, "loading → ready is a real transition");
      assert.equal(next.status, "ready");
      assert.equal(next.session, keptSession, "session identity survives the transition");
      assert.equal(next.error, null);
    });

    it("adopts a genuinely different session", () => {
      const current: CloudAppSessionViewState = {
        status: "ready",
        session: session(),
        error: null,
      };
      const renewed = session({ expires_at: 1_750_009_999 });
      const next = nextCloudAppSessionReadyState(current, renewed);
      assert.notEqual(next, current);
      assert.equal(next.session, renewed);
      assert.equal(next.status, "ready");
    });

    it("transitions to ready with null when the fetch reports no session", () => {
      const current: CloudAppSessionViewState = {
        status: "ready",
        session: session(),
        error: null,
      };
      const next = nextCloudAppSessionReadyState(current, null);
      assert.notEqual(next, current);
      assert.deepEqual(next, { status: "ready", session: null, error: null });
    });

    it("clears a previous error even when the session content matches", () => {
      const keptSession = session();
      const current: CloudAppSessionViewState = {
        status: "error",
        session: keptSession,
        error: "fetch failed",
      };
      const next = nextCloudAppSessionReadyState(current, session());
      assert.notEqual(next, current);
      assert.equal(next.status, "ready");
      assert.equal(next.error, null);
      assert.equal(next.session, keptSession);
    });
  });
});
