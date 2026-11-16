import { describe, expect, it, vi } from "vite-plus/test";
import { observeScopedChannelReviewCapability } from "../src/channel-review-capability";
import { subscribeReadyWithBackfill } from "../src/ready-backfill";
import type { DaemonReadyPayload, HostDaemonEvents } from "../src/types";

function harness() {
  let ready!: (p: DaemonReadyPayload) => void;
  let disconnected!: () => void;
  let unavailable!: () => void;
  const stop = vi.fn();
  const events = {
    onReady: (cb) => {
      ready = cb;
      return stop;
    },
    onDisconnected: (cb) => {
      disconnected = cb;
      return stop;
    },
    onUnavailable: (cb) => {
      unavailable = () => cb({} as never);
      return stop;
    },
  } as HostDaemonEvents;
  return {
    events,
    stop,
    ready: (p: DaemonReadyPayload) => ready(p),
    disconnect: () => disconnected(),
    unavailable: () => unavailable(),
  };
}
const supported = (relay_generation: number): DaemonReadyPayload => ({
  relay_generation,
  scoped_channel_review_v1: true,
  connection_scope: "owner",
});

describe("scoped channel capability", () => {
  it("requires explicit UI opt-in", () => {
    const h = harness();
    const changed = vi.fn();
    observeScopedChannelReviewCapability(h.events, false, changed)();
    expect(changed.mock.calls).toEqual([[false]]);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it("invalidates immediately and ignores old epochs after disconnect", () => {
    const h = harness();
    const changed = vi.fn();
    const stop = observeScopedChannelReviewCapability(h.events, true, changed);
    h.ready(supported(1));
    h.disconnect();
    h.ready(supported(1));
    expect(changed.mock.calls).toEqual([[false], [true], [false]]);
    h.ready(supported(2));
    h.unavailable();
    h.ready(supported(1));
    expect(changed.mock.calls.slice(-2)).toEqual([[true], [false]]);
    stop();
    h.ready(supported(3));
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(h.stop).toHaveBeenCalledTimes(3);
  });
  it.each([
    {},
    supported(-1),
    supported(1.5),
    supported(Number.MAX_SAFE_INTEGER + 1),
    { ...supported(1), relay_generation: undefined },
    { ...supported(1), scoped_channel_review_v1: undefined },
    { ...supported(1), connection_scope: "viewer" },
    { ...supported(1), hosted_notebook_url: "https://example.test/n/1" },
  ])("fails closed for unsupported bootstrap %j", (payload) => {
    const h = harness();
    const changed = vi.fn();
    observeScopedChannelReviewCapability(h.events, true, changed);
    h.ready(payload);
    expect(changed).not.toHaveBeenCalledWith(true);
  });
});

describe("ready backfill epoch", () => {
  it.each(["live", "disconnect", "unavailable", "stop"])(
    "ignores cache after %s",
    async (event) => {
      const h = harness();
      const callback = vi.fn();
      let resolve!: (p: DaemonReadyPayload) => void;
      const cached = new Promise<DaemonReadyPayload>((r) => {
        resolve = r;
      });
      const stop = subscribeReadyWithBackfill(
        {
          live: h.events.onReady,
          disconnected: h.events.onDisconnected,
          unavailable: (cb) => h.events.onUnavailable(cb),
          cached: () => cached,
        },
        callback,
      );
      if (event === "live") h.ready(supported(2));
      else if (event === "disconnect") h.disconnect();
      else if (event === "unavailable") h.unavailable();
      else stop();
      resolve(supported(1));
      await Promise.resolve();
      expect(callback.mock.calls).toEqual(event === "live" ? [[supported(2)]] : []);
    },
  );
  it("backfills an unchanged connection", async () => {
    const h = harness();
    const callback = vi.fn();
    subscribeReadyWithBackfill(
      {
        live: h.events.onReady,
        disconnected: h.events.onDisconnected,
        unavailable: (cb) => h.events.onUnavailable(cb),
        cached: async () => supported(1),
      },
      callback,
    );
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(supported(1));
  });
});
