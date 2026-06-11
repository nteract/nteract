/**
 * NotebookTabBridge tests: broadcast cadence and delta basis, principal
 * filtering, malformed-message drops, lifecycle — plus the load-bearing
 * convergence properties against TWO REAL WASM handles wired through two
 * real SyncEngines with no network: offline tabs converge through the
 * channel alone, and the ping-pong chain terminates (a re-broadcast of
 * known changes applies as a no-op and triggers nothing further).
 */

import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotebookHandle } from "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm";
import type { SyncableHandle } from "../src/handle";
import {
  NotebookTabBridge,
  createNotebookTabBridge,
  notebookTabBridgeChannelName,
  type NotebookTabBridgeChannel,
} from "../src/notebook-tab-bridge";
import { SyncEngine } from "../src/sync-engine";
import type { NotebookTransport } from "../src/transport";
import { initWasm } from "./wasm-harness";

// ── In-memory channel bus (deterministic, no realm hops) ─────────────

interface BusChannel extends NotebookTabBridgeChannel {
  readonly name: string;
  readonly posted: unknown[];
  closed: boolean;
}

function createChannelBus() {
  const channels: BusChannel[] = [];
  function createChannel(name: string): BusChannel {
    const channel: BusChannel = {
      name,
      posted: [],
      closed: false,
      onmessage: null,
      postMessage(message: unknown) {
        if (channel.closed) throw new Error("channel closed");
        channel.posted.push(message);
        for (const peer of channels) {
          if (peer === channel || peer.closed || peer.name !== name) continue;
          peer.onmessage?.({ data: message });
        }
      },
      close() {
        channel.closed = true;
      },
    };
    channels.push(channel);
    return channel;
  }
  return { channels, createChannel };
}

const silentLogger = { warn: () => {} };

describe("NotebookTabBridge (unit)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createUnitBridge(
    bus: ReturnType<typeof createChannelBus>,
    overrides: Partial<ConstructorParameters<typeof NotebookTabBridge>[0]> = {},
  ) {
    const changes$ = new Subject<void>();
    const applied: Uint8Array[] = [];
    let heads = ["h1"];
    let delta = new Uint8Array([1]);
    const sinceCalls: string[][] = [];
    const bridge = new NotebookTabBridge({
      notebookId: "nb-1",
      principal: "user:test:alice",
      changes$,
      getHeadsHex: () => heads,
      getChangesSince: (basis) => {
        sinceCalls.push([...basis]);
        return delta;
      },
      applyChanges: (bytes) => {
        applied.push(bytes);
        return true;
      },
      throttleMs: 10,
      logger: silentLogger,
      createChannel: bus.createChannel,
      ...overrides,
    });
    return {
      bridge,
      changes$,
      applied,
      sinceCalls,
      setHeads: (next: string[]) => {
        heads = next;
      },
      setDelta: (bytes: Uint8Array) => {
        delta = bytes;
      },
    };
  }

  it("broadcasts the delta since the last broadcast on the throttled cadence", async () => {
    const bus = createChannelBus();
    const tab = createUnitBridge(bus);

    tab.setHeads(["h2"]);
    tab.setDelta(new Uint8Array([42]));
    tab.changes$.next();
    tab.changes$.next(); // coalesced into one trailing-edge broadcast
    await vi.advanceTimersByTimeAsync(10);

    expect(bus.channels[0]!.posted).toEqual([
      { kind: "changes", v: 1, principal: "user:test:alice", bytes: new Uint8Array([42]) },
    ]);
    // The basis was the heads at construction; the NEXT delta cuts from
    // the heads captured at this broadcast.
    expect(tab.sinceCalls).toEqual([["h1"]]);
    tab.setHeads(["h3"]);
    tab.changes$.next();
    await vi.advanceTimersByTimeAsync(10);
    expect(tab.sinceCalls).toEqual([["h1"], ["h2"]]);
    tab.bridge.dispose();
  });

  it("skips empty deltas (protocol-only no-ops never hit the wire)", async () => {
    const bus = createChannelBus();
    const tab = createUnitBridge(bus);

    tab.setDelta(new Uint8Array(0));
    tab.changes$.next();
    await vi.advanceTimersByTimeAsync(10);

    expect(bus.channels[0]!.posted).toEqual([]);
    tab.bridge.dispose();
  });

  it("applies same-principal messages and drops cross-principal ones", () => {
    const bus = createChannelBus();
    const tab = createUnitBridge(bus);
    const channel = bus.channels[0]!;

    channel.onmessage?.({
      data: { kind: "changes", v: 1, principal: "user:test:alice", bytes: new Uint8Array([7]) },
    });
    channel.onmessage?.({
      data: { kind: "changes", v: 1, principal: "user:test:mallory", bytes: new Uint8Array([8]) },
    });

    expect(tab.applied).toEqual([new Uint8Array([7])]);
    tab.bridge.dispose();
  });

  it("drops malformed and version-mismatched messages without applying", () => {
    const bus = createChannelBus();
    const tab = createUnitBridge(bus);
    const channel = bus.channels[0]!;

    channel.onmessage?.({ data: null });
    channel.onmessage?.({ data: "changes" });
    channel.onmessage?.({ data: { kind: "changes" } });
    channel.onmessage?.({ data: { kind: "changes", v: 1, principal: "user:test:alice" } });
    channel.onmessage?.({
      data: { kind: "changes", v: 1, principal: "user:test:alice", bytes: "not bytes" },
    });
    channel.onmessage?.({ data: { kind: "other", v: 1, principal: "user:test:alice" } });
    // Unversioned and future-versioned messages drop — the negotiation
    // hook for any later payload change.
    channel.onmessage?.({
      data: { kind: "changes", principal: "user:test:alice", bytes: new Uint8Array([7]) },
    });
    channel.onmessage?.({
      data: { kind: "changes", v: 2, principal: "user:test:alice", bytes: new Uint8Array([7]) },
    });

    expect(tab.applied).toEqual([]);
    tab.bridge.dispose();
  });

  it("dispose closes the channel and stops both directions", async () => {
    const bus = createChannelBus();
    const tab = createUnitBridge(bus);
    const channel = bus.channels[0]!;

    tab.bridge.dispose();
    expect(channel.closed).toBe(true);
    expect(channel.onmessage).toBeNull();

    tab.changes$.next();
    await vi.advanceTimersByTimeAsync(50);
    expect(channel.posted).toEqual([]);
  });

  it("createNotebookTabBridge returns null only when no channel implementation exists", () => {
    const bus = createChannelBus();
    const options = {
      notebookId: "nb-1",
      principal: "user:test:alice",
      changes$: new Subject<void>(),
      getHeadsHex: () => [] as string[],
      getChangesSince: () => new Uint8Array(0),
      applyChanges: () => false,
      logger: silentLogger,
    };
    // Node 18+ has a global BroadcastChannel, so the default path works...
    const native = createNotebookTabBridge(options);
    expect(native).not.toBeNull();
    native?.dispose();
    // ...and the injected factory always works.
    const injected = createNotebookTabBridge({ ...options, createChannel: bus.createChannel });
    expect(injected).not.toBeNull();
    injected?.dispose();
  });
});

// ── Two real WASM handles, two engines, no network ───────────────────

describe("NotebookTabBridge offline convergence (real WASM)", () => {
  /** A transport that always fails sends — the offline tab. */
  function offlineTransport(): NotebookTransport {
    return {
      sendFrame: vi.fn(() => Promise.reject(new Error("offline"))),
      onFrame: () => () => undefined,
      request: vi.fn(() => Promise.reject(new Error("offline"))),
      connectionStatus$: new Subject() as never,
    } as unknown as NotebookTransport;
  }

  interface Tab {
    handle: NotebookHandle;
    engine: SyncEngine;
    bridge: NotebookTabBridge;
    broadcasts: () => number;
    dispose: () => void;
  }

  function createTab(
    handle: NotebookHandle,
    principal: string,
    bus: ReturnType<typeof createChannelBus>,
  ): Tab {
    const engine = new SyncEngine({
      getHandle: () => handle as unknown as SyncableHandle,
      transport: offlineTransport(),
      presenceHeartbeat: { intervalMs: 60_000, encode: () => new Uint8Array([0]) },
    });
    engine.start();
    const channelIndexBefore = bus.channels.length;
    const bridge = createNotebookTabBridge({
      notebookId: "nb-bridge",
      principal,
      changes$: engine.notebookDocChanged$,
      getHeadsHex: () => handle.get_heads_hex(),
      getChangesSince: (heads) => handle.save_since_heads(heads),
      applyChanges: (bytes) => engine.applyLocalPeerChanges(bytes),
      throttleMs: 1,
      logger: silentLogger,
      createChannel: bus.createChannel,
    })!;
    const channel = bus.channels[channelIndexBefore]!;
    return {
      handle,
      engine,
      bridge,
      broadcasts: () => channel.posted.length,
      dispose: () => {
        bridge.dispose();
        engine.stop();
        handle.free();
      },
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("two offline tabs converge live through the channel, and the loop terminates", async () => {
    const Handle = await initWasm();
    const bus = createChannelBus();

    // Shared genesis: both tabs opened the same notebook.
    const origin = new Handle("nb-bridge");
    origin.set_actor("user:test:alice/browser:origin");
    origin.add_cell(0, "cell-0", "code");
    origin.update_source("cell-0", "shared = True");
    const genesis = origin.save();
    origin.free();

    const handleA = Handle.load(genesis);
    handleA.set_actor("user:test:alice/browser:tab-a");
    const handleB = Handle.load(genesis);
    handleB.set_actor("user:test:alice/browser:tab-b");

    const tabA = createTab(handleA, "user:test:alice", bus);
    const tabB = createTab(handleB, "user:test:alice", bus);
    try {
      // Tab A edits offline. The flush attempt fails (offline transport)
      // but still fires notebookDocChanged$ — exactly the signal the
      // bridge rides.
      handleA.add_cell(1, "cell-a", "code");
      handleA.update_source("cell-a", "from_tab_a = 1");
      tabA.engine.flush();
      await settle();

      expect(handleB.cell_count()).toBe(2);
      expect(handleB.get_cell_source("cell-a")).toBe("from_tab_a = 1");

      // Tab B edits; A converges the other way.
      handleB.add_cell(2, "cell-b", "markdown");
      handleB.update_source("cell-b", "# from tab b");
      tabB.engine.flush();
      await settle();

      expect(handleA.cell_count()).toBe(3);
      expect(handleA.get_cell_source("cell-b")).toBe("# from tab b");
      expect(handleA.get_heads_hex()).toEqual(handleB.get_heads_hex());

      // Ping-pong termination: B's apply of A's changes re-broadcasts a
      // delta containing them; A applies it as a known-change no-op and
      // must NOT broadcast again. Let several throttle windows elapse and
      // pin that broadcast counts have settled.
      const aBroadcasts = tabA.broadcasts();
      const bBroadcasts = tabB.broadcasts();
      await settle();
      await settle();
      expect(tabA.broadcasts()).toBe(aBroadcasts);
      expect(tabB.broadcasts()).toBe(bBroadcasts);
      expect(handleA.get_heads_hex()).toEqual(handleB.get_heads_hex());
    } finally {
      tabA.dispose();
      tabB.dispose();
    }
  });

  it("applied peer changes reach cellChanges$ — the receiving tab materializes them", async () => {
    const Handle = await initWasm();
    const bus = createChannelBus();

    const origin = new Handle("nb-bridge");
    origin.set_actor("user:test:alice/browser:origin");
    const genesis = origin.save();
    origin.free();

    const handleA = Handle.load(genesis);
    handleA.set_actor("user:test:alice/browser:tab-a");
    const handleB = Handle.load(genesis);
    handleB.set_actor("user:test:alice/browser:tab-b");

    const tabA = createTab(handleA, "user:test:alice", bus);
    const tabB = createTab(handleB, "user:test:alice", bus);
    const changesets: unknown[] = [];
    tabB.engine.cellChanges$.subscribe((cs) => changesets.push(cs));
    try {
      handleA.add_cell(0, "cell-new", "code");
      tabA.engine.flush();
      await settle();

      expect(changesets.length).toBeGreaterThanOrEqual(1);
      expect(handleB.cell_count()).toBe(1);
    } finally {
      tabA.dispose();
      tabB.dispose();
    }
  });

  it("cross-principal tabs never exchange changes", async () => {
    const Handle = await initWasm();
    const bus = createChannelBus();

    const origin = new Handle("nb-bridge");
    origin.set_actor("user:test:alice/browser:origin");
    const genesis = origin.save();
    origin.free();

    const handleA = Handle.load(genesis);
    handleA.set_actor("user:test:alice/browser:tab-a");
    const handleB = Handle.load(genesis);
    handleB.set_actor("user:test:mallory/browser:tab-b");

    const tabA = createTab(handleA, "user:test:alice", bus);
    const tabB = createTab(handleB, "user:test:mallory", bus);
    try {
      handleA.add_cell(0, "cell-a", "code");
      tabA.engine.flush();
      await settle();

      // The broadcast went out, but B dropped it at the principal gate.
      expect(tabA.broadcasts()).toBeGreaterThanOrEqual(1);
      expect(handleB.cell_count()).toBe(0);
    } finally {
      tabA.dispose();
      tabB.dispose();
    }
  });

  it("three tabs: one edit settles at exactly one broadcast per tab (bounded echo)", async () => {
    const Handle = await initWasm();
    const bus = createChannelBus();

    const origin = new Handle("nb-bridge");
    origin.set_actor("user:test:alice/browser:origin");
    const genesis = origin.save();
    origin.free();

    const tabs = ["a", "b", "c"].map((suffix) => {
      const handle = Handle.load(genesis);
      handle.set_actor(`user:test:alice/browser:tab-${suffix}`);
      return createTab(handle, "user:test:alice", bus);
    });
    const [tabA, tabB, tabC] = tabs as [Tab, Tab, Tab];
    try {
      tabA.handle.add_cell(0, "cell-a", "code");
      tabA.handle.update_source("cell-a", "from_tab_a = 1");
      tabA.engine.flush();
      await settle();
      await settle();

      for (const tab of tabs) {
        expect(tab.handle.cell_count()).toBe(1);
        expect(tab.handle.get_heads_hex()).toEqual(tabA.handle.get_heads_hex());
      }

      // The echo bound: A broadcasts the origin; B and C each apply it
      // and re-broadcast once (their deltas include A's change); those
      // echoes apply as known-change no-ops everywhere. One edit ⇒
      // exactly one broadcast per tab, then silence.
      const counts = tabs.map((tab) => tab.broadcasts());
      expect(counts).toEqual([1, 1, 1]);
      await settle();
      await settle();
      expect(tabs.map((tab) => tab.broadcasts())).toEqual(counts);
    } finally {
      for (const tab of tabs) {
        tab.dispose();
      }
    }
  });

  it("the real channel name is per notebook", () => {
    expect(notebookTabBridgeChannelName("nb-7")).toBe("nteract-notebook-nb-7");
  });
});
