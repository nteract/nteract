import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  encodePersistedNotebookDoc,
  type PersistedNotebookDoc,
  type StorageAdapter,
  type StorageKey,
} from "runtimed";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth.ts";
import {
  cloudInstantPaintPrincipalMatcher,
  cloudInstantPaintStorageOptions,
  cloudNotebookHandleCaughtUp,
  resolveCloudInstantPaintHandle,
  runCloudInstantPaint,
  shouldDisplayEmptyLiveNotebook,
  type CloudInstantPaintOptions,
  type CloudInstantPaintRunOptions,
} from "../viewer/instant-paint.ts";
import { cloudViewerLoadingPolicy } from "../viewer/loading-policy.ts";
import {
  asRuntimedWasmAssetFailure,
  isRuntimedWasmAssetFailure,
} from "../viewer/runtimed-wasm-failure.ts";

/**
 * The session's exact transient-failure classifier (cloud-viewer-session
 * wires this expression verbatim) — drift between the test's predicate and
 * the shipped one must show up here.
 */
const sessionIsTransientLoadFailure = (error: unknown) =>
  isRuntimedWasmAssetFailure(error instanceof Error ? error.message : String(error));

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
        // A bare load_snapshot rejection carries no asset-failure prefix:
        // through the REAL classifier it must read as corrupt cache.
        throw new Error("corrupt runtime-state bytes");
      }
      return loadRenderHandle(notebookBytes, runtimeStateBytes);
    };
    harness.options.isTransientLoadFailure = sessionIsTransientLoadFailure;

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
      // The terminal init-failure shape the wasm client actually throws.
      throw asRuntimedWasmAssetFailure(new Error("import timed out"));
    };
    harness.options.isTransientLoadFailure = sessionIsTransientLoadFailure;

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle(harness.options),
    );

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_unloadable" });
    assert.equal(harness.calls.includes("clearCache"), false);
  });

  it("treats an absent or torn seed record as nothing to paint, clearing nothing", async () => {
    for (const notebook of [undefined, { meta: null } as PersistedNotebookDoc]) {
      const harness = createHarness({ notebook, cache: record(PRINCIPAL) });
      const resolved = await resolveCloudInstantPaintHandle(harness.options);

      assert.deepEqual(resolved, { handle: null, outcome: "skipped_no_record" });
      // Seeding's post-handshake logic owns whether an unverifiable seed
      // record clears — the paint path must touch neither record.
      assert.equal(harness.calls.includes("clearCache"), false);
    }
  });

  it("a stale attempt never clears the cache after losing the race inside the load", async () => {
    // Seconds can pass inside loadRenderHandle (WASM init ladder); a live
    // session arming persistence meanwhile may have REWRITTEN the cache
    // record. The corrupt-cache clear decision was made against the OLD
    // bytes, so a superseded attempt must skip the delete.
    let liveMaterialized = false;
    const harness = createHarness({ notebook: record(PRINCIPAL), cache: record(PRINCIPAL) });
    harness.options.shouldContinue = () => !liveMaterialized;
    harness.options.loadRenderHandle = async () => {
      liveMaterialized = true; // live connect wins during the WASM load
      throw new Error("corrupt runtime-state bytes");
    };

    const resolved = await resolveCloudInstantPaintHandle(harness.options);

    assert.deepEqual(resolved, { handle: null, outcome: "skipped_superseded" });
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

describe("runCloudInstantPaint", () => {
  interface RunHarness {
    calls: string[];
    liveMaterialized: { current: boolean };
    options: CloudInstantPaintRunOptions<string, { cells: string[] }>;
  }

  function createRunHarness(cells: string[] = ["cell-1"]): RunHarness {
    const calls: string[] = [];
    const liveMaterialized = { current: false };
    return {
      calls,
      liveMaterialized,
      options: {
        resolveHandle: async () => {
          calls.push("resolve");
          return { handle: "render-handle", outcome: "painted" as const };
        },
        // The session's freshness flag shape: live materialization flips it.
        isFresh: () => !liveMaterialized.current,
        materialize: async (handle, _shouldContinue) => {
          calls.push(`materialize(${handle})`);
          return { cells };
        },
        acceptMetadata: () => {
          calls.push("acceptMetadata");
        },
        projectWidgets: async () => {
          calls.push("projectWidgets");
        },
        applyPaint: () => {
          calls.push("applyPaint");
        },
        freeHandle: (handle) => {
          calls.push(`free(${handle})`);
        },
      },
    };
  }

  it("runs resolve, materialize, metadata, widgets, apply in order and frees the handle", async () => {
    const harness = createRunHarness();
    const outcome = await runCloudInstantPaint(harness.options);

    assert.equal(outcome, "painted");
    assert.deepEqual(harness.calls, [
      "resolve",
      "materialize(render-handle)",
      "acceptMetadata",
      "projectWidgets",
      "applyPaint",
      "free(render-handle)",
    ]);
  });

  it("a live materialization landing while the handle resolves skips every later step", async () => {
    const harness = createRunHarness();
    harness.options.resolveHandle = async () => {
      harness.calls.push("resolve");
      harness.liveMaterialized.current = true; // live wins during IDB/WASM work
      return { handle: "render-handle", outcome: "painted" as const };
    };

    const outcome = await runCloudInstantPaint(harness.options);

    assert.equal(outcome, "skipped_superseded");
    assert.deepEqual(harness.calls, ["resolve", "free(render-handle)"]);
  });

  it("a live materialization landing mid-materialize means no apply lands", async () => {
    const harness = createRunHarness();
    harness.options.materialize = async () => {
      harness.calls.push("materialize");
      harness.liveMaterialized.current = true; // live wins mid-flight
      return { cells: ["stale-cell"] };
    };

    const outcome = await runCloudInstantPaint(harness.options);

    assert.equal(outcome, "skipped_superseded");
    assert.equal(harness.calls.includes("applyPaint"), false);
    assert.equal(harness.calls.includes("acceptMetadata"), false);
    assert.equal(harness.calls.at(-1), "free(render-handle)");
  });

  it("a live materialization landing during widget projection means no final apply", async () => {
    const harness = createRunHarness();
    harness.options.projectWidgets = async () => {
      harness.calls.push("projectWidgets");
      harness.liveMaterialized.current = true;
    };

    const outcome = await runCloudInstantPaint(harness.options);

    assert.equal(outcome, "skipped_superseded");
    assert.equal(harness.calls.includes("applyPaint"), false);
    assert.equal(harness.calls.at(-1), "free(render-handle)");
  });

  it("an empty persisted snapshot paints nothing and still frees the handle", async () => {
    const harness = createRunHarness([]);
    const outcome = await runCloudInstantPaint(harness.options);

    assert.equal(outcome, "skipped_empty_snapshot");
    assert.equal(harness.calls.includes("applyPaint"), false);
    assert.equal(harness.calls.at(-1), "free(render-handle)");
  });
});

describe("cloudInstantPaintStorageOptions (session storage boundary)", () => {
  function createRecordingAdapter(): StorageAdapter & { records: Map<string, Uint8Array> } {
    const records = new Map<string, Uint8Array>();
    const keyOf = (key: StorageKey) => key.join("/");
    return {
      records,
      load: async (key) => records.get(keyOf(key)),
      save: async (key, data) => {
        records.set(keyOf(key), data);
      },
      remove: async (key) => {
        records.delete(keyOf(key));
      },
      loadRange: async () => [],
      removeRange: async (prefix) => {
        const rangePrefix = `${keyOf(prefix)}/`;
        for (const key of [...records.keys()]) {
          if (key === keyOf(prefix) || key.startsWith(rangePrefix)) {
            records.delete(key);
          }
        }
      },
    };
  }

  it("a corrupt runtime cache clears ONLY the cache record — the seed record survives", async () => {
    // Review C[2]: the unit harness cannot observe a seed clear by
    // construction, so this drives the REAL storage bindings the session
    // spreads (load + clear against real envelope records) and asserts the
    // boundary: load_snapshot rejecting the cache bytes deletes
    // [id, "runtime-state-cache"] and nothing else.
    const adapter = createRecordingAdapter();
    const meta = {
      headsHex: ["aa"],
      savedAt: 1,
      principal: "user:dev:alice",
      schemaVersion: 1 as const,
    };
    await adapter.save(["nb-1", "snapshot"], encodePersistedNotebookDoc(meta, new Uint8Array([1])));
    await adapter.save(
      ["nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT],
      encodePersistedNotebookDoc(meta, new Uint8Array([2])),
    );

    const resolved = await withSilencedWarnings(() =>
      resolveCloudInstantPaintHandle<string>({
        matchesPrincipal: (principal) => principal === "user:dev:alice",
        ...cloudInstantPaintStorageOptions(adapter, "nb-1"),
        loadRenderHandle: async (_notebookBytes, runtimeStateBytes) => {
          if (runtimeStateBytes) {
            throw new Error("corrupt runtime-state bytes");
          }
          return "cells-only-handle";
        },
      }),
    );

    assert.deepEqual(resolved, { handle: "cells-only-handle", outcome: "painted_cells_only" });
    assert.deepEqual([...adapter.records.keys()], ["nb-1/snapshot"]);
  });
});

describe("empty live room displacement", () => {
  it("displaces painted cells only once the handle has caught up to the room", () => {
    // The matcher heuristic's backstop: a (possibly false-positive) paint
    // may block a zero-cell apply only while the bootstrap exchange could
    // still deliver content. Once the room's advertised heads are all
    // applied, zero cells IS the room's truth.
    const painted = { snapshotResolved: true, paintedCellCount: 3 };

    assert.equal(shouldDisplayEmptyLiveNotebook({ ...painted, handleCaughtUp: false }), false);
    assert.equal(shouldDisplayEmptyLiveNotebook({ ...painted, handleCaughtUp: true }), true);
    // Nothing painted: the empty state may always show once resolved.
    assert.equal(
      shouldDisplayEmptyLiveNotebook({
        snapshotResolved: true,
        paintedCellCount: 0,
        handleCaughtUp: false,
      }),
      true,
    );
    // Pinned-snapshot path still resolving: never blank under it.
    assert.equal(
      shouldDisplayEmptyLiveNotebook({
        snapshotResolved: false,
        paintedCellCount: 0,
        handleCaughtUp: true,
      }),
      false,
    );
  });

  it("treats handles without the caught-up export (or a throwing one) as not caught up", () => {
    assert.equal(cloudNotebookHandleCaughtUp({}), false);
    assert.equal(
      cloudNotebookHandleCaughtUp({
        notebook_doc_caught_up: () => {
          throw new Error("freed handle");
        },
      }),
      false,
    );
    assert.equal(cloudNotebookHandleCaughtUp({ notebook_doc_caught_up: () => true }), true);
  });

  // Session wiring pins (the hook cannot run under node). Count-based:
  // BOTH zero-cell checkpoints must route through the displacement policy,
  // the caught-up kick must exist, and the changeset tail must never
  // relabel paint-origin content as live.
  const sessionSource = readFileSync(
    new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
    "utf8",
  );

  it("routes both zero-cell checkpoints through the displacement policy", () => {
    assert.ok(
      (sessionSource.match(/mayShowEmptyLiveNotebook\(liveRuntime\)/g) ?? []).length >= 2,
      "both rawCellCount === 0 checkpoints must consult mayShowEmptyLiveNotebook",
    );
    assert.match(sessionSource, /shouldDisplayEmptyLiveNotebook\(\{/);
  });

  it("kicks one full materialization when the doc first catches up to the room", () => {
    assert.match(
      sessionSource,
      /notebookSyncApplied\$\.subscribe\(\(\) => \{\s*if \(caughtUpMaterializeKicked\) return;\s*if \(!cloudNotebookHandleCaughtUp\(liveRuntime\.handle\)\) return;\s*caughtUpMaterializeKicked = true;\s*materializeLiveCellsSafely\(liveRuntime\);/,
    );
  });

  it("never relabels paint-origin content as live in the changeset tail", () => {
    assert.match(
      sessionSource,
      /if \(paintOriginRef\.current\) \{[\s\S]*?return;\s*\}\s*liveMaterializedRef\.current = true;\s*setStatus\(\{\s*kind: "ready",\s*message: `Rendering \$\{currentCellCount\} cells from the live notebook room\.`/,
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

  it("drives the paint through the tested runner with the real freshness flag", () => {
    // The race-guard SEQUENCING is tested for real in the runCloudInstantPaint
    // suite above; these pin the session's thin wiring into it — the flag
    // definition, both injection points, and the storage-option factory
    // whose clear targets only the cache record.
    assert.match(
      sessionSource,
      /const instantPaintFresh = \(\) => !disposed && !liveMaterializedRef\.current;/,
    );
    assert.match(sessionSource, /isFresh: instantPaintFresh,/);
    assert.match(sessionSource, /shouldContinue: instantPaintFresh,/);
    assert.match(
      sessionSource,
      /\.\.\.cloudInstantPaintStorageOptions\(persistenceAdapter, config\.notebookId\),/,
    );
    assert.match(sessionSource, /freeHandle: \(renderHandle\) => renderHandle\.free\(\),/);
  });
});
