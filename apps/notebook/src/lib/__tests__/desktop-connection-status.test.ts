import { describe, expect, it } from "vite-plus/test";
import type { ConnectionStatus } from "runtimed";
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
