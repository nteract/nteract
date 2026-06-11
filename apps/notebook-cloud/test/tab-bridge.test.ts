/**
 * createCloudNotebookTabBridge — the cloud gate for the cross-tab bridge.
 * Principal-only gating: anonymous sessions are fully disabled in both
 * directions; signed-in sessions bridge through the engine's
 * applyLocalPeerChanges with deltas from save_since_heads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Subject } from "rxjs";
import type { NotebookTabBridgeChannel } from "runtimed";
import { createCloudNotebookTabBridge } from "../viewer/tab-bridge.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(principal: string) {
  const notebookDocChanged$ = new Subject<void>();
  const applied: Uint8Array[] = [];
  const posted: unknown[] = [];
  let channel: NotebookTabBridgeChannel | null = null;
  const bridge = createCloudNotebookTabBridge({
    notebookId: "nb-1",
    principal,
    engine: {
      notebookDocChanged$,
      applyLocalPeerChanges: (bytes) => {
        applied.push(bytes);
        return true;
      },
    },
    handle: {
      get_heads_hex: () => ["h1"],
      save_since_heads: () => new Uint8Array([5]),
    },
    throttleMs: 1,
    createChannel: (name) => {
      channel = {
        onmessage: null,
        postMessage: (message: unknown) => {
          posted.push(message);
        },
        close: () => {},
      };
      assert.equal(name, "nteract-notebook-nb-1");
      return channel;
    },
  });
  return { bridge, notebookDocChanged$, applied, posted, channel: () => channel };
}

describe("createCloudNotebookTabBridge", () => {
  it("arms nothing for anonymous principals — disabled in both directions", () => {
    const harness = createHarness("anonymous:viewer-session-1");
    assert.equal(harness.bridge, null);
    assert.equal(harness.channel(), null, "no channel is ever opened");
    assert.equal(harness.notebookDocChanged$.observed, false, "no broadcast subscription");
  });

  it("bridges signed-in sessions: broadcasts deltas stamped with the principal", async () => {
    const harness = createHarness("user:dev:alice");
    assert.ok(harness.bridge);

    harness.notebookDocChanged$.next();
    await sleep(20);

    assert.deepEqual(harness.posted, [
      { kind: "changes", v: 1, principal: "user:dev:alice", bytes: new Uint8Array([5]) },
    ]);
    harness.bridge.dispose();
  });

  it("arms nothing when the deployed WASM bundle lacks save_since_heads", () => {
    const notebookDocChanged$ = new Subject<void>();
    let channelOpened = false;
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const bridge = createCloudNotebookTabBridge({
        notebookId: "nb-1",
        principal: "user:dev:alice",
        engine: {
          notebookDocChanged$,
          applyLocalPeerChanges: () => true,
        },
        // An older cached bundle: the export is simply absent.
        handle: { get_heads_hex: () => ["h1"] },
        createChannel: () => {
          channelOpened = true;
          return { onmessage: null, postMessage: () => {}, close: () => {} };
        },
      });
      assert.equal(bridge, null, "stale bundle degrades to single-tab");
      assert.equal(channelOpened, false, "no channel is ever opened");
      assert.equal(notebookDocChanged$.observed, false, "no broadcast subscription");
      assert.equal(warnings.length, 1, "one-time warn, not per-window spam");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("applies same-principal peer messages through the engine and drops others", () => {
    const harness = createHarness("user:dev:alice");
    assert.ok(harness.bridge);
    const channel = harness.channel()!;

    channel.onmessage?.({
      data: { kind: "changes", v: 1, principal: "user:dev:alice", bytes: new Uint8Array([7]) },
    });
    channel.onmessage?.({
      data: { kind: "changes", v: 1, principal: "user:dev:mallory", bytes: new Uint8Array([8]) },
    });

    assert.deepEqual(harness.applied, [new Uint8Array([7])]);
    harness.bridge.dispose();
  });
});

// Session wiring pins (the hook cannot run under node): the bridge arms
// beside persistence on connect AND on every roomReady, and the channel
// closes BEFORE the WASM handle frees so no late peer apply can touch a
// freed handle.
describe("cloud session tab-bridge wiring", () => {
  const sessionSource = readFileSync(
    new URL("../viewer/cloud-viewer-session.ts", import.meta.url),
    "utf8",
  );

  it("arms the bridge wherever persistence arms", () => {
    const armSites = sessionSource.match(
      /armPersistence\(liveRuntime\);\s*\n\s*armTabBridge\(liveRuntime\);/g,
    );
    assert.equal(armSites?.length, 2, "connect + roomReady arm sites");
  });

  it("disposes the bridge before the runtime (and its handle) is disposed", () => {
    const disposeIndex = sessionSource.indexOf("tabBridge?.dispose();");
    const runtimeDisposeIndex = sessionSource.indexOf("disposeCloudSyncRuntime(liveRuntime);");
    assert.ok(disposeIndex !== -1 && runtimeDisposeIndex !== -1);
    assert.ok(disposeIndex < runtimeDisposeIndex, "channel closes before the handle frees");
  });

  it("quarantines the bridge for the session once a sync rejection escalates", () => {
    // The bridge principal is sender-asserted: a hostile same-origin tab
    // can keep feeding room-rejected changes, and without the quarantine
    // the post-escalation bootstrap would re-arm against it forever
    // (teardown -> seed discard -> re-poison loop).
    assert.match(
      sessionSource,
      /tabBridgeQuarantinedRef\.current = true;/,
      "escalation sets the session quarantine flag",
    );
    const armBody = sessionSource.slice(
      sessionSource.indexOf("const armTabBridge"),
      sessionSource.indexOf("const handleConnectionLost"),
    );
    assert.match(
      armBody,
      /if \(tabBridgeQuarantinedRef\.current\) return;/,
      "armTabBridge refuses to re-arm while quarantined",
    );
    // The flag is session-scoped (a ref), not effect-scoped state.
    assert.match(sessionSource, /const tabBridgeQuarantinedRef = useRef\(false\);/);
  });
});
