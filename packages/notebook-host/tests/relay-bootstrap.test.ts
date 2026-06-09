import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookHandleHost, type HostedNotebookHandle, type NotebookHandleSlot } from "runtimed";
import {
  startRelayBootstrapCoordinator,
  type DaemonReadyPayload,
  type RelayBootstrapCoordinatorOptions,
  type RelayBootstrapTrigger,
  type Unlisten,
} from "../src";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createReadySource() {
  const callbacks: Array<(payload: DaemonReadyPayload) => void> = [];
  const unlisten = vi.fn();
  const onReady = vi.fn((cb: (payload: DaemonReadyPayload) => void): Unlisten => {
    callbacks.push(cb);
    return unlisten;
  });
  return {
    callbacks,
    onReady,
    unlisten,
    emit(payload: DaemonReadyPayload) {
      callbacks.forEach((cb) => cb(payload));
    },
  };
}

function createHostedHandle(): HostedNotebookHandle {
  return {
    free: vi.fn(),
    set_blob_port: vi.fn(),
    set_mime_priority: vi.fn(),
  };
}

function startCoordinator(
  options: Omit<RelayBootstrapCoordinatorOptions, "requiresReadyGeneration"> &
    Partial<Pick<RelayBootstrapCoordinatorOptions, "requiresReadyGeneration">>,
) {
  return startRelayBootstrapCoordinator({
    requiresReadyGeneration: true,
    ...options,
  });
}

describe("startRelayBootstrapCoordinator", () => {
  it("waits for daemon ready before bootstrapping", () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
    });

    expect(ready.onReady).toHaveBeenCalledTimes(1);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(notifyRelayReady).not.toHaveBeenCalled();

    coordinator.stop();
    expect(ready.unlisten).toHaveBeenCalledTimes(1);
  });

  it("bootstraps a synchronously replayed ready payload", async () => {
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: (cb) => {
        cb({ notebook_id: "nb-1", relay_generation: 7 });
        return vi.fn();
      },
      bootstrap,
      notifyRelayReady,
    });

    await flushMicrotasks();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 7 },
    });
    expect(notifyRelayReady).toHaveBeenCalledWith(7);

    coordinator.stop();
  });

  it("prepares the relay channel before bootstrap", async () => {
    const ready = createReadySource();
    const order: string[] = [];
    const prepareRelay = vi.fn(async () => {
      order.push("prepare");
    });
    const bootstrap = vi.fn(async () => {
      order.push("bootstrap");
      return true;
    });
    const notifyRelayReady = vi.fn(async () => {
      order.push("notify");
    });

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      prepareRelay,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 7 });
    await flushMicrotasks();

    expect(prepareRelay).toHaveBeenCalledWith(7);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(notifyRelayReady).toHaveBeenCalledWith(7);
    expect(order).toEqual(["prepare", "bootstrap", "notify"]);

    coordinator.stop();
  });

  it("does not bootstrap when relay preparation fails", async () => {
    const ready = createReadySource();
    const error = new Error("stale frame channel");
    const prepareRelay = vi.fn(async () => {
      throw error;
    });
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});
    const onBootstrapError = vi.fn();

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      prepareRelay,
      bootstrap,
      notifyRelayReady,
      onBootstrapError,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 7 });
    await flushMicrotasks();

    expect(bootstrap).not.toHaveBeenCalled();
    expect(notifyRelayReady).not.toHaveBeenCalled();
    expect(onBootstrapError).toHaveBeenCalledWith(error, {
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 7 },
    });

    coordinator.stop();
  });

  it("applies the daemon actor label before creating the notebook handle", async () => {
    const ready = createReadySource();
    const authoritativeActor = "local:quill/desktop:daemon";
    let actorLabel = "desktop:fallback";
    const handle = createHostedHandle();
    const slot: NotebookHandleSlot = { current: null };
    const createHandle = vi.fn((_actor: string) => handle);
    const handleHost = new NotebookHandleHost({
      actorLabel: () => actorLabel,
      createHandle,
      getBlobPort: vi.fn(() => null),
      publishHandle: vi.fn(),
      slot,
    });
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      beforeBootstrap: (trigger) => {
        actorLabel = trigger.payload.actor_label ?? actorLabel;
      },
      bootstrap: (isCancelled) => handleHost.bootstrap(isCancelled),
      notifyRelayReady,
    });

    ready.emit({
      notebook_id: "nb-1",
      relay_generation: 8,
      actor_label: authoritativeActor,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(createHandle).toHaveBeenCalledWith(authoritativeActor);
    expect(createHandle).not.toHaveBeenCalledWith("desktop:fallback");
    expect(notifyRelayReady).toHaveBeenCalledWith(8);

    coordinator.stop();
  });

  it("acks only the latest ready generation when a newer one supersedes an in-flight bootstrap", async () => {
    const ready = createReadySource();
    const bootstraps: Array<{
      isCancelled: () => boolean;
      trigger: RelayBootstrapTrigger;
      resolve: (value: boolean) => void;
    }> = [];
    const bootstrap = vi.fn((isCancelled: () => boolean, trigger: RelayBootstrapTrigger) => {
      const pending = deferred<boolean>();
      bootstraps.push({ isCancelled, trigger, resolve: pending.resolve });
      return pending.promise;
    });
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 1 });
    ready.emit({ notebook_id: "nb-1", relay_generation: 2 });

    expect(bootstraps).toHaveLength(2);
    expect(bootstraps[0].trigger).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 1 },
    });
    expect(bootstraps[0].isCancelled()).toBe(true);
    expect(bootstraps[1].trigger).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 2 },
    });

    bootstraps[0].resolve(true);
    bootstraps[1].resolve(true);
    await flushMicrotasks();

    expect(notifyRelayReady).toHaveBeenCalledTimes(1);
    expect(notifyRelayReady).toHaveBeenCalledWith(2);

    coordinator.stop();
  });

  it("deduplicates repeated ready payloads for the same relay generation", () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 5 });
    ready.emit({ notebook_id: "nb-1", relay_generation: 5 });

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 5 },
    });

    coordinator.stop();
  });

  it("ignores stale ready payloads after a newer generation has arrived", () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 2 });
    ready.emit({ notebook_id: "nb-1", relay_generation: 1 });

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.calls[0][1]).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 2 },
    });

    coordinator.stop();
  });

  it("does not acknowledge an active relay when ready has no generation", async () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});
    const onMissingGeneration = vi.fn();

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
      onMissingGeneration,
    });

    ready.emit({ notebook_id: "nb-1" });
    await flushMicrotasks();

    expect(onMissingGeneration).toHaveBeenCalledWith({ notebook_id: "nb-1" });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(notifyRelayReady).not.toHaveBeenCalled();

    coordinator.stop();
  });

  it("acknowledges a ready payload without a generation when the host does not require one", async () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});
    const onMissingGeneration = vi.fn();

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      requiresReadyGeneration: false,
      bootstrap,
      notifyRelayReady,
      onMissingGeneration,
    });

    ready.emit({ notebook_id: "nb-1" });
    await flushMicrotasks();

    expect(onMissingGeneration).not.toHaveBeenCalled();
    expect(notifyRelayReady).toHaveBeenCalledTimes(1);
    expect(notifyRelayReady).toHaveBeenCalledWith(undefined);

    coordinator.stop();
  });

  it("bootstraps every repeated generationless ready payload for hosts without a ready gate", async () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      requiresReadyGeneration: false,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1" });
    await flushMicrotasks();
    ready.emit({ notebook_id: "nb-1" });
    await flushMicrotasks();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(notifyRelayReady).toHaveBeenCalledTimes(2);
    expect(notifyRelayReady).toHaveBeenNthCalledWith(1, undefined);
    expect(notifyRelayReady).toHaveBeenNthCalledWith(2, undefined);

    coordinator.stop();
  });

  it("reports before-bootstrap errors and does not acknowledge", async () => {
    const ready = createReadySource();
    const bootstrap = vi.fn(async () => true);
    const notifyRelayReady = vi.fn(async () => {});
    const onBootstrapError = vi.fn();
    const error = new Error("reset failed");

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      beforeBootstrap: () => {
        throw error;
      },
      bootstrap,
      notifyRelayReady,
      onBootstrapError,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 6 });
    await flushMicrotasks();

    expect(bootstrap).not.toHaveBeenCalled();
    expect(notifyRelayReady).not.toHaveBeenCalled();
    expect(onBootstrapError).toHaveBeenCalledWith(error, {
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 6 },
    });

    coordinator.stop();
  });

  it("does not acknowledge when bootstrap fails", async () => {
    const ready = createReadySource();
    const notifyRelayReady = vi.fn(async () => {});
    const onBootstrapError = vi.fn();
    const error = new Error("bootstrap failed");

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap: vi.fn(async () => {
        throw error;
      }),
      notifyRelayReady,
      onBootstrapError,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 3 });
    await flushMicrotasks();

    expect(notifyRelayReady).not.toHaveBeenCalled();
    expect(onBootstrapError).toHaveBeenCalledWith(error, {
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 3 },
    });

    coordinator.stop();
  });

  it("does not acknowledge an in-flight generation after stop", async () => {
    const ready = createReadySource();
    const bootstraps: Array<{
      trigger: RelayBootstrapTrigger;
      resolve: (value: boolean) => void;
    }> = [];
    const bootstrap = vi.fn((_isCancelled: () => boolean, trigger: RelayBootstrapTrigger) => {
      const pending = deferred<boolean>();
      bootstraps.push({ trigger, resolve: pending.resolve });
      return pending.promise;
    });
    const notifyRelayReady = vi.fn(async () => {});

    const coordinator = startCoordinator({
      onReady: ready.onReady,
      bootstrap,
      notifyRelayReady,
    });

    ready.emit({ notebook_id: "nb-1", relay_generation: 4 });
    expect(bootstraps.at(-1)?.trigger).toEqual({
      kind: "ready",
      payload: { notebook_id: "nb-1", relay_generation: 4 },
    });

    coordinator.stop();
    bootstraps.at(-1)?.resolve(true);
    await flushMicrotasks();

    expect(notifyRelayReady).not.toHaveBeenCalled();
    expect(ready.unlisten).toHaveBeenCalledTimes(1);
  });
});
