import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PersistedNotebookDoc } from "runtimed";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth.ts";
import {
  cloudInstantPaintPrincipalMatcher,
  resolveCloudInstantPaintHandle,
  type CloudInstantPaintOptions,
} from "../viewer/instant-paint.ts";
import { cloudViewerLoadingPolicy } from "../viewer/loading-policy.ts";

function authState(overrides: Partial<CloudPrototypeAuthState>): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: null,
    problem: null,
    ...overrides,
  };
}

async function withSilencedWarnings<T>(run: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = originalWarn;
  }
}

describe("cloudInstantPaintPrincipalMatcher", () => {
  it("matches the exact dev principal derived from the stored user", () => {
    const matcher = cloudInstantPaintPrincipalMatcher(
      authState({ mode: "dev", token: "token", user: "alice smith" }),
    );

    assert.ok(matcher);
    assert.equal(matcher("user:dev:alice%20smith"), true);
    assert.equal(matcher("user:dev:mallory"), false);
  });

  it("matches OIDC principals by encoded subject id segment, namespace-agnostic", () => {
    const matcher = cloudInstantPaintPrincipalMatcher(
      authState({
        mode: "oidc",
        token: "token",
        oidcClaims: { sub: "auth0|abc 123" },
      }),
    );

    assert.ok(matcher);
    // The worker's namespace prefix is server-configured; only the encoded
    // subject id segment is client-derivable.
    assert.equal(matcher("user:oidc:auth0%7Cabc%20123"), true);
    assert.equal(matcher("user:anaconda:auth0%7Cabc%20123"), true);
    assert.equal(matcher("user:oidc:someone-else"), false);
    // A dev principal can never satisfy an OIDC-derived matcher.
    assert.equal(matcher("user:dev:auth0%7Cabc%20123"), false);
  });

  it("never matches anonymous principals", () => {
    const matcher = cloudInstantPaintPrincipalMatcher(
      authState({ mode: "oidc", token: "token", oidcClaims: { sub: "abc" } }),
    );

    assert.ok(matcher);
    assert.equal(matcher("anonymous:abc"), false);
  });

  it("accepts expired OIDC claims only when an app-session cookie backs them", () => {
    const expired = authState({ mode: "oidc_expired", oidcClaims: { sub: "abc" } });

    assert.equal(cloudInstantPaintPrincipalMatcher(expired), null);
    const matcher = cloudInstantPaintPrincipalMatcher(expired, { hasAppSession: true });
    assert.ok(matcher);
    assert.equal(matcher("user:oidc:abc"), true);
  });

  it("derives no principal for anonymous and invalid auth states", () => {
    assert.equal(cloudInstantPaintPrincipalMatcher(authState({ mode: "anonymous" })), null);
    assert.equal(
      cloudInstantPaintPrincipalMatcher(authState({ mode: "invalid", token: "x", user: "u" })),
      null,
    );
  });
});

describe("resolveCloudInstantPaintHandle", () => {
  const PRINCIPAL = "user:dev:alice";

  function record(
    principal: string,
    bytes: Uint8Array = new Uint8Array([1, 2]),
  ): PersistedNotebookDoc {
    return { bytes, meta: { headsHex: ["aa"], savedAt: 1, principal, schemaVersion: 1 } };
  }

  function createHarness(input: { notebook?: PersistedNotebookDoc; cache?: PersistedNotebookDoc }) {
    const calls: string[] = [];
    const options: CloudInstantPaintOptions<string> = {
      matchesPrincipal: (principal) => principal === PRINCIPAL,
      loadNotebookRecord: async () => {
        calls.push("loadNotebook");
        return input.notebook;
      },
      loadRuntimeStateCacheRecord: async () => {
        calls.push("loadCache");
        return input.cache;
      },
      clearRuntimeStateCacheRecord: async () => {
        calls.push("clearCache");
      },
      loadRenderHandle: async (_notebookBytes, runtimeStateBytes) => {
        calls.push(runtimeStateBytes ? "load(pair)" : "load(cells-only)");
        return runtimeStateBytes ? "paired-handle" : "cells-only-handle";
      },
    };
    return { calls, options };
  }

  it("paints cells AND outputs when both records pass the principal gate", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: record(PRINCIPAL) });
    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: "paired-handle", outcome: "painted" });
    assert.deepEqual(harness.calls, ["loadNotebook", "loadCache", "load(pair)"]);
  });

  it("degrades to cells-only when no runtime cache record exists", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL) });
    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: "cells-only-handle", outcome: "painted_cells_only" });
  });

  it("skips the paint without reading storage when no principal is derivable", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL) });
    const resolved = await resolveCloudInstantPaintHandle({
      ...harness.options,
      matchesPrincipal: null,
    });

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_no_principal" });
    assert.deepEqual(harness.calls, []);
  });

  it("skips on notebook principal mismatch and clears nothing", async () => {
    const harness = createHarness({ notebook: record("user:dev:mallory") });
    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_principal_mismatch" });
    assert.deepEqual(harness.calls, ["loadNotebook", "loadCache"]);
  });

  it("skips on cache principal mismatch and clears nothing", async () => {
    const harness = createHarness({
      notebook: record(PRINCIPAL),
      cache: record("user:dev:mallory"),
    });
    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_principal_mismatch" });
    assert.equal(harness.calls.includes("clearCache"), false);
  });

  it("clears only the cache record for a torn cache envelope and paints cells-only", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: { meta: null } });
    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: "cells-only-handle", outcome: "painted_cells_only" });
    assert.deepEqual(harness.calls, [
      "loadNotebook",
      "loadCache",
      "clearCache",
      "load(cells-only)",
    ]);
  });

  it("clears the cache record when load_snapshot rejects, then paints cells-only", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: record(PRINCIPAL) });
    const loadRenderHandle = harness.options.loadRenderHandle;
    harness.options.loadRenderHandle = async (notebookBytes, runtimeStateBytes) => {
      if (runtimeStateBytes) {
        harness.calls.push("load(pair)");
        throw new Error("corrupt runtime-state bytes");
      }
      return loadRenderHandle(notebookBytes, runtimeStateBytes);
    };

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle(harness.options),
    );

    assert.deepEqual(resolved, { handle: "cells-only-handle", outcome: "painted_cells_only" });
    assert.deepEqual(harness.calls, [
      "loadNotebook",
      "loadCache",
      "load(pair)",
      "clearCache",
      "load(cells-only)",
    ]);
  });

  it("never clears the cache for transient WASM asset failures", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: record(PRINCIPAL) });
    harness.options.loadRenderHandle = async () => {
      harness.calls.push("load(pair)");
      throw new Error("runtimed WASM asset failed: import timed out");
    };
    harness.options.isTransientLoadFailure = (error) =>
      error instanceof Error && error.message.startsWith("runtimed WASM asset failed");

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle(harness.options),
    );

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_unloadable" });
    assert.equal(harness.calls.includes("clearCache"), false);
  });

  it("skips without clearing when the notebook bytes themselves fail to load", async () => {
    const harness = createHarness({ notebook: record(PRINCIPAL) });
    harness.options.loadRenderHandle = async () => {
      throw new Error("automerge load failed");
    };

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle(harness.options),
    );

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_unloadable" });
    assert.equal(harness.calls.includes("clearCache"), false);
  });

  it("fails open as skipped_read_failed without clearing when the read hangs", async () => {
    const harness = createHarness({});
    harness.options.loadNotebookRecord = () => new Promise(() => undefined);
    harness.options.readTimeoutMs = 5;

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle(harness.options),
    );

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_read_failed" });
    assert.equal(harness.calls.includes("clearCache"), false);
  });

  it("race guard: a live materialization landing during the read skips the paint", async () => {
    // The fast-network race: the cache read settles AFTER the live room
    // already materialized. No handle is created — stale cache must never
    // overwrite live pixels.
    let liveMaterialized = false;
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: record(PRINCIPAL) });
    harness.options.shouldContinue = () => !liveMaterialized;
    harness.options.loadNotebookRecord = async () => {
      liveMaterialized = true; // live connect wins while IDB reads
      return record(PRINCIPAL);
    };

    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_superseded" });
    assert.equal(
      harness.calls.some((call) => call.startsWith("load(")),
      false,
    );
  });
});

describe("instant paint mutual exclusion and session wiring", () => {
  it("the loading policy never enables the live-room and pinned-snapshot paints together", () => {
    const pinned = cloudViewerLoadingPolicy({ headsHash: "abc" });
    const live = cloudViewerLoadingPolicy({ headsHash: null });

    assert.deepEqual(
      [pinned.shouldConnectLiveRoom, pinned.shouldFetchSnapshotRender],
      [false, true],
    );
    assert.deepEqual([live.shouldConnectLiveRoom, live.shouldFetchSnapshotRender], [true, false]);
  });

  // Source pins for wiring that cannot run under node (the session hook
  // imports the component-bearing notebook surface).
  const sessionSource = readFileSync(
    new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
    "utf8",
  );

  it("kicks the instant paint only with a healthy adapter and no poison-pill skip", () => {
    assert.match(
      sessionSource,
      /if \(persistenceAdapter && !skipSeedOnThisAttempt\) \{\s*void paintFromPersistedSnapshot\(\)/,
    );
  });

  it("guards every instant-paint apply on the live-materialization race flag", () => {
    assert.match(
      sessionSource,
      /const instantPaintFresh = \(\) => !disposed && !liveMaterializedRef\.current;/,
    );
  });

  it("frees the throwaway render handle after materialization", () => {
    assert.match(sessionSource, /\} finally \{\s*renderHandle\.free\(\);\s*\}/);
  });
});
