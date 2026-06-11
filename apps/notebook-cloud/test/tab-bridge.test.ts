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
      { kind: "changes", principal: "user:dev:alice", bytes: new Uint8Array([5]) },
    ]);
    harness.bridge.dispose();
  });

  it("applies same-principal peer messages through the engine and drops others", () => {
    const harness = createHarness("user:dev:alice");
    assert.ok(harness.bridge);
    const channel = harness.channel()!;

    channel.onmessage?.({
      data: { kind: "changes", principal: "user:dev:alice", bytes: new Uint8Array([7]) },
    });
    channel.onmessage?.({
      data: { kind: "changes", principal: "user:dev:mallory", bytes: new Uint8Array([8]) },
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
});
