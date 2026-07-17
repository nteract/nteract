import { BehaviorSubject } from "rxjs";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectionStatus, ReconnectGovernorState } from "runtimed";
import { createDesktopConnectionStatusSource } from "../desktop-connection-status";

function createFakeDaemonEvents() {
  const handlers = {
    ready: new Set<() => void>(),
    disconnected: new Set<() => void>(),
    unavailable: new Set<() => void>(),
  };
  return {
    handlers,
    fire(kind: keyof typeof handlers): void {
      for (const handler of [...handlers[kind]]) {
        handler();
      }
    },
    daemonEvents: {
      onReady: (cb: () => void) => {
        handlers.ready.add(cb);
        return () => handlers.ready.delete(cb);
      },
      onDisconnected: (cb: () => void) => {
        handlers.disconnected.add(cb);
        return () => handlers.disconnected.delete(cb);
      },
      onUnavailable: (cb: () => void) => {
        handlers.unavailable.add(cb);
        return () => handlers.unavailable.delete(cb);
      },
    },
  };
}

describe("createDesktopConnectionStatusSource", () => {
  it("walks the daemon lifecycle: connecting, online, reconnecting, online, offline", () => {
    const fake = createFakeDaemonEvents();
    const source = createDesktopConnectionStatusSource(fake.daemonEvents);
    const statuses: ConnectionStatus[] = [];
    source.subscribe((status) => statuses.push(status));

    // daemon:ready (incl. the host facade's cache backfill for late mounts).
    fake.fire("ready");
    // daemon:disconnected — the host auto-reconnects, so this is a
    // transition, not an outage verdict.
    fake.fire("disconnected");
    // daemon restart completes.
    fake.fire("ready");
    // daemon:unavailable is the terminal state.
    fake.fire("unavailable");

    expect(statuses).toEqual(["connecting", "online", "reconnecting", "online", "offline"]);
    expect(source.getCurrent()).toBe("offline");
  });

  it("dedups repeated lifecycle events", () => {
    const fake = createFakeDaemonEvents();
    const source = createDesktopConnectionStatusSource(fake.daemonEvents);
    const statuses: ConnectionStatus[] = [];
    source.subscribe((status) => statuses.push(status));

    fake.fire("ready");
    fake.fire("ready"); // path changes re-emit daemon:ready
    expect(statuses).toEqual(["connecting", "online"]);
  });

  it("replays the current value to subscribers and supports getCurrent", () => {
    const fake = createFakeDaemonEvents();
    const source = createDesktopConnectionStatusSource(fake.daemonEvents);
    fake.fire("ready");

    expect(source.getCurrent()).toBe("online");
    const statuses: ConnectionStatus[] = [];
    source.subscribe((status) => statuses.push(status));
    expect(statuses).toEqual(["online"]);
  });

  it("maps disconnect to offline when the reconnect governor is latched", () => {
    const fake = createFakeDaemonEvents();
    const state$ = new BehaviorSubject<ReconnectGovernorState>({ kind: "idle" });
    const source = createDesktopConnectionStatusSource(fake.daemonEvents, {
      getState: () => state$.getValue(),
      state$,
    });
    const statuses: ConnectionStatus[] = [];
    source.subscribe((status) => statuses.push(status));

    fake.fire("ready");
    // Terminal initial-load failure latches the governor, then the daemon
    // closes the session. Nothing is redialing, so "reconnecting" would lie.
    state$.next({ kind: "latched", reason: "initial load failed" });
    fake.fire("disconnected");

    expect(statuses).toEqual(["connecting", "online", "offline"]);
    expect(source.getCurrent()).toBe("offline");
    source.dispose();
  });

  it("demotes reconnecting to offline when the latch lands after the disconnect", () => {
    const fake = createFakeDaemonEvents();
    const state$ = new BehaviorSubject<ReconnectGovernorState>({ kind: "idle" });
    const source = createDesktopConnectionStatusSource(fake.daemonEvents, {
      getState: () => state$.getValue(),
      state$,
    });
    const statuses: ConnectionStatus[] = [];
    source.subscribe((status) => statuses.push(status));

    fake.fire("ready");
    fake.fire("disconnected");
    expect(source.getCurrent()).toBe("reconnecting");

    state$.next({ kind: "latched", reason: "initial load failed" });
    expect(statuses).toEqual(["connecting", "online", "reconnecting", "offline"]);

    // Manual Retry succeeds: daemon:ready brings the dot back to online.
    state$.next({ kind: "idle" });
    fake.fire("ready");
    expect(source.getCurrent()).toBe("online");
    source.dispose();
  });

  it("dispose detaches the governor state subscription", () => {
    const fake = createFakeDaemonEvents();
    const state$ = new BehaviorSubject<ReconnectGovernorState>({ kind: "idle" });
    const source = createDesktopConnectionStatusSource(fake.daemonEvents, {
      getState: () => state$.getValue(),
      state$,
    });
    source.dispose();
    expect(state$.observed).toBe(false);
  });

  it("unsubscribe and dispose detach cleanly", () => {
    const fake = createFakeDaemonEvents();
    const source = createDesktopConnectionStatusSource(fake.daemonEvents);
    const statuses: ConnectionStatus[] = [];
    const subscription = source.subscribe((status) => statuses.push(status));

    subscription.unsubscribe();
    fake.fire("ready");
    expect(statuses).toEqual(["connecting"]); // late events are inert

    source.dispose();
    expect(fake.handlers.ready.size).toBe(0);
    expect(fake.handlers.disconnected.size).toBe(0);
    expect(fake.handlers.unavailable.size).toBe(0);
  });
});
